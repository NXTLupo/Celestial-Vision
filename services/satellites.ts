/**
 * Satellite Trail Identification Service
 *
 * Uses satellite.js (SGP4/SDP4 propagation) + CelesTrak TLE catalog
 * to identify which satellites crossed the plate-solved field of view
 * during the exposure window.
 *
 * Architecture (per Bill Gray's sat_code methodology, adapted to JS):
 *   1. Fetch active satellite TLEs from CelesTrak
 *   2. Propagate each to the observation time via SGP4
 *   3. Convert ECI position to topocentric RA/Dec from observer location
 *   4. Check if predicted position falls within the plate-solved FOV
 *   5. Return matching satellites with metadata
 *
 * Reference: github.com/Bill-Gray/sat_code (C implementation)
 * JS engine: satellite.js (same SGP4/SDP4 algorithms)
 */

import * as satellite from 'satellite.js';
import { PlateSolveMetadata } from '../types';

export interface SatelliteTransitPoint {
  time: Date;
  ra: number;
  dec: number;
  pixelX: number;
  pixelY: number;
}

export interface SatelliteMatch {
  name: string;
  noradId: string;
  intlDesignator: string;
  ra: number;          // Topocentric RA in degrees at observation time
  dec: number;         // Topocentric Dec in degrees at observation time
  altitude: number;    // km above Earth
  velocity: number;    // km/s
  angularSep: number;  // degrees from FOV center
  illuminated: boolean; // Whether satellite is sunlit (visible)
  estMagnitude: number; // Estimated apparent magnitude (lower = brighter)
  pixelX?: number;     // Projected pixel position (midpoint)
  pixelY?: number;     // Projected pixel position (midpoint)
  transitPath?: SatelliteTransitPoint[]; // Full path across FOV
  transitAngleDeg?: number;  // Position angle of transit across image (degrees)
  streakMatchScore?: number; // 0-1 score: how well this matches a detected streak
  bestStreakIdx?: number;    // Index of the best-matching detected streak
}

// CelesTrak TLE endpoint — no auth required, 2-hour cache per dataset
const CELESTRAK_URL = '/proxy/celestrak/NORAD/elements/gp.php';
const CELESTRAK_CORS = 'https://corsproxy.io/?url=' + encodeURIComponent('https://celestrak.org/NORAD/elements/gp.php');

// TLE catalog sources — Bill Gray's sat_code uses the FULL catalog including debris.
// We fetch three CelesTrak groups to approximate full coverage:
//   GROUP=active  — ~14,867 operational satellites
//   NAME=DEB      — ~9,897 debris objects (Cosmos, Fengyun, etc.)
//   NAME=R/B      — ~2,161 rocket bodies
// Total: ~26,925 objects, ~4.5 MB
const TLE_SOURCES = [
  { param: 'GROUP=active', label: 'active satellites' },
  { param: 'NAME=DEB', label: 'debris' },
  { param: 'NAME=R%2FB', label: 'rocket bodies' },  // R/B URL-encoded
];

// TLE cache — persisted to localStorage so it survives page refreshes.
// CelesTrak returns 403 if re-requested within 2 hours, so cache is critical.
let tleCache: { text: string; fetchedAt: number } | null = null;
const TLE_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours
const TLE_STORAGE_KEY = 'celestrak_tle_cache_v2'; // v2: includes debris+R/B

// Restore cache from localStorage on module load — accept stale data.
// Stale TLEs (even days old) are far better than zero TLEs.
// LEO satellite TLEs are only updated every few days anyway.
try {
  const stored = localStorage.getItem(TLE_STORAGE_KEY);
  if (stored) {
    const parsed = JSON.parse(stored);
    if (parsed.text && parsed.fetchedAt) {
      tleCache = parsed;
    }
  }
} catch { /* localStorage unavailable or corrupt — start fresh */ }

/**
 * Convert ECI position to topocentric RA/Dec from an observer location.
 */
const eciToRaDec = (
  positionEci: { x: number; y: number; z: number },
  observerGd: { latitude: number; longitude: number; height: number },
  gmst: number
): { ra: number; dec: number } => {
  // Convert observer to ECI
  const observerEcf = satellite.geodeticToEcf(observerGd);
  const observerEci = satellite.ecfToEci(observerEcf, gmst);

  // Topocentric vector (satellite - observer) in ECI
  const dx = positionEci.x - observerEci.x;
  const dy = positionEci.y - observerEci.y;
  const dz = positionEci.z - observerEci.z;

  // RA/Dec from ECI topocentric vector
  const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const dec = Math.asin(dz / r) * (180 / Math.PI);

  // RA needs to account for Earth rotation (GMST)
  let ra = Math.atan2(dy, dx) * (180 / Math.PI);
  if (ra < 0) ra += 360;

  return { ra, dec };
};

/**
 * Gnomonic projection (same as in nasa.ts / gemini.ts)
 */
