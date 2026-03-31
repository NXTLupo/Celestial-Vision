
import { HorizonsData } from "../types";

const HORIZONS_API_URL = "/proxy/horizons/api/horizons.api";

export const fetchHorizonsEphemeris = async (
  target: string,
  timestamp: string,
  lat?: number | null,
  lon?: number | null,
  onLog?: (msg: string) => void,
  useRawCommand?: boolean
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
    const command = useRawCommand ? `'${target}'` : `'DES=${target}'`;

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
    const url = `${HORIZONS_API_URL}?${query}`;

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

    if (onLog) onLog(`[HORIZONS] Raw CSV row (${row.length} columns): ${lines[0].substring(0, 200)}`);

    // Horizons CSV column layout depends on QUANTITIES requested.
    // QUANTITIES='1,9,20' produces:
    //   Col 0: Date (JDUT or Calendar)
    //   Col 1: (blank or space)
    //   Col 2: RA (sexagesimal HH MM SS.ff)
    //   Col 3: Dec (sexagesimal sDD MM SS.f)
    //   Col 4: (blank)
    //   Col 5: Mag (V/T)
    //   Col 6: S-brt
    //   Col 7: (blank)
    //   Col 8: delta (AU)
    //   Col 9: deldot (km/s)
    //
    // But some targets produce different column counts.
    // Try to find RA by looking for HH MM SS pattern in the row.

    let ra = '';
    let dec = '';
    let magnitude = '';
    let distAu = '';
    let velocity = '';

    // Strategy: find columns containing sexagesimal coordinates
    // RA pattern: "HH MM SS.ff" (all positive, 0-23 hours)
    // Dec pattern: "sDD MM SS.f" (signed, degrees)
    const raRegex = /^\s*(\d{1,2}\s+\d{2}\s+\d{2}\.\d+)\s*$/;
    const decRegex = /^\s*([+-]?\d{1,2}\s+\d{2}\s+\d{2}\.\d*)\s*$/;

    for (let i = 1; i < row.length; i++) {
      const val = row[i]?.trim() || '';
      if (!ra && raRegex.test(val)) {
        ra = val;
      } else if (ra && !dec && decRegex.test(val)) {
        dec = val;
      } else if (ra && dec && !magnitude && val && /^[\d.]+$/.test(val)) {
        magnitude = val;
      }
    }

    // Fallback: use positional columns if regex didn't match
    if (!ra && row.length >= 4) {
      ra = row[2]?.trim() || '';
      dec = row[3]?.trim() || '';
      magnitude = row[5]?.trim() || '';
    }

    // Find distance (AU) — look for a decimal number around 0.01-100
    for (let i = 4; i < row.length; i++) {
      const val = parseFloat(row[i]?.trim() || '');
      if (!isNaN(val) && val > 0.001 && val < 1000 && !distAu) {
        distAu = row[i]?.trim() || '';
        // Next column is likely velocity
        if (i + 1 < row.length) velocity = row[i + 1]?.trim() || '';
        break;
      }
    }

    // Convert sexagesimal RA (HH MM SS) to decimal degrees
    const raMatch = ra.match(/(\d+)\s+(\d+)\s+([\d.]+)/);
    if (raMatch) {
      const raDeg = (parseInt(raMatch[1]) + parseInt(raMatch[2]) / 60 + parseFloat(raMatch[3]) / 3600) * 15;
      ra = raDeg.toFixed(4);
    }

    // Convert sexagesimal Dec (±DD MM SS) to decimal degrees
    const decMatch = dec.match(/([+-]?\d+)\s+(\d+)\s+([\d.]+)/);
    if (decMatch) {
      const sign = decMatch[1].startsWith('-') ? -1 : 1;
      const decDeg = sign * (Math.abs(parseInt(decMatch[1])) + parseInt(decMatch[2]) / 60 + parseFloat(decMatch[3]) / 3600);
      dec = decDeg.toFixed(4);
    }

    // Check if we got valid data
    if (!ra || !dec) {
      if (onLog) onLog(`[HORIZONS] Failed to parse RA/Dec from response`);
      return null;
    }

    const data: HorizonsData = {
        id: target,
        timestamp: row[0]?.trim(),
        ra,
        dec,
        magnitude,
        distance_au: distAu,
        velocity_kms: velocity
    };

    if (onLog) onLog(`[HORIZONS] Ephemeris Lock: RA ${data.ra}°, Dec ${data.dec}°, Mag ${data.magnitude}`);

    return data;

  } catch (err: any) {
    if (onLog) onLog(`[HORIZONS] System Error: ${err.message}`);
    return null;
  }
};
