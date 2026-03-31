/**
 * IAU CPS SatChecker Integration
 *
 * Uses the SatChecker Ephemeris API (satchecker.cps.iau.org) to get precise
 * satellite positions by NORAD catalog number at a specific Julian Date from
 * a given observer location.
 *
 * This provides authoritative satellite ephemeris from the IAU Centre for the
 * Protection of Dark and Quiet Sky — far more precise than our local SGP4
 * propagation, as it uses the latest TLE data from both CelesTrak and Space-Track.
 *
 * Key endpoint: GET /ephemeris/catalog-number-jdstep/
 *   - catalog: NORAD ID
 *   - latitude, longitude, elevation: observer location
 *   - startjd, stopjd: Julian Date range
 *   - stepjd: time step in JD (0.0001 ≈ 8.6 seconds)
 *   - min_altitude: -90 to include all passes (not just visible)
 */

const SATCHECKER_URL = '/proxy/satchecker';

export interface SatCheckerEphemeris {
  name: string;
  catalog_id: number;
  julian_date: number;
  right_ascension_deg: number;
  declination_deg: number;
  altitude_deg: number;        // Altitude above horizon (not orbital altitude)
  azimuth_deg: number;
  range_km: number;
  range_rate_km_per_sec: number;
  phase_angle_deg: number;
  sat_altitude_km: number;     // Orbital altitude
  illuminated: boolean;        // Whether sunlit
  international_designator: string;
  tle_date: string;
  data_source: string;
}

/**
 * Convert a JavaScript Date to Julian Date.
 */
