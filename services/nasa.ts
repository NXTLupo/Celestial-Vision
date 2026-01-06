
import { NeoObject } from "../types";

// Official NASA NeoWs (Near Earth Object Web Service) API
const NASA_API_ROOT = "https://api.nasa.gov/neo/rest/v1/feed";
const NASA_API_KEY = "***REMOVED***";

/**
 * Fetches Near-Earth Objects (NEOs) that are close to Earth around a specific date.
 * Uses api.nasa.gov with a paid/registered key for higher rate limits.
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
