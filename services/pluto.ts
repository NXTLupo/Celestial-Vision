/**
 * Project Pluto Satellite Identification Service
 *
 * Queries Bill Gray's sat_code (projectpluto.com/sat_img.htm) to identify
 * artificial satellites in an image field. This is the AUTHORITATIVE source
 * for satellite identification because:
 *
 *   1. Uses HISTORICAL TLEs from the observation epoch (not current TLEs)
 *   2. Includes Bill Gray's custom TLEs for deep-space objects
 *   3. Uses the full Space-Track catalog (active + debris + rocket bodies)
 *   4. Runs Bill Gray's sat_id algorithm (same as used by professional
 *      asteroid surveyors to reject satellite false positives)
 *
 * Unlike our local SGP4 propagation (which uses current-epoch TLEs from
 * CelesTrak and degrades rapidly for old observations), Project Pluto
 * maintains archived TLEs and selects the closest epoch to the observation.
 *
 * Endpoint: GET https://projectpluto.com/cgi-bin/sat_id/sat_id3
 * Response: HTML with <pre> block containing fixed-width table
 *
 * Reference: https://github.com/Bill-Gray/sat_code
 */

const PLUTO_PROXY = '/proxy/pluto/cgi-bin/sat_id/sat_id3';
const PLUTO_CORS = 'https://projectpluto.com/cgi-bin/sat_id/sat_id3';

export interface PlutoSatellite {
  ra: number;           // RA J2000 in degrees
  dec: number;          // Dec J2000 in degrees
  motionArcminPerMin: number;  // Angular motion in arcmin/min
  positionAngle: number;       // PA in degrees (direction of motion)
  inShadow: boolean;    // True if satellite is in Earth's shadow
  noradId: string;      // 5-digit NORAD catalog number
  cosparId: string;     // International designator (e.g., "1990-017B")
  name: string;         // Common name (e.g., "SL-8 R/B")
  angularSepFromCenter: number; // Computed: angular sep from FOV center
}

/**
 * Query Project Pluto's sat_code for satellites in a field.
 *
 * @param obsDateUTC  Observation date/time in UTC
 * @param lat         Observer latitude (degrees, North positive)
 * @param lon         Observer longitude (degrees, East positive — note: negative for West)
 * @param centerRa    FOV center RA (degrees, J2000)
 * @param centerDec   FOV center Dec (degrees, J2000)
 * @param radiusDeg   Search radius in degrees (default 5)
 * @param onLog       Progress callback
 */