const projectWorldToPixel = (
  ra: number, dec: number,
  centerRa: number, centerDec: number,
  scaleArcsecPerPixel: number, orientationDeg: number,
  imgW: number, imgH: number
): { x: number; y: number } | null => {
  const d2r = Math.PI / 180;
  const raR = ra * d2r, decR = dec * d2r;
  const cRaR = centerRa * d2r, cDecR = centerDec * d2r;
  const cosDec = Math.cos(decR), sinDec = Math.sin(decR);
  const cosCDec = Math.cos(cDecR), sinCDec = Math.sin(cDecR);
  const cosRaDiff = Math.cos(raR - cRaR), sinRaDiff = Math.sin(raR - cRaR);
  const denom = sinCDec * sinDec + cosCDec * cosDec * cosRaDiff;
  if (denom <= 0) return null;
  const xi = (cosDec * sinRaDiff) / denom;
  const eta = (cosCDec * sinDec - sinCDec * cosDec * cosRaDiff) / denom;
  const degPerPixel = scaleArcsecPerPixel / 3600;
  let xBase = -(xi / d2r) / degPerPixel;
  let yBase = -(eta / d2r) / degPerPixel;
  const rotRad = orientationDeg * d2r;
  const xRot = xBase * Math.cos(rotRad) - yBase * Math.sin(rotRad);
  const yRot = xBase * Math.sin(rotRad) + yBase * Math.cos(rotRad);
  return { x: imgW / 2 + xRot, y: imgH / 2 + yRot };
};

/**
 * Fetch a single TLE source from CelesTrak (with CORS proxy fallback).
 */
const fetchSingleTLESource = async (
  queryParam: string, label: string, onLog?: (msg: string) => void
): Promise<string> => {
  let res: Response;
  try {
    res = await fetch(`${CELESTRAK_URL}?${queryParam}&FORMAT=TLE`);
  } catch {
    // Vite proxy failed — try corsproxy.io
    res = await fetch(`${CELESTRAK_CORS}&${queryParam}&FORMAT=TLE`);
  }

  if (res.status === 403) {
    // Try corsproxy.io as fallback
    try {
      const fallbackRes = await fetch(`${CELESTRAK_CORS}&${queryParam}&FORMAT=TLE`);
      if (fallbackRes.ok) return await fallbackRes.text();
    } catch { /* both failed */ }
    if (onLog) onLog(`[SAT ID] CelesTrak 403 for ${label} — skipped`);
    return '';
  }
  if (!res.ok) {
    if (onLog) onLog(`[SAT ID] CelesTrak ${res.status} for ${label} — skipped`);
    return '';
  }
  return await res.text();
};

/**
 * Fetch comprehensive TLE catalog from CelesTrak.
 * Downloads active satellites + debris + rocket bodies in parallel.
 * Returns raw TLE text (3-line format: name, line1, line2).
 *
 * Following Bill Gray's sat_code approach: use the FULL catalog
 * including debris and rocket bodies, not just active satellites.
 */
const fetchTLEs = async (group: string = 'active', onLog?: (msg: string) => void): Promise<string> => {
  // Return cached data if fresh enough
  if (tleCache && Date.now() - tleCache.fetchedAt < TLE_CACHE_TTL) {
    const ageMin = ((Date.now() - tleCache.fetchedAt) / 60000).toFixed(0);
    if (onLog) onLog(`[SAT ID] Using cached TLE data (${ageMin}min old, ${(tleCache.text.length / 1024).toFixed(0)}KB)`);
    return tleCache.text;
  }

  if (onLog) onLog(`[SAT ID] Fetching comprehensive TLE catalog (active + debris + rocket bodies)...`);

  // Fetch all three sources in parallel
  const results = await Promise.allSettled(
    TLE_SOURCES.map(src => fetchSingleTLESource(src.param, src.label, onLog))
  );

  const texts: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled' && r.value.length > 100) {
      const count = (r.value.match(/^1 /gm) || []).length;
      if (onLog) onLog(`[SAT ID] ✓ ${TLE_SOURCES[i].label}: ${count} objects`);
      texts.push(r.value);
    } else {
      if (onLog) onLog(`[SAT ID] ⚠ ${TLE_SOURCES[i].label}: failed or empty`);
    }
  }

  if (texts.length === 0) {
    // All sources failed — try cache
    if (tleCache) {
      const ageHrs = ((Date.now() - tleCache.fetchedAt) / 3600000).toFixed(1);
      if (onLog) onLog(`[SAT ID] All CelesTrak sources failed — using cached TLEs (${ageHrs}h old)`);
      return tleCache.text;
    }
    try {
      const stored = localStorage.getItem(TLE_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.text) {
          tleCache = parsed;
          if (onLog) onLog(`[SAT ID] All sources failed — restored from localStorage`);
          return parsed.text;
        }
      }
    } catch { /* localStorage unavailable */ }
    throw new Error('All CelesTrak sources failed and no cached TLE data available.');
  }

  const combinedText = texts.join('\n');
  tleCache = { text: combinedText, fetchedAt: Date.now() };
  if (onLog) onLog(`[SAT ID] Combined catalog: ${(combinedText.length / 1024).toFixed(0)}KB total`);

  // Persist to localStorage
  try {
    localStorage.setItem(TLE_STORAGE_KEY, JSON.stringify(tleCache));
  } catch {
    // localStorage might be too small for ~4.5MB — try saving just active
    if (onLog) onLog(`[SAT ID] ⚠ localStorage full — caching in memory only`);
  }

  return combinedText;
};