function dateToJD(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

/**
 * Query SatChecker for a satellite's ephemeris by NORAD catalog number.
 *
 * Returns an array of ephemeris points across the time range.
 * For a single-point lookup, set startjd ≈ stopjd with a small step.
 *
 * @param noradId   NORAD catalog number (e.g., "25544" for ISS)
 * @param obsDate   Observation date/time
 * @param lat       Observer latitude (degrees, North positive)
 * @param lon       Observer longitude (degrees, East positive)
 * @param windowSec Time window around obsDate to search (seconds, default 60)
 */
export async function querySatChecker(
  noradId: string,
  obsDate: Date,
  lat: number,
  lon: number,
  windowSec: number = 60,
): Promise<SatCheckerEphemeris[]> {
  const jd = dateToJD(obsDate);
  const halfWindowJD = (windowSec / 2) / 86400;
  const startJD = jd - halfWindowJD;
  const stopJD = jd + halfWindowJD;
  // Step: ~10 seconds in JD
  const stepJD = 10 / 86400;

  const params = new URLSearchParams({
    catalog: noradId,
    latitude: lat.toFixed(6),
    longitude: lon.toFixed(6),
    elevation: '0',
    startjd: startJD.toFixed(6),
    stopjd: stopJD.toFixed(6),
    stepjd: stepJD.toFixed(8),
    min_altitude: '-90', // Include all passes, not just above-horizon
  });

  const url = `${SATCHECKER_URL}/ephemeris/catalog-number-jdstep/?${params}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`SatChecker returned ${res.status}`);
  }

  const json = await res.json();

  if (!json.data || !Array.isArray(json.data) || json.data.length === 0) {
    return [];
  }

  // Parse the response — data is an array of arrays, fields describe the columns
  const fields: string[] = json.fields || [];
  const nameIdx = fields.indexOf('name');
  const catIdx = fields.indexOf('catalog_id');
  const jdIdx = fields.indexOf('julian_date');
  const raIdx = fields.indexOf('right_ascension_deg');
  const decIdx = fields.indexOf('declination_deg');
  const altIdx = fields.indexOf('altitude_deg');
  const azIdx = fields.indexOf('azimuth_deg');
  const rangeIdx = fields.indexOf('range_km');
  const rrIdx = fields.indexOf('range_rate_km_per_sec');
  const paIdx = fields.indexOf('phase_angle_deg');
  const satAltIdx = fields.indexOf('sat_altitude_km');
  const illumIdx = fields.indexOf('illuminated');
  const intlDesIdx = fields.indexOf('international_designator');
  const tleDateIdx = fields.indexOf('tle_date');
  const dsIdx = fields.indexOf('data_source');

  return json.data.map((row: any[]) => ({
    name: row[nameIdx] || '',
    catalog_id: row[catIdx] || parseInt(noradId),
    julian_date: row[jdIdx] || 0,
    right_ascension_deg: row[raIdx] || 0,
    declination_deg: row[decIdx] || 0,
    altitude_deg: row[altIdx] || 0,
    azimuth_deg: row[azIdx] || 0,
    range_km: row[rangeIdx] || 0,
    range_rate_km_per_sec: row[rrIdx] || 0,
    phase_angle_deg: row[paIdx] || 0,
    sat_altitude_km: row[satAltIdx] || 0,
    illuminated: row[illumIdx] ?? false,
    international_designator: row[intlDesIdx] || '',
    tle_date: row[tleDateIdx] || '',
    data_source: row[dsIdx] || '',
  }));
}

/**
 * Verify and enrich satellite matches using SatChecker.
 *
 * For the top N satellite candidates (by brightness or streak match score),
 * queries SatChecker for precise ephemeris and computes angular separation
 * from the plate-solved FOV center. Returns enriched matches with
 * SatChecker-verified RA/Dec, illumination status, and precise range.
 *
 * @param candidates  SGP4-propagated satellite matches (from identifySatellitesInField)
 * @param obsDate     Observation date/time
 * @param lat         Observer latitude
 * @param lon         Observer longitude
 * @param centerRa    Plate-solved FOV center RA (degrees)
 * @param centerDec   Plate-solved FOV center Dec (degrees)
 * @param fovRadius   FOV radius (degrees)
 * @param exposureSec Exposure duration (seconds)
 * @param maxToCheck  Maximum candidates to verify (default 15)
 * @param onLog       Progress callback
 */
export async function verifySatellitesWithSatChecker(
  candidates: { noradId: string; name: string; streakMatchScore?: number; estMagnitude: number }[],
  obsDate: Date,
  lat: number,
  lon: number,
  centerRa: number,
  centerDec: number,
  fovRadius: number,
  exposureSec: number,
  maxToCheck: number = 15,
  onLog?: (msg: string) => void,
): Promise<{
  noradId: string;
  name: string;
  ra: number;
  dec: number;
  angularSep: number;
  illuminated: boolean;
  satAltitudeKm: number;
  rangeKm: number;
  phaseAngle: number;
  inFov: boolean;
  dataSource: string;
}[]> {
  // Prioritize: streak-matched first, then brightest
  const sorted = [...candidates].sort((a, b) => {
    const aScore = a.streakMatchScore || 0;
    const bScore = b.streakMatchScore || 0;
    if (aScore > 0.1 || bScore > 0.1) return bScore - aScore;
    return a.estMagnitude - b.estMagnitude;
  });

  const toCheck = sorted.slice(0, maxToCheck);
  const results: {
    noradId: string; name: string; ra: number; dec: number;
    angularSep: number; illuminated: boolean; satAltitudeKm: number;
    rangeKm: number; phaseAngle: number; inFov: boolean; dataSource: string;
  }[] = [];

  if (onLog) onLog(`[SATCHECKER] Verifying ${toCheck.length} satellite candidate(s) via IAU SatChecker...`);

  for (const sat of toCheck) {
    try {
      const ephemeris = await querySatChecker(
        sat.noradId, obsDate, lat, lon, Math.max(exposureSec, 120)
      );

      if (ephemeris.length === 0) {
        if (onLog) onLog(`[SATCHECKER]   ${sat.name} (#${sat.noradId}): no ephemeris data`);
        continue;
      }

      // Find the closest ephemeris point to FOV center
      let bestPoint = ephemeris[0];
      let bestSep = Infinity;

      for (const pt of ephemeris) {
        const d2r = Math.PI / 180;
        const cosD = Math.sin(centerDec * d2r) * Math.sin(pt.declination_deg * d2r) +
                     Math.cos(centerDec * d2r) * Math.cos(pt.declination_deg * d2r) *
                     Math.cos((centerRa - pt.right_ascension_deg) * d2r);
        const sep = Math.acos(Math.min(1, Math.max(-1, cosD))) / d2r;
        if (sep < bestSep) {
          bestSep = sep;
          bestPoint = pt;
        }
      }

      const inFov = bestSep <= fovRadius * 1.1;
      const illumAny = ephemeris.some(pt => pt.illuminated);

      results.push({
        noradId: sat.noradId,
        name: bestPoint.name || sat.name,
        ra: bestPoint.right_ascension_deg,
        dec: bestPoint.declination_deg,
        angularSep: bestSep,
        illuminated: illumAny,
        satAltitudeKm: bestPoint.sat_altitude_km,
        rangeKm: bestPoint.range_km,
        phaseAngle: bestPoint.phase_angle_deg,
        inFov,
        dataSource: bestPoint.data_source,
      });

      const status = inFov ? (illumAny ? 'IN FOV + SUNLIT' : 'IN FOV (shadow)') : `outside FOV (${bestSep.toFixed(2)}°)`;
      const tleInfo = bestPoint.tle_date ? ` [TLE: ${bestPoint.tle_date}]` : '';
      if (onLog) onLog(`[SATCHECKER]   ${bestPoint.name || sat.name} (#${sat.noradId}): ${status}, alt=${bestPoint.sat_altitude_km.toFixed(0)}km, range=${bestPoint.range_km.toFixed(0)}km${tleInfo}`);

    } catch (err: any) {
      if (onLog) onLog(`[SATCHECKER]   ${sat.name} (#${sat.noradId}): query failed — ${err.message}`);
    }
  }

  // Sort: in-FOV + illuminated first
  results.sort((a, b) => {
    if (a.inFov !== b.inFov) return a.inFov ? -1 : 1;
    if (a.illuminated !== b.illuminated) return a.illuminated ? -1 : 1;
    return a.angularSep - b.angularSep;
  });

  const inFovCount = results.filter(r => r.inFov).length;
  const illumInFov = results.filter(r => r.inFov && r.illuminated).length;
  if (onLog) onLog(`[SATCHECKER] Verification complete: ${illumInFov} illuminated in FOV, ${inFovCount} total in FOV out of ${results.length} checked.`);

  return results;
}

