
import { HorizonsData } from "../types";

// CORS Proxy is needed for browser-based fetch to JPL
const PROXY_URL = "https://corsproxy.io/?";
const HORIZONS_API_URL = "https://ssd.jpl.nasa.gov/api/horizons.api";

export const fetchHorizonsEphemeris = async (
  target: string, 
  timestamp: string,
  lat?: number | null,
  lon?: number | null,
  onLog?: (msg: string) => void
): Promise<HorizonsData | null> => {
  if (!target) return null;

  try {
    if (onLog) onLog(`[HORIZONS] Calculating precise ephemeris for '${target}'...`);

    // Format time: YYYY-MM-DD HH:MM
    let startTime = `${timestamp} 00:00`;
    if (timestamp.includes('T')) {
        startTime = timestamp.replace('T', ' ').slice(0, 16);
    } else if (timestamp.match(/^\d{4}-\d{2}-\d{2}$/)) {
        // If just date, assume midnight UTC
        startTime = `${timestamp} 00:00`;
    }

    // Stop time = Start + 1 minute (we just need one point)
    const d = new Date(startTime);
    if (isNaN(d.getTime())) {
        if (onLog) onLog("[HORIZONS] Invalid date format. Aborting.");
        return null;
    }
    const stopTimeStr = new Date(d.getTime() + 60000).toISOString().replace('T', ' ').slice(0, 16);

    // Setup Location
    let center = "'500'"; // Geocentric default
    let siteCoord = "";
    if (lat !== undefined && lon !== undefined && lat !== null && lon !== null) {
        center = "'coord@399'";
        // JPL format: 'lon,lat,alt' (Geodetic)
        siteCoord = `&COORD_TYPE='GEODETIC'&SITE_COORD='${lon},${lat},0'`;
        if (onLog) onLog(`[HORIZONS] Using observer location: ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
    }

    // Sanitize Target for COMMAND
    // Remove 'CAP' strictness to allow flexible matching for things like '3I'
    const command = `'DES=${target}'`; 

    // Quantities: 1(RA/Dec), 9(Mag), 20(Observer Range/RangeRate)
    const quantities = "'1,9,20'";

    const params = new URLSearchParams({
        format: 'text',
        COMMAND: command,
        OBJ_DATA: 'NO', // Less noise
        MAKE_EPHEM: 'YES',
        EPHEM_TYPE: 'OBSERVER',
        CENTER: center,
        START_TIME: `'${startTime}'`,
        STOP_TIME: `'${stopTimeStr}'`,
        STEP_SIZE: "'10 m'",
        QUANTITIES: quantities,
        CSV_FORMAT: 'YES'
    });

    // Manually construct URL to ensure proper encoding of nested quotes
    const query = params.toString() + siteCoord;
    const url = `${PROXY_URL}${encodeURIComponent(`${HORIZONS_API_URL}?${query}`)}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const text = await res.text();

    // Check for "Ambiguous" or "No matches"
    if (text.includes("Matching small-bodies:") && text.includes("No matches found")) {
        if (onLog) onLog(`[HORIZONS] Target '${target}' not found or ambiguous.`);
        return null;
    }

    // Parse CSV Result
    // The data is sandwiched between $$SOE and $$EOE
    const soeParts = text.split('$$SOE');
    if (soeParts.length < 2) {
        // Fallback check: Did it return a list of multiple candidates?
        // We log it but return null, letting Gemini use Google Search as backup.
        if (onLog) onLog("[HORIZONS] Ambiguous target. Using Search Fallback.");
        return null;
    }
    
    const content = soeParts[1].split('$$EOE')[0].trim();
    const lines = content.split('\n');
    if (lines.length === 0) return null;

    const row = lines[0].split(',');
    
    // Check if we got valid data or if it failed silently
    if (!row[1] || !row[2]) return null;

    const data: HorizonsData = {
        id: target,
        timestamp: row[0]?.trim(),
        ra: row[1]?.trim(),
        dec: row[2]?.trim(),
        magnitude: row[3]?.trim(),
        distance_au: row[5]?.trim(),
        velocity_kms: row[6]?.trim()
    };
    
    if (onLog) onLog(`[HORIZONS] Ephemeris Lock: RA ${data.ra}, Dec ${data.dec}, Mag ${data.magnitude}`);

    return data;

  } catch (err: any) {
    if (onLog) onLog(`[HORIZONS] System Error: ${err.message}`);
    return null;
  }
};
