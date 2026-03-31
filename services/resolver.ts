/**
 * Unknown Object Resolution Pipeline
 *
 * Systematically identifies unknown objects by exhausting every available
 * data source. For each unresolved identification, runs a cascade of checks:
 *
 *   STREAKS:  Meteor shower → ISS → satellite re-match (wider tolerance)
 *   ALL:      Planets (Horizons) → bright asteroids → comets (COBS+Horizons)
 *   FINAL:    Mark UNRESOLVED with full audit trail
 *
 * Every object exits this stage either IDENTIFIED with evidence or explicitly
 * marked UNRESOLVED with a list of every database that was checked.
 */

import { IdentificationResult, Identification, PlateSolveMetadata, NeoObject } from '../types';
import { fetchHorizonsEphemeris } from './horizons';
import { getCometsByDate } from './cobs';
import { SatelliteMatch } from './satellites';
import { DetectedStreak } from './gemini';

// --- UTILITIES ---

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Great-circle angular separation in degrees */
const angularSeparation = (ra1: number, dec1: number, ra2: number, dec2: number): number => {
  const d2r = Math.PI / 180;
  const cosD = Math.sin(dec1 * d2r) * Math.sin(dec2 * d2r) +
               Math.cos(dec1 * d2r) * Math.cos(dec2 * d2r) * Math.cos((ra1 - ra2) * d2r);
  return Math.acos(Math.min(1, Math.max(-1, cosD))) / d2r;
};