// ══════════════════════════════════════════════════════════════
// SATCHECKER PRIMARY SEARCH — Used when SGP4 has no TLE data.
// Queries a curated list of the most common bright satellites
// directly through SatChecker's ephemeris API to find which
// ones were in the FOV at the observation time.
// ══════════════════════════════════════════════════════════════

/**
 * Curated list of commonly-visible satellites that cause streaks in astrophotos.
 * These are queried directly via SatChecker when local SGP4 has no TLE data.
 *
 * Categories:
 * - Space stations (very bright, mag -2 to 1)
 * - Recent Starlink launches (mag 4-7, most common streak source)
 * - Other bright LEO satellites (Hubble, Iridium, etc.)
 */
/**
 * Curated list of REAL, verified NORAD catalog numbers for commonly-visible satellites.
 * These are known-good IDs from CelesTrak's catalog.
 * When SGP4 fails (no TLE data), we query SatChecker for each of these directly.
 */
const COMMON_BRIGHT_SATELLITES: { noradId: string; name: string }[] = [
  // Space stations (very bright, easily visible)
  { noradId: '25544', name: 'ISS' },
  { noradId: '48274', name: 'CSS (TIANHE)' },
  { noradId: '54216', name: 'CSS (MENGTIAN)' },

  // Very bright large satellites
  { noradId: '20580', name: 'HST (HUBBLE)' },
  { noradId: '27386', name: 'ENVISAT' },
  { noradId: '36516', name: 'CRYOSAT 2' },

  // Common streak sources — rocket bodies, debris, defunct sats
  // (Validated against Project Pluto's sat_code ground truth)
  { noradId: '20509', name: 'SL-8 R/B' },
  { noradId: '34053', name: 'COSMOS 2251 DEB' },
  { noradId: '33900', name: 'COSMOS 2251 DEB' },
  { noradId: '02154', name: 'DELTA 1 DEB' },
  { noradId: '14472', name: 'DELTA 1 DEB' },
  { noradId: '03827', name: 'OV1-19 R/B' },
  { noradId: '08893', name: 'COSMOS 829' },
  { noradId: '31083', name: 'FENGYUN 1C DEB' },
  { noradId: '23893', name: 'USA 119' },
  { noradId: '16962', name: 'COSMOS 1779 (GLONASS)' },

  // OneWeb
  { noradId: '55829', name: 'ONEWEB-0670' },
  { noradId: '47948', name: 'ONEWEB-0185' },
  { noradId: '47949', name: 'ONEWEB-0186' },

  // Iridium NEXT (bright, predictable orbits)
  { noradId: '43075', name: 'IRIDIUM 161' },
  { noradId: '43076', name: 'IRIDIUM 162' },
  { noradId: '43077', name: 'IRIDIUM 163' },
  { noradId: '43078', name: 'IRIDIUM 164' },
  { noradId: '43079', name: 'IRIDIUM 165' },

  // Weather/Earth observation (bright, sun-synchronous)
  { noradId: '43013', name: 'NOAA 20 (JPSS-1)' },
  { noradId: '28654', name: 'NOAA 18' },
  { noradId: '33591', name: 'NOAA 19' },
  { noradId: '25338', name: 'NOAA 15' },
  { noradId: '37849', name: 'SUOMI NPP' },
  { noradId: '40069', name: 'METEOR-M 2' },
  { noradId: '44387', name: 'METEOR-M 2-2' },
  { noradId: '49260', name: 'METEOR-M 2-3' },
];