/**
 * Parse 3-line TLE format into array of {name, line1, line2}.
 */
const parseTLEText = (text: string): { name: string; line1: string; line2: string }[] => {
  const lines = text.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const tles: { name: string; line1: string; line2: string }[] = [];
  for (let i = 0; i < lines.length - 2; i += 3) {
    if (lines[i + 1]?.startsWith('1 ') && lines[i + 2]?.startsWith('2 ')) {
      tles.push({ name: lines[i], line1: lines[i + 1], line2: lines[i + 2] });
    }
  }
  return tles;
};

/**
 * Compute the Sun's position in ECI coordinates for a given date.
 * Uses a simplified solar position algorithm (accuracy ~1°, sufficient for shadow checks).
 */
const getSunPositionEci = (date: Date): { x: number; y: number; z: number } => {
  // Julian date
  const JD = date.getTime() / 86400000 + 2440587.5;
  const T = (JD - 2451545.0) / 36525.0;

  // Mean anomaly of the Sun (degrees)
  const M = (357.5291 + 35999.0503 * T) % 360;
  const Mrad = M * Math.PI / 180;

  // Ecliptic longitude (degrees)
  const C = 1.9146 * Math.sin(Mrad) + 0.02 * Math.sin(2 * Mrad);
  const lambda = ((280.4665 + 36000.7698 * T) + C) % 360;
  const lambdaRad = lambda * Math.PI / 180;

  // Obliquity of the ecliptic
  const epsilon = (23.4393 - 0.0130 * T) * Math.PI / 180;

  // Sun distance in AU (~1 AU)
  const R_AU = 1.00014 - 0.01671 * Math.cos(Mrad) - 0.00014 * Math.cos(2 * Mrad);
  const R_km = R_AU * 149597870.7;

  // Convert ecliptic to equatorial (ECI)
  const x = R_km * Math.cos(lambdaRad);
  const y = R_km * Math.cos(epsilon) * Math.sin(lambdaRad);
  const z = R_km * Math.sin(epsilon) * Math.sin(lambdaRad);

  return { x, y, z };
};

/**
 * Check if a satellite at ECI position is illuminated by the Sun.
 * A satellite is in Earth's shadow if the Earth blocks sunlight from reaching it.
 * Uses cylindrical shadow approximation (accurate for LEO/MEO).
 */
const isSatelliteIlluminated = (
  satPosEci: { x: number; y: number; z: number },
  sunPosEci: { x: number; y: number; z: number }
): boolean => {
  const EARTH_RADIUS = 6371; // km

  // Vector from satellite to Sun
  const toSunX = sunPosEci.x - satPosEci.x;
  const toSunY = sunPosEci.y - satPosEci.y;
  const toSunZ = sunPosEci.z - satPosEci.z;

  // Vector from satellite to Earth center (origin)
  const toEarthX = -satPosEci.x;
  const toEarthY = -satPosEci.y;
  const toEarthZ = -satPosEci.z;

  // Project Earth center onto Sun direction to find closest approach
  const sunDist = Math.sqrt(toSunX * toSunX + toSunY * toSunY + toSunZ * toSunZ);
  const sunDirX = toSunX / sunDist;
  const sunDirY = toSunY / sunDist;
  const sunDirZ = toSunZ / sunDist;

  const dot = toEarthX * sunDirX + toEarthY * sunDirY + toEarthZ * sunDirZ;

  // If dot < 0, Earth is behind the satellite (away from Sun) — satellite is illuminated
  if (dot < 0) return true;

  // Closest approach distance of the Sun-satellite line to Earth center
  const closestX = satPosEci.x + sunDirX * dot;
  const closestY = satPosEci.y + sunDirY * dot;
  const closestZ = satPosEci.z + sunDirZ * dot;
  const distToEarthCenter = Math.sqrt(closestX * closestX + closestY * closestY + closestZ * closestZ);

  // If closest approach is within Earth's radius, satellite is in shadow
  return distToEarthCenter > EARTH_RADIUS;
};

/**
 * Estimate apparent visual magnitude of a satellite.
 * Uses the standard satellite magnitude formula:
 *   m = M_std - 2.5 * log10(A_eff) + 5 * log10(range_km / 1000)
 *
 * - M_std: standard magnitude at 1000km for a reference Starlink-size satellite (~5.5)
 * - A_eff: effective cross-section (estimated from altitude: LEO sats are ~2-10 m²)
 * - range: distance from observer to satellite in km
 *
 * This is approximate — real magnitude depends on phase angle, attitude, reflectivity.
 * Sufficient for filtering clearly invisible objects.
 */
const estimateApparentMagnitude = (
  altitude: number,     // km above Earth
  range: number,        // km from observer
): number => {
  // Standard magnitude for a ~3m² satellite at 1000km range
  const M_std = 5.5;

  // Range adjustment: +5*log10(range/1000)
  const rangeFactor = 5 * Math.log10(Math.max(range, 100) / 1000);

  return M_std + rangeFactor;
};

