
import { NeoObject, PlateSolveMetadata } from "../types";

// Official NASA NeoWs (Near Earth Object Web Service) API
const NASA_API_ROOT = "https://api.nasa.gov/neo/rest/v1/feed";
// Your api.nasa.gov key from .env.local (NASA_API_KEY); NASA's public DEMO_KEY works without one, with lower rate limits.
const NASA_API_KEY: string = (process.env as any).NASA_API_KEY || "DEMO_KEY";

/**
 * Fetches Near-Earth Objects (NEOs) that are close to Earth around a specific date.
 * Uses api.nasa.gov with your registered key (NASA_API_KEY) for higher rate limits, or NASA's public DEMO_KEY.
 * 
 * @param dateStr Date string in YYYY-MM-DD format
 */
export const fetchNearEarthObjects = async (dateStr: string, onLog?: (msg: string) => void): Promise<NeoObject[]> => {
  try {
    if (onLog) onLog(`[NASA NEO] Initializing telemetry with KeyID: ...${NASA_API_KEY.slice(-4)}`);

    // Parse date or default to today
    const dateObj = new Date(dateStr);
    const validDate = isNaN(dateObj.getTime()) ? new Date() : dateObj;
    
    const formatDate = (d: Date) => d.toISOString().split('T')[0];
    const startDate = formatDate(validDate);
    
    // Look ahead 2 days (NeoWs allows max 7 days window)
    const endObj = new Date(validDate.getTime() + (86400000 * 2));
    const endDate = formatDate(endObj);

    if (onLog) onLog(`[NASA NEO] Scanning sector: ${startDate} to ${endDate}`);

    const url = `${NASA_API_ROOT}?start_date=${startDate}&end_date=${endDate}&api_key=${NASA_API_KEY}`;
    
    const response = await fetch(url);

    if (!response.ok) {
        if (response.status === 403) throw new Error("API Key Invalid or Quota Exceeded");
        throw new Error(`NASA API returned ${response.status}`);
    }

    const data = await response.json();
    const neos = data.near_earth_objects;
    
    if (!neos) {
      if (onLog) onLog("[NASA NEO] No data returned from probe.");
      return [];
    }

    const candidates: NeoObject[] = [];

    // NeoWs returns an object with date keys. We need to iterate all of them.
    Object.keys(neos).forEach(dateKey => {
      const dayList = neos[dateKey];
      if (Array.isArray(dayList)) {
        dayList.forEach((neo: any) => {
           // Find close approach data for Earth
           const approach = neo.close_approach_data?.find((ca: any) => ca.orbiting_body === "Earth");
           if (approach) {
             const distAU = parseFloat(approach.miss_distance.astronomical);
             // Client-side filter: Objects within 0.1 AU (~15 million km)
             // This matches the previous logic to find potential transients in the frame
             if (distAU <= 0.1) {
               candidates.push({
                 des: neo.id,
                 fullname: neo.name, // e.g. "(2024 BX1)"
                 cd: approach.close_approach_date_full,
                 dist: distAU.toFixed(6),
                 dist_min: distAU.toFixed(6), // NeoWs standard feed provides nominal. Using same for min.
                 v_rel: parseFloat(approach.relative_velocity.kilometers_per_second).toFixed(2),
                 h: neo.absolute_magnitude_h.toString(),
                 body: 'Earth'
               });
             }
           }
        });
      }
    });

    // Sort by distance (closest first)
    candidates.sort((a, b) => parseFloat(a.dist) - parseFloat(b.dist));

    // Limit to nearest 10 to avoid overwhelming the UI/Context
    const results = candidates.slice(0, 10);

    if (onLog) onLog(`[NASA NEO] Identified ${results.length} active objects within 0.1 AU.`);
    return results;

  } catch (error: any) {
    console.warn("NASA API Error:", error);
    // Log with NEO prefix so we know we are using the new service
    if (onLog) onLog(`[NASA NEO] Telemetry link failed: ${error.message}`);
    return [];
  }
};

const HORIZONS_API_URL = "/proxy/horizons/api/horizons.api";

/**
 * Parse RA in various formats (decimal degrees, or "HH MM SS.sss") to decimal degrees.
 */
const parseRaToDeg = (ra: string): number | null => {
  const trimmed = ra.trim();
  // If it looks like a plain number, it might already be degrees
  const asNum = parseFloat(trimmed);
  if (!isNaN(asNum) && !trimmed.includes(' ')) return asNum;
  // HMS format: "HH MM SS.sss"
  const parts = trimmed.split(/\s+/).map(Number);
  if (parts.length >= 2 && parts.every(p => !isNaN(p))) {
    return (parts[0] + (parts[1] || 0) / 60 + (parts[2] || 0) / 3600) * 15;
  }
  return null;
};

/**
 * Parse Dec in various formats (decimal degrees, or "+DD MM SS.s") to decimal degrees.
 */
const parseDecToDeg = (dec: string): number | null => {
  const trimmed = dec.trim();
  const asNum = parseFloat(trimmed);
  if (!isNaN(asNum) && !trimmed.includes(' ')) return asNum;
  const sign = trimmed.startsWith('-') ? -1 : 1;
  const abs = trimmed.replace(/^[+-]/, '');
  const parts = abs.split(/\s+/).map(Number);
  if (parts.length >= 2 && parts.every(p => !isNaN(p))) {
    return sign * (parts[0] + (parts[1] || 0) / 60 + (parts[2] || 0) / 3600);
  }
  return null;
};