export async function queryProjectPluto(
  obsDateUTC: Date,
  lat: number,
  lon: number,
  centerRa: number,
  centerDec: number,
  radiusDeg: number = 5,
  onLog?: (msg: string) => void,
): Promise<PlutoSatellite[]> {
  // Format time: "YYYY MMM DD HH:MM:SS" UTC
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const y = obsDateUTC.getUTCFullYear();
  const m = months[obsDateUTC.getUTCMonth()];
  const d = obsDateUTC.getUTCDate();
  const hh = String(obsDateUTC.getUTCHours()).padStart(2, '0');
  const mm = String(obsDateUTC.getUTCMinutes()).padStart(2, '0');
  const ss = String(obsDateUTC.getUTCSeconds()).padStart(2, '0');
  const timeStr = `${y} ${m} ${d} ${hh}:${mm}:${ss}`;

  // Format latitude: "N 37.8775" or "S 33.1234"
  const latDir = lat >= 0 ? 'N' : 'S';
  const latStr = `${latDir} ${Math.abs(lat).toFixed(4)}`;

  // Format longitude: "W 122.4608" or "E 10.1234"
  const lonDir = lon >= 0 ? 'E' : 'W';
  const lonStr = `${lonDir} ${Math.abs(lon).toFixed(4)}`;

  // Format RA as sexagesimal HH MM SS.S (matching Project Pluto's expected format)
  // RA in degrees → hours: divide by 15
  const raHours = centerRa / 15;
  const raH = Math.floor(raHours);
  const raMinFloat = (raHours - raH) * 60;
  const raM = Math.floor(raMinFloat);
  const raS = ((raMinFloat - raM) * 60).toFixed(1);
  const raStr = `${raH} ${String(raM).padStart(2, '0')} ${raS}`;

  // Format Dec as sexagesimal +DD MM SS
  const decSign = centerDec >= 0 ? '+' : '-';
  const absDec = Math.abs(centerDec);
  const decD = Math.floor(absDec);
  const decMinFloat = (absDec - decD) * 60;
  const decM = Math.floor(decMinFloat);
  const decS = ((decMinFloat - decM) * 60).toFixed(0);
  const decStr = `${decSign}${decD} ${String(decM).padStart(2, '0')} ${decS}`;

  // Build query string manually to avoid URLSearchParams encoding issues
  // (URLSearchParams encodes + as %2B which some CGI scripts handle differently)
  const queryParts = [
    `radius=${radiusDeg.toFixed(0)}`,
    `time=${encodeURIComponent(timeStr)}`,
    `lat=${encodeURIComponent(latStr)}`,
    `lon=${encodeURIComponent(lonStr)}`,
    `alt=0`,
    `ra=${encodeURIComponent(raStr)}`,
    `dec=${encodeURIComponent(decStr)}`,
  ];
  const queryString = queryParts.join('&');

  if (onLog) {
    onLog(`[PROJECT PLUTO] Querying Bill Gray's sat_code: ${timeStr} UTC, RA=${raStr}, Dec=${decStr}, radius=${radiusDeg}°`);
    onLog(`[PROJECT PLUTO] URL: ${PLUTO_PROXY}?${queryString}`);
  }

  // Try Vite proxy first (direct connection), fall back to corsproxy.io
  let res: Response;
  try {
    res = await fetch(`${PLUTO_PROXY}?${queryString}`);
    if (!res.ok) throw new Error(`Vite proxy: ${res.status}`);
    if (onLog) onLog(`[PROJECT PLUTO] Connected via Vite proxy (direct)`);
  } catch {
    const targetUrl = `${PLUTO_CORS}?${queryString}`;
    const corsUrl = `https://corsproxy.io/?url=${encodeURIComponent(targetUrl)}`;
    if (onLog) onLog(`[PROJECT PLUTO] Vite proxy failed, trying corsproxy.io...`);
    res = await fetch(corsUrl);
    if (!res.ok) throw new Error(`Project Pluto returned ${res.status}`);
  }

  const html = await res.text();

  // Log FULL raw response for debugging — Project Pluto returns small responses
  if (onLog) {
    onLog(`[PROJECT PLUTO] Raw response (${html.length} bytes):`);
    // Log every non-empty line of the response
    const allLines = html.split('\n').map(l => l.replace(/<[^>]*>/g, '').trim()).filter(Boolean);
    allLines.forEach(l => {
      if (l.length > 0) onLog(`[PROJECT PLUTO] | ${l.substring(0, 150)}`);
    });
  }

  // Parse the fixed-width table from the response
  // Format: "Field  RA  Dec  '/min  PA  Sh NORAD Int'l_desig  Name"
  // Example: "Field  200.942  48.153  253.59  63.1   20509 1990-017B   SL-8 R/B"
  const results: PlutoSatellite[] = [];

  // Parse "Field" lines with numeric data.
  // Format varies — use flexible whitespace matching.
  // Example: "Field        200.942  48.153  253.59  63.1   20509 1990-017B   SL-8 R/B"
  // The shadow indicator (*) appears between PA and NORAD if in shadow.
  const fieldRegex = /^Field\s+([\d.]+)\s+([-\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(\*?)\s*(\d{1,5})\s+(\S+)\s+(.+)$/gm;
  let match;

  // Also try to extract from pre tag content specifically
  const preMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  const textToParse = preMatch ? preMatch[1] : html;

  while ((match = fieldRegex.exec(textToParse)) !== null) {
    const ra = parseFloat(match[1]);
    const dec = parseFloat(match[2]);
    const motion = parseFloat(match[3]);
    const pa = parseFloat(match[4]);
    const inShadow = match[5] === '*';
    const noradId = match[6].padStart(5, '0');
    const cosparId = match[7].trim();
    const name = match[8].trim();

    // Compute angular separation from FOV center
    const d2r = Math.PI / 180;
    const cosD = Math.sin(centerDec * d2r) * Math.sin(dec * d2r) +
                 Math.cos(centerDec * d2r) * Math.cos(dec * d2r) *
                 Math.cos((centerRa - ra) * d2r);
    const angSep = Math.acos(Math.min(1, Math.max(-1, cosD))) / d2r;

    results.push({
      ra, dec, motionArcminPerMin: motion, positionAngle: pa,
      inShadow, noradId, cosparId, name, angularSepFromCenter: angSep,
    });
  }

  // Sort by angular separation from center
  results.sort((a, b) => a.angularSepFromCenter - b.angularSepFromCenter);

  if (onLog) {
    onLog(`[PROJECT PLUTO] Found ${results.length} satellite(s) within ${radiusDeg}° of field center`);
    results.forEach(s => {
      const shadow = s.inShadow ? ' (SHADOW)' : '';
      onLog(`[PROJECT PLUTO]   ${s.name} (NORAD ${s.noradId}): RA=${s.ra.toFixed(3)}° Dec=${s.dec.toFixed(3)}°, ${s.motionArcminPerMin.toFixed(1)}'/min PA=${s.positionAngle.toFixed(1)}°, sep=${s.angularSepFromCenter.toFixed(2)}°${shadow}`);
    });
  }

  return results;
}