import { ImageExposureInfo } from '../types';

/**
 * Parse exposure string into structured info distinguishing stacked vs single.
 *
 * CRITICAL: For stacked images ("300x30s"), a satellite can only leave a trail
 * in a SINGLE sub-frame (30s), not across the full stack (9000s). The stacking
 * process rejects transient features. Use subExposureSec for satellite FOV
 * crossing calculations, not totalExposureSec.
 */
export const parseExposureInfo = (exposure?: string | null): ImageExposureInfo => {
  if (!exposure) return { isStacked: false, subExposureSec: 60, totalExposureSec: 60, frameCount: 1, rawString: 'unknown' };
  const lower = exposure.toLowerCase().trim();

  // "300x30s" or "52x20s" (stacked frames)
  const stackMatch = lower.match(/([\d]+)\s*x\s*([\d.]+)\s*s/);
  if (stackMatch) {
    const frames = parseInt(stackMatch[1]);
    const subSec = parseFloat(stackMatch[2]);
    return { isStacked: true, subExposureSec: subSec, totalExposureSec: frames * subSec, frameCount: frames, rawString: exposure };
  }

  // "24min" or "24 min"
  const minMatch = lower.match(/([\d.]+)\s*min/);
  if (minMatch) {
    const sec = parseFloat(minMatch[1]) * 60;
    return { isStacked: false, subExposureSec: sec, totalExposureSec: sec, frameCount: 1, rawString: exposure };
  }

  // "120s" or "120 sec"
  const secMatch = lower.match(/([\d.]+)\s*s/);
  if (secMatch) {
    const sec = parseFloat(secMatch[1]);
    return { isStacked: false, subExposureSec: sec, totalExposureSec: sec, frameCount: 1, rawString: exposure };
  }

  // "2h" or "2 hours"
  const hourMatch = lower.match(/([\d.]+)\s*h/);
  if (hourMatch) {
    const sec = parseFloat(hourMatch[1]) * 3600;
    return { isStacked: false, subExposureSec: sec, totalExposureSec: sec, frameCount: 1, rawString: exposure };
  }

  return { isStacked: false, subExposureSec: 60, totalExposureSec: 60, frameCount: 1, rawString: exposure };
};

export interface BroadCandidate {
  noradId: string;
  name: string;
  closestSep: number;
  angularMotion: number; // degrees per minute
}

