
import { CometData, CometObservation } from "../types";

const COBS_API_ROOT = "/proxy/cobs/api/comet.api";
const COBS_OBS_LIST_ROOT = "/proxy/cobs/api/obs_list.api";
const COBS_PLANNER_ROOT = "/proxy/cobs/api/planner.api";

const formatDate = (date: Date): string => {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
};

// Mapping of popular/common comet names to their current official designations
const COMMON_NAME_MAP: Record<string, string> = {
  "neowise": "C/2020 F3",
  "devil comet": "12P",
  "pons-brooks": "12P",
  "green comet": "C/2022 E3",
  "ztf": "C/2022 E3",
  "tsuchinshan": "C/2023 A3",
  "tsuchinshan-atlas": "C/2023 A3",
  "a3": "C/2023 A3",
  "hale-bopp": "C/1995 O1",
  "halley": "1P",
  "encke": "2P",
  "borisov": "2I",
  "oumuamua": "1I",
  "3i": "3I",
  "atlas interstellar": "3I"
};

// OFFLINE PREDICTION DATABASE
// Acts as a fallback for future dates where observations don't exist yet,
// or when the live API is unreachable.
const OFFLINE_PREDICTION_DB = [
  // --- 2026 PREDICTIONS (Future) ---
  { id: "C/2025 R3", name: "C/2025 R3 (PanSTARRS)", start: "2025-11-01", end: "2026-12-31" },
  { id: "252P", name: "252P/LINEAR", start: "2026-02-01", end: "2026-06-01" },
  { id: "10P", name: "10P/Tempel 2", start: "2026-06-01", end: "2026-11-01" },
  { id: "210P", name: "210P/Christensen", start: "2025-12-01", end: "2026-02-01" },

  // --- 2025 PREDICTIONS ---
  { id: "3I", name: "3I/ATLAS (Interstellar)", start: "2025-08-01", end: "2026-06-30" },
  { id: "C/2025 R2", name: "C/2025 R2 (SWAN)", start: "2025-09-01", end: "2025-11-30" },
  { id: "C/2025 A6", name: "C/2025 A6 (Lemmon)", start: "2025-09-01", end: "2025-11-30" },
  { id: "C/2025 F2", name: "C/2025 F2 (SWAN)", start: "2025-03-01", end: "2025-05-30" },
  { id: "C/2024 G3", name: "C/2024 G3 (ATLAS)", start: "2024-11-01", end: "2025-04-01" },
  { id: "C/2024 S1", name: "C/2024 S1 (ATLAS)", start: "2024-10-01", end: "2025-02-01" },
  { id: "22P", name: "22P/Kopff", start: "2025-08-01", end: "2025-12-31" },

  // --- RECENT HISTORICAL ---
  { id: "C/2023 A3", name: "C/2023 A3 (Tsuchinshan-ATLAS)", start: "2024-05-01", end: "2025-06-01" },
  { id: "12P", name: "12P/Pons-Brooks", start: "2024-01-01", end: "2024-07-01" },
  { id: "13P", name: "13P/Olbers", start: "2024-05-01", end: "2024-10-01" },
  { id: "C/2022 E3", name: "C/2022 E3 (ZTF)", start: "2022-11-01", end: "2023-04-01" },
  { id: "C/2020 F3", name: "C/2020 F3 (NEOWISE)", start: "2020-06-01", end: "2020-09-01" },
  { id: "C/1995 O1", name: "C/1995 O1 (Hale-Bopp)", start: "1996-05-01", end: "1997-12-01" },
  { id: "1P", name: "1P/Halley", start: "1985-10-01", end: "1986-06-01" }
];