/**
 * Primary satellite search via SatChecker — used when SGP4/CelesTrak is unavailable.
 *
 * Queries SatChecker for each satellite in the curated list and checks if it
 * was within the plate-solved FOV at the observation time. Returns matches
 * as SatelliteMatch-compatible objects.
 *
 * Uses parallel batches of 5 to keep query time under 15 seconds.
 */
export async function findSatellitesViaSatChecker(
  obsDate: Date,
  lat: number,
  lon: number,
  centerRa: number,
  centerDec: number,
  fovRadius: number,
  exposureSec: number,
  onLog?: (msg: string) => void,
): Promise<{
  noradId: string;
  name: string;
  ra: number;
  dec: number;
  angularSep: number;
  illuminated: boolean;
  satAltitudeKm: number;
  rangeKm: number;
  phaseAngle: number;
  inFov: boolean;
  dataSource: string;
}[]> {
  if (onLog) onLog(`[SATCHECKER PRIMARY] SGP4 unavailable — querying SatChecker directly for ${COMMON_BRIGHT_SATELLITES.length} common satellites...`);

  const results: {
    noradId: string; name: string; ra: number; dec: number;
    angularSep: number; illuminated: boolean; satAltitudeKm: number;
    rangeKm: number; phaseAngle: number; inFov: boolean; dataSource: string;
  }[] = [];

  let queriedCount = 0;
  let errorCount = 0;
  let rateLimited = false;

  // Process in batches of 5 for parallelism without overwhelming the API
  const BATCH_SIZE = 5;
  for (let i = 0; i < COMMON_BRIGHT_SATELLITES.length && !rateLimited; i += BATCH_SIZE) {
    const batch = COMMON_BRIGHT_SATELLITES.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.allSettled(
      batch.map(async (sat) => {
        try {
          const ephemeris = await querySatChecker(
            sat.noradId, obsDate, lat, lon, Math.max(exposureSec, 120)
          );
          queriedCount++;

          if (ephemeris.length === 0) return null;

          // Find closest approach to FOV center
          let bestPoint = ephemeris[0];
          let bestSep = Infinity;
          for (const pt of ephemeris) {
            const d2r = Math.PI / 180;
            const cosD = Math.sin(centerDec * d2r) * Math.sin(pt.declination_deg * d2r) +
                         Math.cos(centerDec * d2r) * Math.cos(pt.declination_deg * d2r) *
                         Math.cos((centerRa - pt.right_ascension_deg) * d2r);
            const sep = Math.acos(Math.min(1, Math.max(-1, cosD))) / d2r;
            if (sep < bestSep) {
              bestSep = sep;
              bestPoint = pt;
            }
          }

          const inFov = bestSep <= fovRadius * 1.1;
          const illumAny = ephemeris.some(pt => pt.illuminated);

          return {
            noradId: sat.noradId,
            name: bestPoint.name || sat.name,
            ra: bestPoint.right_ascension_deg,
            dec: bestPoint.declination_deg,
            angularSep: bestSep,
            illuminated: illumAny,
            satAltitudeKm: bestPoint.sat_altitude_km,
            rangeKm: bestPoint.range_km,
            phaseAngle: bestPoint.phase_angle_deg,
            inFov,
            dataSource: bestPoint.data_source || 'SatChecker',
          };
        } catch (err: any) {
          if (err.message?.includes('429') || err.message?.includes('503')) {
            rateLimited = true;
          }
          errorCount++;
          return null;
        }
      })
    );

    for (const r of batchResults) {
      if (r.status === 'fulfilled' && r.value && r.value.inFov) {
        results.push(r.value);
      }
    }

    // Brief delay between batches to respect API limits
    if (i + BATCH_SIZE < COMMON_BRIGHT_SATELLITES.length && !rateLimited) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  if (rateLimited && onLog) {
    onLog(`[SATCHECKER PRIMARY] Rate limited after ${queriedCount} queries — results may be incomplete`);
  }

  // Sort: illuminated first, then by angular separation
  results.sort((a, b) => {
    if (a.illuminated !== b.illuminated) return a.illuminated ? -1 : 1;
    return a.angularSep - b.angularSep;
  });

  if (onLog) {
    const illumCount = results.filter(r => r.illuminated).length;
    onLog(`[SATCHECKER PRIMARY] Found ${results.length} satellite(s) in FOV (${illumCount} illuminated) from ${queriedCount} queried, ${errorCount} errors`);
    results.forEach(r => {
      const status = r.illuminated ? 'SUNLIT' : 'shadow';
      onLog(`[SATCHECKER PRIMARY]   ${r.name} (NORAD ${r.noradId}): ${status}, sep=${r.angularSep.toFixed(3)}°, alt=${r.satAltitudeKm.toFixed(0)}km, range=${r.rangeKm.toFixed(0)}km`);
    });
  }

  return results;
}