export const identifySatellitesInField = async (
  plateSolve: PlateSolveMetadata,
  timestamp: string,
  observerLat?: number | null,
  observerLon?: number | null,
  onLog?: (msg: string) => void,
  exposureStr?: string | null,
): Promise<{ matches: SatelliteMatch[]; broadCandidates: BroadCandidate[]; sgp4Reliable: boolean; epochMismatchDays: number }> => {
  const emptyResult = { matches: [] as SatelliteMatch[], broadCandidates: [] as BroadCandidate[], sgp4Reliable: false, epochMismatchDays: 0 };
  if (plateSolve.wcs_quality === 0) return emptyResult;

  const centerRa = parseFloat(plateSolve.center_ra.replace(/[°'"]/g, ''));
  const centerDec = parseFloat(plateSolve.center_dec.replace(/[°'"]/g, ''));
  if (isNaN(centerRa) || isNaN(centerDec)) return emptyResult;

  const fovMatch = plateSolve.field_of_view.match(/([\d.]+)/);
  const fovRadius = fovMatch ? parseFloat(fovMatch[1]) : 1;
  const pixscale = plateSolve.pixscale || parseFloat(plateSolve.plate_scale) || 1;
  const orientation = plateSolve.orientation || 0;
  const imgW = plateSolve.image_width || 1;
  const imgH = plateSolve.image_height || 1;

  // Parse observation time
  let obsDate: Date;
  if (timestamp.includes('T')) {
    obsDate = new Date(timestamp);
  } else {
    obsDate = new Date(timestamp + 'T00:00:00Z');
  }
  if (isNaN(obsDate.getTime())) return emptyResult;

  // Observer location (default to geocentric approximation)
  const lat = observerLat ?? 0;
  const lon = observerLon ?? 0;
  const observerGd = {
    latitude: satellite.degreesToRadians(lat),
    longitude: satellite.degreesToRadians(lon),
    height: 0, // sea level
  };

  if (onLog) onLog(`[SAT ID] Fetching comprehensive satellite TLE catalog...`);

  let tleText: string;
  try {
    tleText = await fetchTLEs('active', onLog);
  } catch (err: any) {
    if (onLog) onLog(`[SAT ID] CelesTrak fetch failed: ${err.message}`);
    return emptyResult;
  }

  const tles = parseTLEText(tleText);
  const exposureInfo = parseExposureInfo(exposureStr);
  // CRITICAL: Use sub-frame exposure for satellite crossing calculations.
  // For stacked images ("300x30s"), a satellite trail only appears in ONE
  // sub-frame (30s), not across the full stack (9000s). The stacking process
  // rejects transient features during alignment.
  const exposureSec = exposureInfo.subExposureSec;
  const halfExposure = exposureSec / 2;

  // ═══════════════════════════════════════════════════════
  // TLE EPOCH MISMATCH DETECTION
  //
  // CelesTrak provides CURRENT TLEs (epoch ≈ today). If the observation
  // date is weeks/months in the past, SGP4 propagation is unreliable:
  //   - LEO debris: usable ~3-7 days, garbage beyond ~14 days
  //   - LEO active sats: usable ~14-30 days
  //   - MEO/GEO: usable ~30-90 days
  //
  // When mismatch is large, widen the search radius to compensate for
  // position errors, and flag results as low-confidence.
  //
  // Project Pluto (Bill Gray) uses archived TLEs from the observation
  // epoch — that's why it found 11 objects where we found 0. We don't
  // have access to historical TLEs (would need Space-Track account),
  // so we compensate by widening the search + relying on SatChecker.
  // ═══════════════════════════════════════════════════════
  const tleEpochDaysOld = tleCache ? (obsDate.getTime() - tleCache.fetchedAt) / 86400000 : 0;
  const epochMismatchDays = Math.abs(tleEpochDaysOld);

  let BROAD_RADIUS = 5.0; // Default: Bill Gray uses 4°
  let sgp4Reliable = true;

  if (epochMismatchDays > 7) {
    // TLEs are from a different epoch than the observation.
    // Widen search radius proportionally to the mismatch.
    // ~1°/week of additional error for LEO, less for higher orbits.
    const extraRadius = Math.min(epochMismatchDays / 7, 15); // Cap at 20° total
    BROAD_RADIUS = Math.min(5 + extraRadius, 20);
    sgp4Reliable = false;

    if (onLog) {
      onLog(`⚠ [SAT ID] TLE EPOCH MISMATCH: TLEs are from ~${epochMismatchDays.toFixed(0)} days ${tleEpochDaysOld < 0 ? 'after' : 'before'} the observation. SGP4 positions will be UNRELIABLE for debris/LEO objects.`);
      onLog(`[SAT ID] Widening broad scan to ${BROAD_RADIUS.toFixed(0)}° to compensate. SatChecker verification is CRITICAL for accurate identification.`);
    }
  }

  // ═══════════════════════════════════════════════════════
  // TWO-PASS APPROACH (following Bill Gray's sat_code methodology)
  //
  // Pass 1: BROAD SCAN — propagate ALL TLEs to midpoint time only.
  //   Check if within BROAD_RADIUS. This finds candidates that could
  //   cross the FOV during exposure. ~27,000 propagations = <1 second.
  //
  // Pass 2: DETAILED PATH — for candidates within broad radius,
  //   propagate across entire exposure window with fine sampling
  //   (10s steps). Build transit path, check FOV crossing.
  //   ~100-300 candidates × 144 samples = fast.
  // ═══════════════════════════════════════════════════════

  // Fine sampling for detailed path (Pass 2)
  const step = 10; // 10 seconds — catches fast LEO satellites (5°/min = 0.83°/10s)
  const timeOffsets: number[] = [];
  for (let t = -halfExposure; t <= halfExposure; t += step) {
    timeOffsets.push(t);
  }
  if (!timeOffsets.includes(0)) timeOffsets.push(0);

  if (onLog) {
    onLog(`[SAT ID] Loaded ${tles.length} objects (active + debris + rocket bodies). Two-pass scan: broad ${BROAD_RADIUS}° → FOV ${fovRadius.toFixed(2)}°, ${timeOffsets.length} time samples...`);
  }

  const allMatches: SatelliteMatch[] = [];

  // Precompute Sun position for the observation midpoint
  const sunEci = getSunPositionEci(obsDate);

  // Diagnostic counters
  let satrecFailCount = 0;
  let pass1PropFail = 0;
  const closestSats: { name: string; noradId: string; sep: number; ra: number; dec: number; motion: number }[] = [];

  // ═══════════════════════════════════════════════════════
  // PASS 1: BROAD SCAN — propagate ALL TLEs to MIDPOINT only
  //   Check if within BROAD_RADIUS at any sample across exposure.
  //   For efficiency: check midpoint first, then only check more
  //   time samples for LEO objects (which move fast enough to
  //   potentially cross the FOV during the exposure).
  // ═══════════════════════════════════════════════════════
  interface Pass1Candidate {
    tle: { name: string; line1: string; line2: string };
    noradId: string;
    intlDes: string;
    closestSep: number;
    closestRa: number;
    closestDec: number;
    angularMotion: number; // degrees per minute
  }

  const candidates: Pass1Candidate[] = [];
  const gmstMid = satellite.gstime(obsDate);

  // Sample a few time points for the broad scan
  // Midpoint + endpoints to catch fast-movers
  const broadSamples = [0, -halfExposure, halfExposure, -halfExposure / 2, halfExposure / 2];

  if (onLog) onLog(`[SAT ID] Pass 1: Broad scan of ${tles.length} objects within ${BROAD_RADIUS}°...`);

  for (const tle of tles) {
    try {
      const satrec = satellite.twoline2satrec(tle.line1, tle.line2);
      if (satrec.error && satrec.error !== 0) {
        satrecFailCount++;
        continue;
      }
      const noradId = tle.line1.substring(2, 7).trim();
      const intlDes = tle.line1.substring(9, 17).trim();

      let closestSep = Infinity;
      let closestRa = 0, closestDec = 0;
      let angularMotion = 0;

      for (const offsetSec of broadSamples) {
        const checkTime = new Date(obsDate.getTime() + offsetSec * 1000);
        const posVel = satellite.propagate(satrec, checkTime);
        if (!posVel.position || typeof posVel.position === 'boolean') {
          pass1PropFail++;
          continue;
        }

        const posEci = posVel.position as { x: number; y: number; z: number };
        const { ra, dec } = eciToRaDec(posEci, observerGd, satellite.gstime(checkTime));

        const cosDec1 = Math.cos(centerDec * Math.PI / 180);
        const dRa = (ra - centerRa) * cosDec1;
        const dDec = dec - centerDec;
        const angSep = Math.sqrt(dRa * dRa + dDec * dDec);

        if (angSep < closestSep) {
          closestSep = angSep;
          closestRa = ra;
          closestDec = dec;
        }

        // Compute angular motion from velocity (for LEO objects this is ~4-8°/min)
        if (offsetSec === 0 && posVel.velocity && typeof posVel.velocity !== 'boolean') {
          const velEci = posVel.velocity as { x: number; y: number; z: number };
          const r = Math.sqrt(posEci.x ** 2 + posEci.y ** 2 + posEci.z ** 2);
          const vMag = Math.sqrt(velEci.x ** 2 + velEci.y ** 2 + velEci.z ** 2);
          // Angular velocity ≈ transverse velocity / range (radians/sec → degrees/min)
          const obsEcf = satellite.geodeticToEcf(observerGd);
          const obsEci = satellite.ecfToEci(obsEcf, gmstMid);
          const range = Math.sqrt(
            (posEci.x - obsEci.x) ** 2 + (posEci.y - obsEci.y) ** 2 + (posEci.z - obsEci.z) ** 2
          );
          angularMotion = (vMag / range) * (180 / Math.PI) * 60; // deg/min
        }
      }

      // Track top 10 closest for diagnostics
      if (closestSep < Infinity) {
        if (closestSats.length < 10 || closestSep < closestSats[closestSats.length - 1].sep) {
          closestSats.push({ name: tle.name.trim(), noradId, sep: closestSep, ra: closestRa, dec: closestDec, motion: angularMotion });
          closestSats.sort((a, b) => a.sep - b.sep);
          if (closestSats.length > 10) closestSats.pop();
        }
      }

      if (closestSep <= BROAD_RADIUS) {
        candidates.push({ tle, noradId, intlDes, closestSep, closestRa, closestDec, angularMotion });
      }
    } catch {
      satrecFailCount++;
    }
  }

  if (onLog) {
    onLog(`[SAT ID] Pass 1 complete: ${candidates.length} candidates within ${BROAD_RADIUS}° (${satrecFailCount} TLE parse errors, ${pass1PropFail} prop failures)`);
  }

  // ═══════════════════════════════════════════════════════
  // PASS 2: DETAILED PATH — for each candidate, propagate
  //   across the full exposure window with fine sampling.
  //   Build transit paths and check FOV crossing.
  // ═══════════════════════════════════════════════════════
  if (onLog && candidates.length > 0) {
    onLog(`[SAT ID] Pass 2: Computing detailed paths for ${candidates.length} candidates (${timeOffsets.length} time samples each)...`);
  }

  for (const cand of candidates) {
    try {
      const satrec = satellite.twoline2satrec(cand.tle.line1, cand.tle.line2);

      const transitPoints: SatelliteTransitPoint[] = [];
      let bestAlt = 0, bestVel = 0, bestRange = 0, bestAngSep = Infinity;
      let illuminated = false;

      for (const offsetSec of timeOffsets) {
        const checkTime = new Date(obsDate.getTime() + offsetSec * 1000);
        const posVel = satellite.propagate(satrec, checkTime);
        if (!posVel.position || typeof posVel.position === 'boolean') continue;

        const posEci = posVel.position as { x: number; y: number; z: number };
        const velEci = posVel.velocity as { x: number; y: number; z: number };

        const { ra, dec } = eciToRaDec(posEci, observerGd, satellite.gstime(checkTime));

        const cosDec1 = Math.cos(centerDec * Math.PI / 180);
        const dRa = (ra - centerRa) * cosDec1;
        const dDec = dec - centerDec;
        const angSep = Math.sqrt(dRa * dRa + dDec * dDec);

        // Collect points within the FOV (with 10% margin)
        if (angSep <= fovRadius * 1.1) {
          const px = projectWorldToPixel(ra, dec, centerRa, centerDec, pixscale, orientation, imgW, imgH);
          if (px) {
            transitPoints.push({ time: checkTime, ra, dec, pixelX: px.x, pixelY: px.y });
          }

          if (angSep < bestAngSep) {
            bestAngSep = angSep;
            const r = Math.sqrt(posEci.x ** 2 + posEci.y ** 2 + posEci.z ** 2);
            bestAlt = r - 6371;
            bestVel = Math.sqrt(velEci.x ** 2 + velEci.y ** 2 + velEci.z ** 2);

            const obsEcf = satellite.geodeticToEcf(observerGd);
            const obsEci = satellite.ecfToEci(obsEcf, satellite.gstime(checkTime));
            bestRange = Math.sqrt(
              (posEci.x - obsEci.x) ** 2 + (posEci.y - obsEci.y) ** 2 + (posEci.z - obsEci.z) ** 2
            );

            if (!illuminated) {
              illuminated = isSatelliteIlluminated(posEci, sunEci);
            }
          }
        }
      }

      if (transitPoints.length === 0) continue;

      const estMag = estimateApparentMagnitude(bestAlt, bestRange);

      // Compute transit angle from first → last point in the path
      let transitAngle: number | undefined;
      if (transitPoints.length >= 2) {
        const first = transitPoints[0];
        const last = transitPoints[transitPoints.length - 1];
        const dx = last.pixelX - first.pixelX;
        const dy = last.pixelY - first.pixelY;
        transitAngle = Math.atan2(dy, dx) * (180 / Math.PI);
      }

      // Midpoint for display
      const midIdx = Math.floor(transitPoints.length / 2);
      const midPt = transitPoints[midIdx];

      allMatches.push({
        name: cand.tle.name.trim(),
        noradId: cand.noradId,
        intlDesignator: cand.intlDes,
        ra: midPt.ra,
        dec: midPt.dec,
        altitude: bestAlt,
        velocity: bestVel,
        angularSep: bestAngSep,
        illuminated,
        estMagnitude: estMag,
        pixelX: midPt.pixelX,
        pixelY: midPt.pixelY,
        transitPath: transitPoints,
        transitAngleDeg: transitAngle,
      });
    } catch {
      // Skip malformed TLEs
    }
  }

  // Sort: illuminated first, then by brightness
  allMatches.sort((a, b) => {
    if (a.illuminated !== b.illuminated) return a.illuminated ? -1 : 1;
    return a.estMagnitude - b.estMagnitude;
  });

  const illuminatedCount = allMatches.filter(m => m.illuminated).length;
  if (onLog) {
    // Diagnostic summary
    onLog(`[SAT ID] Catalog: ${tles.length} objects total, ${satrecFailCount} TLE parse errors`);
    onLog(`[SAT ID] FOV: center RA=${centerRa.toFixed(4)}° Dec=${centerDec.toFixed(4)}°, radius=${fovRadius.toFixed(2)}°`);
    onLog(`[SAT ID] Observer: lat=${lat.toFixed(4)}° lon=${lon.toFixed(4)}°, obsTime=${obsDate.toISOString()} (UTC: ${obsDate.toUTCString()})`);
    onLog(`[SAT ID] Pass 1: ${candidates.length} objects within ${BROAD_RADIUS}° broad radius`);
    onLog(`[SAT ID] Pass 2: ${allMatches.length} objects crossed through FOV (${fovRadius.toFixed(2)}° radius)`);

    // Always show nearest objects for diagnostics
    if (closestSats.length > 0) {
      onLog(`[SAT ID] TOP 10 NEAREST OBJECTS to FOV center:`);
      closestSats.forEach(s => {
        const inFov = s.sep <= fovRadius * 1.1 ? '✓ IN FOV' : '';
        onLog(`[SAT ID]   ${s.name} (NORAD ${s.noradId}): ${s.sep.toFixed(2)}° from center, ${s.motion.toFixed(1)}°/min (RA=${s.ra.toFixed(2)}° Dec=${s.dec.toFixed(2)}°) ${inFov}`);
      });
    }

    onLog(`[SAT ID] SGP4 propagation complete. ${allMatches.length} satellite(s) crossed field (${illuminatedCount} sunlit). Awaiting streak correlation...`);
    allMatches.slice(0, 10).forEach(m => {
      const pathLen = m.transitPath?.length || 0;
      const angle = m.transitAngleDeg !== undefined ? ` angle=${m.transitAngleDeg.toFixed(1)}°` : '';
      const illum = m.illuminated ? 'SUNLIT' : 'shadow';
      onLog(`[SAT ID]   ${m.name} (NORAD ${m.noradId}): ${illum}, alt=${m.altitude.toFixed(0)}km, mag~${m.estMagnitude.toFixed(1)}, ${pathLen} path pts${angle}`);
    });
  }

  // Return both FOV-crossing matches AND the broader Pass 1 candidates.
  // The broad candidates let SatChecker verify objects that SGP4 placed
  // near (but not in) the FOV — SGP4 positions for old debris can be
  // several degrees off, so SatChecker may find the object is actually
  // closer (or farther) than SGP4 computed.
  // When TLEs are stale, send MORE candidates to SatChecker
  // because SGP4 positions are unreliable
  const broadCandidateLimit = sgp4Reliable ? 30 : Math.min(candidates.length, 100);
  const broadCandidateList: BroadCandidate[] = candidates
    .sort((a, b) => a.closestSep - b.closestSep)
    .slice(0, broadCandidateLimit)
    .map(c => ({
      noradId: c.noradId,
      name: c.tle.name.trim(),
      closestSep: c.closestSep,
      angularMotion: c.angularMotion,
    }));

  return {
    matches: allMatches,
    broadCandidates: broadCandidateList,
    sgp4Reliable,
    epochMismatchDays,
  };
};

/**
 * Match detected streaks against satellite transit paths.
 *
 * For each streak (from Gemini detectStreaks), computes a geometric match score
 * against each satellite candidate's predicted transit path:
 *   - Angle agreement: streak angle vs satellite transit angle (weighted 60%)
 *   - Position agreement: perpendicular distance from streak midpoint to transit line (weighted 40%)
 *
 * Mutates the satelliteMatches array, setting streakMatchScore and bestStreakIdx.
 * Returns the matches sorted by best match score (best first).
 */
export const matchStreaksToSatellites = (
  satelliteMatches: SatelliteMatch[],
  detectedStreaks: { pixel_start_x: number; pixel_start_y: number; pixel_end_x: number; pixel_end_y: number }[],
  onLog?: (msg: string) => void,
): SatelliteMatch[] => {
  if (!detectedStreaks || detectedStreaks.length === 0 || satelliteMatches.length === 0) {
    return satelliteMatches;
  }

  // Compute each streak's angle and midpoint
  const streakGeometry = detectedStreaks.map(s => {
    const dx = s.pixel_end_x - s.pixel_start_x;
    const dy = s.pixel_end_y - s.pixel_start_y;
    const angle = Math.atan2(dy, dx) * (180 / Math.PI); // -180 to 180
    const midX = (s.pixel_start_x + s.pixel_end_x) / 2;
    const midY = (s.pixel_start_y + s.pixel_end_y) / 2;
    const length = Math.sqrt(dx * dx + dy * dy);
    return { angle, midX, midY, length, startX: s.pixel_start_x, startY: s.pixel_start_y, endX: s.pixel_end_x, endY: s.pixel_end_y };
  });

  for (const sat of satelliteMatches) {
    if (sat.transitAngleDeg === undefined || !sat.transitPath || sat.transitPath.length < 2) {
      continue;
    }

    let bestScore = 0;
    let bestIdx = -1;

    for (let si = 0; si < streakGeometry.length; si++) {
      const streak = streakGeometry[si];

      // 1. Angle agreement (0-1): how well do the angles match?
      // Streaks and transits are lines — 180° ambiguity (a line at 30° is the same as 210°)
      let angleDiff = Math.abs(sat.transitAngleDeg - streak.angle);
      if (angleDiff > 180) angleDiff = 360 - angleDiff;
      if (angleDiff > 90) angleDiff = 180 - angleDiff; // Line symmetry
      const angleScore = Math.max(0, 1 - angleDiff / 30); // 0° diff = 1.0, 30° diff = 0.0

      // 2. Position agreement (0-1): perpendicular distance from streak midpoint to transit line
      const first = sat.transitPath[0];
      const last = sat.transitPath[sat.transitPath.length - 1];
      const tDx = last.pixelX - first.pixelX;
      const tDy = last.pixelY - first.pixelY;
      const tLen = Math.sqrt(tDx * tDx + tDy * tDy);

      let posScore = 0;
      if (tLen > 0) {
        // Perpendicular distance from streak midpoint to the satellite transit line
        const perpDist = Math.abs(
          tDx * (first.pixelY - streak.midY) - tDy * (first.pixelX - streak.midX)
        ) / tLen;

        // Score: 0px distance = 1.0, 100px = 0.0
        posScore = Math.max(0, 1 - perpDist / 100);
      }

      // Combined score: angle 60%, position 40%
      // BUT: require minimum angle agreement — a satellite moving at the
      // wrong angle cannot be the source of this streak regardless of position.
      const score = angleScore >= 0.5 ? (angleScore * 0.6 + posScore * 0.4) : 0;

      if (score > bestScore) {
        bestScore = score;
        bestIdx = si;
      }
    }

    sat.streakMatchScore = bestScore;
    sat.bestStreakIdx = bestIdx >= 0 ? bestIdx : undefined;
  }

  // Re-sort: matched satellites first (by score desc), then unmatched (by magnitude)
  satelliteMatches.sort((a, b) => {
    const aScore = a.streakMatchScore || 0;
    const bScore = b.streakMatchScore || 0;
    if (aScore > 0.5 || bScore > 0.5) {
      return bScore - aScore; // Best match first
    }
    return a.estMagnitude - b.estMagnitude; // Brightest first for unmatched
  });

  if (onLog) {
    const matched = satelliteMatches.filter(m => (m.streakMatchScore || 0) > 0.5);
    if (matched.length > 0) {
      onLog(`[SAT MATCH] Matched ${matched.length} satellite(s) to detected streaks:`);
      matched.forEach(m => {
        onLog(`[SAT MATCH]   ${m.name} (NORAD ${m.noradId}): score=${(m.streakMatchScore! * 100).toFixed(0)}%, angle=${m.transitAngleDeg?.toFixed(1)}°`);
      });
    }
  }

  return satelliteMatches;
};