/**
 * Gnomonic projection — same as gemini.ts projectWorldToPixel.
 * Duplicated here to avoid circular imports.
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
  if (denom === 0) return null;
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
 * Enrich NEOs with ephemeris positions from JPL Horizons, then determine
 * which ones fall within the plate-solved field of view.
 * Sets ra, dec, in_field, pixel_x, pixel_y on each NEO.
 */
export const enrichNeosWithEphemeris = async (
  neos: NeoObject[],
  timestamp: string,
  plateSolve: PlateSolveMetadata,
  lat?: number | null,
  lon?: number | null,
  onLog?: (msg: string) => void,
): Promise<NeoObject[]> => {
  if (!neos || neos.length === 0 || plateSolve.wcs_quality === 0) return neos;

  const centerRa = parseRaToDeg(plateSolve.center_ra);
  const centerDec = parseDecToDeg(plateSolve.center_dec);
  if (centerRa === null || centerDec === null) return neos;

  const pixscale = plateSolve.pixscale || parseFloat(plateSolve.plate_scale) || 1;
  const orientation = plateSolve.orientation || 0;
  const imgW = plateSolve.image_width || 1;
  const imgH = plateSolve.image_height || 1;

  if (onLog) onLog(`[NEO TRACK] Resolving ephemeris for ${neos.length} near-Earth objects...`);

  // Format timestamps for Horizons
  let startTime = `${timestamp} 00:00`;
  if (timestamp.includes('T')) {
    startTime = timestamp.replace('T', ' ').slice(0, 16);
  } else if (timestamp.match(/^\d{4}-\d{2}-\d{2}$/)) {
    startTime = `${timestamp} 00:00`;
  }
  const d = new Date(startTime);
  if (isNaN(d.getTime())) return neos;
  const stopTimeStr = new Date(d.getTime() + 60000).toISOString().replace('T', ' ').slice(0, 16);

  let center = "'500'";
  let siteCoord = "";
  if (lat != null && lon != null) {
    center = "'coord@399'";
    siteCoord = `&COORD_TYPE='GEODETIC'&SITE_COORD='${lon},${lat},0'`;
  }

  // Query Horizons SEQUENTIALLY with delays to avoid rate-limiting (503)
  const enriched = [...neos];
  let resolved = 0;
  let rateLimited = false;

  for (const neo of enriched) {
    if (rateLimited) break; // Stop if Horizons is rate-limiting us

    try {
      // Extract designation for Horizons lookup — strip parens from names like "(2026 F06)"
      const designation = neo.fullname.replace(/[()]/g, '').trim();
      const command = `'DES=${designation}'`;

      const params = new URLSearchParams({
        format: 'text',
        COMMAND: command,
        OBJ_DATA: 'NO',
        MAKE_EPHEM: 'YES',
        EPHEM_TYPE: 'OBSERVER',
        CENTER: center,
        START_TIME: `'${startTime}'`,
        STOP_TIME: `'${stopTimeStr}'`,
        STEP_SIZE: "'10 m'",
        QUANTITIES: "'1,9'",
        CSV_FORMAT: 'YES',
      });

      const url = `${HORIZONS_API_URL}?${params.toString()}${siteCoord}`;
      const res = await fetch(url);

      if (res.status === 503 || res.status === 429) {
        if (onLog) onLog(`[NEO TRACK] Horizons rate limit hit — resolved ${resolved}/${enriched.length} before throttle.`);
        rateLimited = true;
        break;
      }
      if (!res.ok) continue;

      const text = await res.text();
      const soeParts = text.split('$$SOE');
      if (soeParts.length < 2) continue;

      const content = soeParts[1].split('$$EOE')[0].trim();
      const row = content.split('\n')[0]?.split(',');
      if (!row || !row[1] || !row[2]) continue;

      const raDeg = parseRaToDeg(row[1].trim());
      const decDeg = parseDecToDeg(row[2].trim());
      if (raDeg === null || decDeg === null) continue;

      neo.ra = raDeg.toFixed(6);
      neo.dec = decDeg.toFixed(6);
      neo.magnitude_v = row[3]?.trim() || undefined;
      resolved++;

      // Project to pixel coordinates and check if in FOV
      const px = projectWorldToPixel(
        raDeg, decDeg, centerRa, centerDec,
        pixscale, orientation, imgW, imgH
      );

      if (px && px.x >= 0 && px.x <= imgW && px.y >= 0 && px.y <= imgH) {
        neo.in_field = true;
        neo.pixel_x = px.x;
        neo.pixel_y = px.y;
      }

      // Delay between requests to avoid Horizons rate limit
      await new Promise(r => setTimeout(r, 500));
    } catch {
      // Silently skip — Horizons may not resolve every designation
    }
  }

  const inFieldCount = enriched.filter(n => n.in_field).length;
  if (onLog) {
    onLog(`[NEO TRACK] Ephemeris resolved for ${resolved}/${enriched.length} NEOs. ${inFieldCount} within field of view.`);
  }

  return enriched;
};
