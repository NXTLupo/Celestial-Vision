
/**
 * APPLAUSE Archive Client Service
 *
 * Queries the APPLAUSE (Archives of Photographic PLates for Astronomical USE)
 * database via our Vite server middleware to find historical photographic plates
 * that overlap the user's plate-solved sky region.
 */

export interface ArchivalPlate {
  plate_id: string;
  archive_id: string;
  plate_num: string;
  telescope: string;
  date_orig: string;
  exptime: string;
  ut_mid: string;
  year_mid: string;
  ra_icrs: string;
  dec_icrs: string;
  fov1: string;
  fov2: string;
  filename_scan: string;
  scan_id: string;
  archive_url: string;
  [key: string]: any;
}

export interface ArchivalSearchResult {
  count: number;
  query_ra: number;
  query_dec: number;
  query_radius: number;
  plates: ArchivalPlate[];
}

/**
 * Search APPLAUSE archive for historical plates covering the given sky coordinates.
 * @param ra Right Ascension in degrees
 * @param dec Declination in degrees
 * @param radius Search cone radius in degrees (default 1.0)
 * @param onLog Optional callback for status messages
 */
export const searchArchivalPlates = async (
  ra: number,
  dec: number,
  radius: number = 1.0,
  onLog?: (msg: string) => void
): Promise<ArchivalPlate[]> => {
  try {
    if (onLog) onLog(`[APPLAUSE] Searching archival plates at RA ${ra.toFixed(4)}, Dec ${dec.toFixed(4)}, radius ${radius}°...`);

    const res = await fetch('/api/applause/plates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ra, dec, radius }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (onLog) onLog(`[APPLAUSE] Query failed: ${err.error || err.detail || 'Unknown error'}`);
      return [];
    }

    const data: ArchivalSearchResult = await res.json();

    if (onLog) onLog(`[APPLAUSE] Found ${data.count} archival plates covering this sky region.`);

    return data.plates;
  } catch (err: any) {
    if (onLog) onLog(`[APPLAUSE] Error: ${err.message}`);
    return [];
  }
};

/**
 * Parse RA string (e.g. "312.9417°") to degrees
 */
export const parseRaDegrees = (ra: string): number | null => {
  const cleaned = ra.replace(/[°'"]/g, '').trim();
  const val = parseFloat(cleaned);
  return isNaN(val) ? null : val;
};