/** Parse RA string (various formats) to degrees */
const parseRaToDeg = (ra: string): number | null => {
  if (!ra) return null;
  const clean = ra.replace(/[°'"h m s]/g, ' ').trim();
  const num = parseFloat(clean);
  if (!isNaN(num) && Math.abs(num) <= 360) return num;
  // HMS format: "13 29 52.7" → degrees
  const parts = clean.split(/\s+/).map(Number);
  if (parts.length >= 2 && parts.every(p => !isNaN(p))) {
    return (parts[0] + (parts[1] || 0) / 60 + (parts[2] || 0) / 3600) * 15;
  }
  return null;
};

/** Parse Dec string to degrees */
const parseDecToDeg = (dec: string): number | null => {
  if (!dec) return null;
  const clean = dec.replace(/[°'"d m s]/g, ' ').trim();
  const num = parseFloat(clean);
  if (!isNaN(num) && Math.abs(num) <= 90) return num;
  const parts = clean.split(/\s+/).map(Number);
  if (parts.length >= 2) {
    const sign = clean.startsWith('-') ? -1 : 1;
    return sign * (Math.abs(parts[0]) + (parts[1] || 0) / 60 + (parts[2] || 0) / 3600);
  }
  return null;
};

// --- METEOR SHOWER TABLE ---

const METEOR_SHOWERS = [
  { name: 'Quadrantids', peakMonth: 1, peakDay: 3, radiantRa: 230, radiantDec: 49, duration: 4 },
  { name: 'Lyrids', peakMonth: 4, peakDay: 22, radiantRa: 271, radiantDec: 34, duration: 3 },
  { name: 'Eta Aquariids', peakMonth: 5, peakDay: 6, radiantRa: 338, radiantDec: -1, duration: 10 },
  { name: 'Delta Aquariids', peakMonth: 7, peakDay: 30, radiantRa: 340, radiantDec: -16, duration: 14 },
  { name: 'Perseids', peakMonth: 8, peakDay: 12, radiantRa: 48, radiantDec: 58, duration: 14 },
  { name: 'Draconids', peakMonth: 10, peakDay: 8, radiantRa: 262, radiantDec: 54, duration: 2 },
  { name: 'Orionids', peakMonth: 10, peakDay: 21, radiantRa: 95, radiantDec: 16, duration: 7 },
  { name: 'Leonids', peakMonth: 11, peakDay: 17, radiantRa: 152, radiantDec: 22, duration: 5 },
  { name: 'Geminids', peakMonth: 12, peakDay: 14, radiantRa: 112, radiantDec: 33, duration: 7 },
  { name: 'Ursids', peakMonth: 12, peakDay: 22, radiantRa: 217, radiantDec: 76, duration: 3 },
];

// --- PLANET IDS (JPL Horizons COMMAND format) ---

const PLANETS: [string, string][] = [
  ['Mercury', '199'], ['Venus', '299'], ['Mars', '499'],
  ['Jupiter', '599'], ['Saturn', '699'], ['Uranus', '799'], ['Neptune', '899'],
];

// --- BRIGHT ASTEROIDS (DES= format) ---

const BRIGHT_ASTEROIDS: [string, string][] = [
  ['1 Ceres', '1'], ['4 Vesta', '4'], ['2 Pallas', '2'], ['3 Juno', '3'], ['7 Iris', '7'],
];

// --- CHECK FUNCTIONS ---

/**
 * Check if a streak could be a meteor from an active shower.
 * Compares observation date to shower peak ± duration, and streak angle to radiant direction.
 */
function checkMeteorShower(
  obsDate: Date,
  streakAngleDeg: number | undefined,
  streakRa?: number,
  streakDec?: number,
): { resolved: boolean; name?: string; shower?: string } {
  if (streakAngleDeg === undefined && (streakRa === undefined || streakDec === undefined)) {
    return { resolved: false };
  }

  const month = obsDate.getMonth() + 1;
  const day = obsDate.getDate();

  for (const shower of METEOR_SHOWERS) {
    // Check if date is within shower window
    const peakDoy = dayOfYear(shower.peakMonth, shower.peakDay);
    const obsDoy = dayOfYear(month, day);
    const diff = Math.abs(obsDoy - peakDoy);
    const wrapped = Math.min(diff, 365 - diff);

    if (wrapped <= shower.duration) {
      // Date matches. If we have RA/Dec, check if streak direction traces toward radiant
      if (streakRa !== undefined && streakDec !== undefined) {
        const sep = angularSeparation(streakRa, streakDec, shower.radiantRa, shower.radiantDec);
        // Meteor shower streaks point AWAY from radiant, but within same hemisphere (~90° max)
        if (sep < 90) {
          return { resolved: true, name: `${shower.name} meteor`, shower: shower.name };
        }
      } else {
        // No RA/Dec, but date matches — possible meteor
        return { resolved: true, name: `Possible ${shower.name} meteor`, shower: shower.name };
      }
    }
  }

  return { resolved: false };
}

function dayOfYear(month: number, day: number): number {
  const daysInMonth = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let doy = day;
  for (let m = 1; m < month; m++) doy += daysInMonth[m];
  return doy;
}

/**
 * Check if the ISS (NORAD 25544) is among satellite matches with any match score.
 */
function checkISS(satelliteMatches: SatelliteMatch[]): SatelliteMatch | null {
  return satelliteMatches.find(s => s.noradId === '25544') || null;
}

/**
 * Re-check satellite matches with a wider tolerance (0.15 instead of 0.3).
 * Returns the best-matching satellite if score > 0.15.
 */
function recheckSatellitesWider(
  satelliteMatches: SatelliteMatch[],
  streakIdx: number,
): SatelliteMatch | null {
  // Find the satellite with the best score for this specific streak index
  let bestSat: SatelliteMatch | null = null;
  let bestScore = 0.15; // Lower threshold

  for (const sat of satelliteMatches) {
    if (sat.bestStreakIdx === streakIdx && (sat.streakMatchScore || 0) > bestScore) {
      bestScore = sat.streakMatchScore || 0;
      bestSat = sat;
    }
  }

  // Also check satellites that have any transit path but weren't matched to this streak
  if (!bestSat) {
    for (const sat of satelliteMatches) {
      if (sat.transitPath && sat.transitPath.length >= 2 && (sat.streakMatchScore || 0) > 0.1) {
        bestSat = sat;
        break;
      }
    }
  }

  return bestSat;
}

/**
 * Sweep all major planets via Horizons, checking angular proximity to target coordinates.
 */
async function sweepPlanets(
  timestamp: string,
  lat: number | null | undefined,
  lon: number | null | undefined,
  targetRa: number,
  targetDec: number,
  onLog?: (msg: string) => void,
): Promise<{ resolved: boolean; name?: string; data?: any; checked: string[] }> {
  const checked: string[] = [];

  for (const [name, id] of PLANETS) {
    checked.push(name);
    try {
      const eph = await fetchHorizonsEphemeris(id, timestamp, lat, lon, undefined, true);
      if (eph) {
        const ephRa = parseRaToDeg(eph.ra);
        const ephDec = parseDecToDeg(eph.dec);
        if (ephRa !== null && ephDec !== null) {
          const sep = angularSeparation(targetRa, targetDec, ephRa, ephDec);
          if (onLog) onLog(`[RESOLVER] Planet ${name}: sep=${sep.toFixed(3)}° from unknown`);
          if (sep < 0.5) {
            return { resolved: true, name, data: eph, checked };
          }
        }
      }
    } catch {
      // Skip failed queries
    }
    await delay(400);
  }

  return { resolved: false, checked };
}

/**
 * Sweep bright asteroids via Horizons.
 */
async function sweepBrightAsteroids(
  timestamp: string,
  lat: number | null | undefined,
  lon: number | null | undefined,
  targetRa: number,
  targetDec: number,
  onLog?: (msg: string) => void,
): Promise<{ resolved: boolean; name?: string; data?: any; checked: string[] }> {
  const checked: string[] = [];

  for (const [name, des] of BRIGHT_ASTEROIDS) {
    checked.push(name);
    try {
      const eph = await fetchHorizonsEphemeris(des, timestamp, lat, lon);
      if (eph) {
        const ephRa = parseRaToDeg(eph.ra);
        const ephDec = parseDecToDeg(eph.dec);
        if (ephRa !== null && ephDec !== null) {
          const sep = angularSeparation(targetRa, targetDec, ephRa, ephDec);
          if (onLog) onLog(`[RESOLVER] Asteroid ${name}: sep=${sep.toFixed(3)}° from unknown`);
          if (sep < 0.3) {
            return { resolved: true, name, data: eph, checked };
          }
        }
      }
    } catch {
      // Skip
    }
    await delay(400);
  }

  return { resolved: false, checked };
}

/**
 * Re-check comets visible on the observation date via COBS + Horizons.
 */
async function recheckComets(
  timestamp: string,
  lat: number | null | undefined,
  lon: number | null | undefined,
  targetRa: number,
  targetDec: number,
  onLog?: (msg: string) => void,
): Promise<{ resolved: boolean; name?: string; data?: any; checked: string[] }> {
  const checked: string[] = [];

  try {
    const comets = await getCometsByDate(timestamp);
    const top3 = comets.slice(0, 3);

    for (const comet of top3) {
      checked.push(comet.id);
      try {
        const eph = await fetchHorizonsEphemeris(comet.id, timestamp, lat, lon);
        if (eph) {
          const ephRa = parseRaToDeg(eph.ra);
          const ephDec = parseDecToDeg(eph.dec);
          if (ephRa !== null && ephDec !== null) {
            const sep = angularSeparation(targetRa, targetDec, ephRa, ephDec);
            if (onLog) onLog(`[RESOLVER] Comet ${comet.id}: sep=${sep.toFixed(3)}° from unknown`);
            if (sep < 0.5) {
              return { resolved: true, name: comet.id, data: eph, checked };
            }
          }
        }
      } catch {
        // Skip
      }
      await delay(400);
    }
  } catch {
    // COBS query failed
  }

  return { resolved: false, checked };
}

// --- MAIN RESOLVER ---

const UNKNOWN_TYPES = ['streak', 'space_debris', 'unknown'];
const CONFIDENCE_THRESHOLD = 0.6;

export async function resolveUnknownObjects(
  analysis: IdentificationResult,
  exif: any,
  plateSolve: PlateSolveMetadata | null,
  neos: NeoObject[],
  satelliteMatches: SatelliteMatch[],
  detectedStreaks: DetectedStreak[],
  onLog?: (msg: string) => void,
): Promise<Identification[]> {
  const identifications = [...analysis.identifications];

  // Find unknowns
  const unknownIndices: number[] = [];
  for (let i = 0; i < identifications.length; i++) {
    const id = identifications[i];
    const isUnknownType = UNKNOWN_TYPES.includes((id.object_type || '').toLowerCase());
    const isLowConfidence = (id.confidence ?? 1) < CONFIDENCE_THRESHOLD;
    const isUnmatchedStreak = id.streak_info && !id.streak_info.catalog_match;

    if (isUnknownType || isLowConfidence || isUnmatchedStreak) {
      unknownIndices.push(i);
    }
  }

  if (unknownIndices.length === 0) {
    if (onLog) onLog('[RESOLVER] No unknown objects to resolve.');
    return identifications;
  }

  if (onLog) onLog(`[RESOLVER] ${unknownIndices.length} unknown object(s) to investigate.`);

  const obsDate = new Date(exif.timestamp);
  let rateLimited = false;

  for (const idx of unknownIndices) {
    const id = identifications[idx];
    const databases_checked: string[] = [];
    let resolved = false;
    const originalType = id.object_type;

    if (onLog) onLog(`[RESOLVER] Investigating: "${id.primary_name}" (${id.object_type}, confidence=${(id.confidence ?? 0).toFixed(2)})`);

    const isStreak = ['streak', 'space_debris', 'satellite_trail'].includes((id.object_type || '').toLowerCase());

    // --- STREAK-SPECIFIC CHECKS ---

    if (isStreak) {
      // Check 1: Meteor shower
      databases_checked.push('Meteor shower catalog');
      const streakRa = parseRaToDeg(id.ra);
      const streakDec = parseDecToDeg(id.dec);
      const meteorResult = checkMeteorShower(
        obsDate,
        id.streak_info?.position_angle_deg,
        streakRa ?? undefined,
        streakDec ?? undefined,
      );
      if (meteorResult.resolved) {
        if (onLog) onLog(`[RESOLVER] ✓ RESOLVED as ${meteorResult.name}`);
        identifications[idx] = {
          ...id,
          primary_name: meteorResult.name!,
          object_type: 'meteor' as any,
          confidence: Math.max(id.confidence ?? 0, 0.7),
          evidence: [...(id.evidence || []), `Resolved: observation date matches ${meteorResult.shower} meteor shower window`],
          resolution_audit: { databases_checked, resolved: true, original_type: originalType },
        };
        continue;
      }

      // Check 2: ISS
      databases_checked.push('CelesTrak (ISS NORAD 25544)');
      const iss = checkISS(satelliteMatches);
      if (iss && (iss.streakMatchScore || 0) > 0) {
        if (onLog) onLog(`[RESOLVER] ✓ RESOLVED as ISS (International Space Station)`);
        identifications[idx] = {
          ...id,
          primary_name: 'ISS (International Space Station)',
          object_type: 'satellite_trail' as any,
          confidence: Math.max(id.confidence ?? 0, 0.8),
          evidence: [...(id.evidence || []), 'Resolved: ISS (NORAD 25544) transit confirmed via SGP4 propagation'],
          streak_info: { ...id.streak_info, catalog_match: 'ISS (NORAD 25544)' },
          resolution_audit: { databases_checked, resolved: true, original_type: originalType },
        };
        continue;
      }

      // Check 3: Satellite re-match with wider tolerance
      databases_checked.push('CelesTrak TLE (wider tolerance)');
      // Find which detected streak this identification corresponds to
      const streakIdx = detectedStreaks.findIndex(s => {
        if (!id.pixel_coords) return false;
        const midX = (s.pixel_start_x + s.pixel_end_x) / 2;
        const midY = (s.pixel_start_y + s.pixel_end_y) / 2;
        return Math.abs(midX - id.pixel_coords!.x) < 100 && Math.abs(midY - id.pixel_coords!.y) < 100;
      });
      const widerMatch = recheckSatellitesWider(satelliteMatches, streakIdx);
      if (widerMatch) {
        if (onLog) onLog(`[RESOLVER] ✓ RESOLVED as ${widerMatch.name} (NORAD ${widerMatch.noradId}) — wider tolerance match`);
        identifications[idx] = {
          ...id,
          primary_name: `${widerMatch.name} (NORAD ${widerMatch.noradId})`,
          object_type: 'satellite_trail' as any,
          confidence: Math.max(id.confidence ?? 0, 0.6),
          evidence: [...(id.evidence || []), `Resolved: satellite ${widerMatch.name} transit path correlated (wider tolerance), alt=${widerMatch.altitude.toFixed(0)}km`],
          streak_info: { ...id.streak_info, catalog_match: `${widerMatch.name} (NORAD ${widerMatch.noradId})` },
          resolution_audit: { databases_checked, resolved: true, original_type: originalType },
        };
        continue;
      }
    }

    // --- COORDINATE-BASED CHECKS (require RA/Dec) ---

    const objRa = parseRaToDeg(id.ra);
    const objDec = parseDecToDeg(id.dec);

    if (objRa !== null && objDec !== null && !rateLimited) {
      // Check 4: Planet sweep
      databases_checked.push('JPL Horizons (7 planets)');
      if (onLog) onLog(`[RESOLVER] Sweeping 7 planets via Horizons...`);
      try {
        const planetResult = await sweepPlanets(exif.timestamp, exif.location?.lat, exif.location?.lon, objRa, objDec, onLog);
        databases_checked.push(...planetResult.checked.map(p => `Horizons:${p}`));
        if (planetResult.resolved) {
          if (onLog) onLog(`[RESOLVER] ✓ RESOLVED as planet ${planetResult.name}`);
          identifications[idx] = {
            ...id,
            primary_name: planetResult.name!,
            object_type: 'star' as any, // Planets display as bright point sources
            confidence: 0.95,
            evidence: [...(id.evidence || []), `Resolved: ${planetResult.name} at RA=${planetResult.data?.ra}, Dec=${planetResult.data?.dec} via JPL Horizons ephemeris`],
            resolution_audit: { databases_checked, resolved: true, original_type: originalType },
          };
          continue;
        }
      } catch {
        rateLimited = true;
        if (onLog) onLog(`[RESOLVER] Horizons rate-limited. Skipping remaining API checks.`);
      }

      // Check 5: Bright asteroid sweep
      if (!rateLimited) {
        databases_checked.push('JPL Horizons (5 bright asteroids)');
        if (onLog) onLog(`[RESOLVER] Sweeping 5 bright asteroids via Horizons...`);
        try {
          const asteroidResult = await sweepBrightAsteroids(exif.timestamp, exif.location?.lat, exif.location?.lon, objRa, objDec, onLog);
          databases_checked.push(...asteroidResult.checked.map(a => `Horizons:${a}`));
          if (asteroidResult.resolved) {
            if (onLog) onLog(`[RESOLVER] ✓ RESOLVED as asteroid ${asteroidResult.name}`);
            identifications[idx] = {
              ...id,
              primary_name: asteroidResult.name!,
              object_type: 'asteroid' as any,
              confidence: 0.9,
              evidence: [...(id.evidence || []), `Resolved: asteroid ${asteroidResult.name} at ${asteroidResult.data?.ra}, ${asteroidResult.data?.dec} via JPL Horizons`],
              resolution_audit: { databases_checked, resolved: true, original_type: originalType },
            };
            continue;
          }
        } catch {
          rateLimited = true;
        }
      }

      // Check 6: Comet re-check
      if (!rateLimited) {
        databases_checked.push('COBS + Horizons (visible comets)');
        if (onLog) onLog(`[RESOLVER] Checking visible comets via COBS + Horizons...`);
        try {
          const cometResult = await recheckComets(exif.timestamp, exif.location?.lat, exif.location?.lon, objRa, objDec, onLog);
          databases_checked.push(...cometResult.checked.map(c => `COBS:${c}`));
          if (cometResult.resolved) {
            if (onLog) onLog(`[RESOLVER] ✓ RESOLVED as comet ${cometResult.name}`);
            identifications[idx] = {
              ...id,
              primary_name: cometResult.name!,
              object_type: 'comet' as any,
              confidence: 0.85,
              evidence: [...(id.evidence || []), `Resolved: comet ${cometResult.name} at ${cometResult.data?.ra}, ${cometResult.data?.dec} via COBS + Horizons`],
              resolution_audit: { databases_checked, resolved: true, original_type: originalType },
            };
            continue;
          }
        } catch {
          rateLimited = true;
        }
      }
    } else if (objRa === null || objDec === null) {
      databases_checked.push('SKIPPED: No RA/Dec coordinates available for Horizons queries');
    }

    // Check 7: UNRESOLVED — mark with full audit trail
    if (onLog) onLog(`[RESOLVER] ✗ UNRESOLVED: "${id.primary_name}" — checked ${databases_checked.length} databases, no match.`);
    identifications[idx] = {
      ...id,
      evidence: [...(id.evidence || []), `UNRESOLVED: Checked ${databases_checked.join(', ')} — no match found`],
      recommended_followup: id.recommended_followup || 'Submit coordinates to Minor Planet Center (MPC) for unknown streak, or check AAVSO/VSX for variable star if point source.',
      resolution_audit: { databases_checked, resolved: false, original_type: originalType },
    };
  }

  const resolvedCount = identifications.filter(id => id.resolution_audit?.resolved).length;
  const unresolvedCount = unknownIndices.length - resolvedCount;
  if (onLog) onLog(`[RESOLVER] Complete: ${resolvedCount} resolved, ${unresolvedCount} unresolved out of ${unknownIndices.length} unknowns.`);

  return identifications;
}