const normalizeDesignation = (input: string): string | null => {
  let cleaned = input.trim();
  const lower = cleaned.toLowerCase();

  // Allow "3I", "1I" explicitly before regex cleaning
  if (lower === "3i" || lower === "1i" || lower === "2i") return cleaned.toUpperCase();

  const iauRegex = /\b([CPXIDA]\/\d{4}\s*[A-Z0-9]+(?:-[A-Z0-9]+)?)\b/i;
  const iauMatch = cleaned.match(iauRegex);
  if (iauMatch) {
     let des = iauMatch[1].toUpperCase();
     des = des.replace(/([CPXIDA]\/\d{4})([A-Z0-9])/, '$1 $2');
     return des;
  }

  const periodicRegex = /\b(\d+[PD](?:-[A-Z])?)\b/i;
  const periodicMatch = cleaned.match(periodicRegex);
  if (periodicMatch) return periodicMatch[1].toUpperCase();

  const yearCodeRegex = /\b(\d{4})\s*([A-Z][0-9]+(?:-[A-Z])?)\b/i;
  const yearMatch = cleaned.match(yearCodeRegex);
  if (yearMatch) {
     return `C/${yearMatch[1]} ${yearMatch[2].toUpperCase()}`;
  }

  if (COMMON_NAME_MAP[lower]) return COMMON_NAME_MAP[lower];
  for (const [key, value] of Object.entries(COMMON_NAME_MAP)) {
    if (lower.includes(key)) return value;
  }

  cleaned = cleaned.replace(/^comet\s+/i, '').replace(/\s+comet$/i, '');
  if (/^[A-Z0-9]{4,}$/i.test(cleaned)) {
      return cleaned.toUpperCase();
  }
  
  // Last resort for short codes like "3I" if missed above
  if (/^[0-9]+[I]$/i.test(cleaned)) {
      return cleaned.toUpperCase();
  }

  return null;
};

/**
 * Fetch visible comets using the COBS Planner API.
 *
 * The Planner API is purpose-built for this — given a date (and optionally
 * location), it returns all comets visible with their predicted magnitudes,
 * RA/Dec positions, constellation, rise/set times, and motion.
 *
 * This replaces the old approach of querying the observation list and
 * aggregating magnitudes manually.
 */
const fetchLiveBrightComets = async (
  targetDate: Date,
  lat?: number | null,
  lon?: number | null,
): Promise<{ id: string, name: string, magnitude?: number, ra?: string, dec?: string }[]> => {
    try {
        const params: Record<string, string> = {
            date: formatDate(targetDate),
            lim_mag: '18',     // Include comets up to mag 18 (astrophotography limit)
            min_alt: '0',      // Include all altitudes (we'll check FOV separately)
            sun_alt: '-12',    // Nautical twilight
        };

        // Add observer location if available
        if (lat != null && lon != null) {
            params.lat = lat.toFixed(4);
            params.long = lon.toFixed(4);
            params.alt = '0';
        }

        const url = `${COBS_PLANNER_ROOT}?${new URLSearchParams(params).toString()}`;
        const res = await fetch(url);

        if (!res.ok) {
            console.warn(`COBS Planner API returned ${res.status}`);
            return [];
        }

        const data = await res.json();
        const cometList = data.comet_list;
        if (!cometList || !Array.isArray(cometList)) return [];

        // Sort by brightness and return
        const sorted = [...cometList]
            .sort((a: any, b: any) => (a.magnitude || 99) - (b.magnitude || 99))
            .slice(0, 15) // Top 15
            .map((c: any) => ({
                id: c.mpc_name || c.comet_name,
                name: c.comet_fullname || c.comet_name,
                magnitude: c.magnitude ? parseFloat(c.magnitude) : undefined,
                ra: c.best_ra,
                dec: c.best_dec,
            }));

        return sorted;
    } catch (e) {
        console.warn("COBS Planner fetch failed:", e);
        return [];
    }
};

/**
 * Smart Comet Selector:
 * 1. Tries to fetch LIVE data for the specific date.
 * 2. If live data is empty (e.g. future date with no obs yet), falls back to Prediction DB.
 */
export const getCometsByDate = async (
  dateStr: string,
  lat?: number | null,
  lon?: number | null,
): Promise<{ id: string, name: string, magnitude?: number, ra?: string, dec?: string }[]> => {
  const targetDate = new Date(dateStr);
  if (isNaN(targetDate.getTime())) return [];

  // 1. Try COBS Planner API — purpose-built for finding visible comets
  //    Returns magnitudes, positions, and visibility for a given date+location
  const liveData = await fetchLiveBrightComets(targetDate, lat, lon);
  if (liveData.length > 0) {
      return liveData;
  }

  // 2. Fallback: Offline Prediction Database
  // Essential for future planning where observations haven't occurred yet.
  const suggestions = OFFLINE_PREDICTION_DB.filter(comet => {
    const start = new Date(comet.start);
    const end = new Date(comet.end);
    start.setDate(start.getDate() - 30);
    end.setDate(end.getDate() + 30);
    return targetDate >= start && targetDate <= end;
  });

  if (suggestions.length > 0) {
    return suggestions.map(s => ({ id: s.id, name: s.name }));
  }

  return [];
};

export const fetchCometData = async (
  designation: string, 
  referenceDate?: string,
  onLog?: (msg: string) => void
): Promise<CometData | null> => {
  if (!designation || !designation.trim()) return null;

  const performFetch = async (queryDes: string): Promise<{ data: any, usedDesignation: string } | null> => {
    const params = new URLSearchParams({
      des: queryDes,
      orbit: 'true',
      'phys-par': 'true',
      'alt-des': 'true'
    });
    
    const url = `${COBS_API_ROOT}?${params.toString()}`;
    const res = await fetch(url);
    
    if (res.ok) {
        const data = await res.json();
        if (data.object) return { data, usedDesignation: queryDes };
    }
    return null;
  };

  try {
    const rawInput = designation.trim();
    if (onLog) onLog(`[COBS] Querying orbital database for: "${rawInput}"...`);

    let result = await performFetch(rawInput);

    if (!result) {
        const normalized = normalizeDesignation(rawInput);
        if (normalized) {
            if (normalized.toUpperCase() !== rawInput.toUpperCase()) {
                if (onLog) onLog(`[COBS] Raw query failed. Parsing syntax... Retrying as: "${normalized}"`);
                result = await performFetch(normalized);
            }
        }
    }

    if (!result) {
        if (onLog) onLog(`[COBS] Target '${rawInput}' not found in database.`);
        return null;
    }

    const { data: staticData, usedDesignation } = result;

    let observations: CometObservation[] = [];
    try {
        const refDateObj = referenceDate ? new Date(referenceDate) : new Date();
        const startDate = new Date(refDateObj);
        startDate.setDate(startDate.getDate() - 45);
        const endDate = new Date(refDateObj);
        endDate.setDate(endDate.getDate() + 5);

        const obsParams = new URLSearchParams({
            format: 'json',
            des: usedDesignation,
            from_date: formatDate(startDate),
            to_date: formatDate(endDate),
            exclude_faint: 'false',
            exclude_not_accurate: 'false'
        });

        const obsUrl = `${COBS_OBS_LIST_ROOT}?${obsParams.toString()}`;
        if (onLog) onLog(`[COBS] Retrieving visual reports from ${formatDate(startDate)}...`);

        const obsRes = await fetch(obsUrl);
        if (obsRes.ok) {
            const obsData = await obsRes.json();
            // COBS API v1.5: response has { info, object: [...], signature }
            const obsArray = obsData.object;
            if (onLog) onLog(`[COBS] Observation API returned ${obsArray ? obsArray.length : 0} records (total: ${obsData.info?.recordsTotal || '?'})`);
            if (obsArray && Array.isArray(obsArray) && obsArray.length > 0) {
                // Sort by date descending to get most recent observations first
                const sorted = [...obsArray].sort((a: any, b: any) =>
                  new Date(b.obs_date).getTime() - new Date(a.obs_date).getTime()
                );
                observations = sorted.map((o: any) => ({
                    obs_date: o.obs_date,
                    magnitude: o.magnitude,
                    coma_diameter: o.coma_diameter || null,
                    tail_length: o.tail_length || null,
                    observer: o.observer ? `${o.observer.last_name} (${o.observer.country})` : 'Unknown',
                    method: o.obs_method?.key || o.type || 'N/A',
                    conditions: o.conditions
                })).slice(0, 10);  // Keep top 10 most recent
                if (onLog) {
                    const nearest = observations[0];
                    onLog(`[COBS] Most recent observation: ${nearest.obs_date}, Mag ${nearest.magnitude} by ${nearest.observer}`);
                }
            } else if (onLog) {
                onLog(`[COBS] No observations found for des="${usedDesignation}" in date range ${formatDate(startDate)} to ${formatDate(endDate)}`);
            }
        } else {
            if (onLog) onLog(`[COBS] Observation API returned HTTP ${obsRes.status}`);
        }
    } catch (obsErr) {
        console.warn("COBS Observation Fetch Error:", obsErr);
    }

    const finalData: CometData = {
      object: {
        name: staticData.object.name,
        fullname: staticData.object.fullname,
        type: staticData.object.type
      },
      orbit: staticData.orbit,
      phys_par: staticData['phys-par'],
      recent_observations: observations
    };

    if (onLog) {
        const obsCount = observations.length;
        const magInfo = obsCount > 0 ? `, Last Mag: ${observations[0].magnitude}` : '';
        onLog(`[COBS] Telemetry acquired: ${finalData.object.fullname}${magInfo}.`);
    }
    
    return finalData;

  } catch (error: any) {
    console.warn("COBS API Error:", error);
    if (onLog) onLog(`[COBS] Telemetry failed: ${error.message}`);
    return null;
  }
};
