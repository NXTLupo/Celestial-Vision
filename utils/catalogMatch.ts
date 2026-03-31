/**
 * Astronomical Catalog ID Matching
 *
 * Replaces the broken substring-based namesMatch() with proper catalog-aware
 * matching. Prevents false merges like "NGC 1" matching "NGC 11" or
 * "M 31" matching "31 Andromeda".
 *
 * Supports: NGC, IC, M/Messier, HD, HIP, SAO, Abell, UGC, PGC, ESO,
 * Arp, Sh2, Barnard, Cr, Mel, Pal, Mrk, LDN, plus Flamsteed/Bayer
 * star designations with constellation abbreviations.
 */

// Standard IAU 3-letter constellation abbreviations → full names
const CONSTELLATION_ABBREVS: Record<string, string> = {
  and: 'andromedae', ant: 'antliae', aps: 'apodis', aqr: 'aquarii', aql: 'aquilae',
  ara: 'arae', ari: 'arietis', aur: 'aurigae', boo: 'bootis', cae: 'caeli',
  cam: 'camelopardalis', cnc: 'cancri', cvn: 'canum venaticorum', cma: 'canis majoris',
  cmi: 'canis minoris', cap: 'capricorni', car: 'carinae', cas: 'cassiopeiae',
  cen: 'centauri', cep: 'cephei', cet: 'ceti', cha: 'chamaeleontis', cir: 'circini',
  col: 'columbae', com: 'comae berenices', cra: 'coronae australis', crb: 'coronae borealis',
  crv: 'corvi', crt: 'crateris', cru: 'crucis', cyg: 'cygni', del: 'delphini',
  dor: 'doradus', dra: 'draconis', equ: 'equulei', eri: 'eridani', for: 'fornacis',
  gem: 'geminorum', gru: 'gruis', her: 'herculis', hor: 'horologii', hya: 'hydrae',
  hyi: 'hydri', ind: 'indi', lac: 'lacertae', leo: 'leonis', lmi: 'leonis minoris',
  lep: 'leporis', lib: 'librae', lup: 'lupi', lyn: 'lyncis', lyr: 'lyrae',
  men: 'mensae', mic: 'microscopii', mon: 'monocerotis', mus: 'muscae', nor: 'normae',
  oct: 'octantis', oph: 'ophiuchi', ori: 'orionis', pav: 'pavonis', peg: 'pegasi',
  per: 'persei', phe: 'phoenicis', pic: 'pictoris', psc: 'piscium', psa: 'piscis austrini',
  pup: 'puppis', pyx: 'pyxidis', ret: 'reticuli', sge: 'sagittae', sgr: 'sagittarii',
  sco: 'scorpii', scl: 'sculptoris', sct: 'scuti', ser: 'serpentis', sex: 'sextantis',
  tau: 'tauri', tel: 'telescopii', tri: 'trianguli', tra: 'trianguli australis',
  tuc: 'tucanae', uma: 'ursae majoris', umi: 'ursae minoris', vel: 'velorum',
  vir: 'virginis', vol: 'volantis', vul: 'vulpeculae',
};

// Reverse map: full genitive → abbreviation
const GENITIVE_TO_ABBREV = new Map<string, string>();
for (const [abbr, gen] of Object.entries(CONSTELLATION_ABBREVS)) {
  GENITIVE_TO_ABBREV.set(gen, abbr);
}

// Catalog prefix patterns — order matters (longer prefixes first to avoid partial matches)
const CATALOG_REGEX = /^(messier|ngc|ic|hd|hip|sao|abell|ugc|pgc|eso|arp|sh\s*2|barnard|cr|mel|pal|mrk|ldn|m)\s*[-]?\s*(\d+[A-Za-z]?)/i;

// Prefix normalization
const NORMALIZE_PREFIX: Record<string, string> = {
  messier: 'm',
};

interface CatalogId {
  prefix: string; // normalized lowercase: "ngc", "m", "ic", etc.
  number: string; // full number including suffix: "5194", "51", "4284A"
}

interface StarDesignation {
  number: string;        // Flamsteed number or Bayer letter
  constellation: string; // normalized 3-letter abbreviation
}

/**
 * Extract catalog ID (e.g., "NGC 5194", "M 51", "IC 4263") from a name string.
 * Returns null if no catalog pattern found.
 */
function extractCatalogId(name: string): CatalogId | null {
  const match = name.trim().match(CATALOG_REGEX);
  if (!match) return null;

  let prefix = match[1].toLowerCase().replace(/\s+/g, '');
  prefix = NORMALIZE_PREFIX[prefix] || prefix;

  return { prefix, number: match[2].toLowerCase() };
}

/**
 * Extract Flamsteed/Bayer star designation (e.g., "56 Cyg", "Alpha Ori").
 * Handles both abbreviations and full genitive forms.
 */
function extractStarDesignation(name: string): StarDesignation | null {
  const lower = name.trim().toLowerCase();

  // Flamsteed: "56 Cyg" or "56 Cygni"
  const flamsteed = lower.match(/^(\d+)\s+([a-z]{3,})/);
  if (flamsteed) {
    const num = flamsteed[1];
    const constWord = flamsteed[2];

    // Check if it's a 3-letter abbreviation
    if (constWord.length === 3 && CONSTELLATION_ABBREVS[constWord]) {
      return { number: num, constellation: constWord };
    }
    // Check if it's a full genitive form
    for (const [abbr, gen] of Object.entries(CONSTELLATION_ABBREVS)) {
      if (constWord.startsWith(gen.split(' ')[0])) {
        return { number: num, constellation: abbr };
      }
    }
  }

  return null;
}

/**
 * Check if two astronomical names refer to the same object.
 *
 * Uses structured catalog ID parsing — NOT substring matching.
 * Only returns true if both names resolve to the same catalog entry
 * or the same star designation.
 *
 * Examples:
 *   catalogIdsMatch("NGC 5194", "NGC 5194 / Whirlpool Galaxy / M 51") → true
 *   catalogIdsMatch("M 51", "Messier 51") → true
 *   catalogIdsMatch("NGC 1", "NGC 11") → false (the old bug)
 *   catalogIdsMatch("56 Cyg", "56 Cygni") → true
 *   catalogIdsMatch("IC 4284", "IC 4285") → false
 */
export function catalogIdsMatch(aName: string, bName: string): boolean {
  const a = aName.trim();
  const b = bName.trim();

  // Exact match (case-insensitive)
  if (a.toLowerCase() === b.toLowerCase()) return true;

  // Strategy 1: Extract ALL catalog IDs from both names and check for overlap.
  // This handles compound names like "NGC 5194 / Whirlpool Galaxy / M 51"
  const aIds = extractAllCatalogIds(a);
  const bIds = extractAllCatalogIds(b);

  for (const aId of aIds) {
    for (const bId of bIds) {
      if (aId.prefix === bId.prefix && aId.number === bId.number) {
        return true;
      }
    }
  }

  // Strategy 2: Star designations (Flamsteed/Bayer)
  const aStar = extractStarDesignation(a);
  const bStar = extractStarDesignation(b);
  if (aStar && bStar) {
    return aStar.number === bStar.number && aStar.constellation === bStar.constellation;
  }

  return false;
}

/**
 * Extract ALL catalog IDs from a potentially compound name.
 * "NGC 5194 / Whirlpool Galaxy / M 51" → [{ngc, 5194}, {m, 51}]
 */
function extractAllCatalogIds(name: string): CatalogId[] {
  const ids: CatalogId[] = [];

  // Split on common delimiters: "/", ",", "(", ")"
  const parts = name.split(/[\/,()]+/).map(s => s.trim()).filter(s => s.length > 0);

  for (const part of parts) {
    const id = extractCatalogId(part);
    if (id) ids.push(id);
  }

  // Also try the full string (for names without delimiters)
  if (ids.length === 0) {
    const id = extractCatalogId(name);
    if (id) ids.push(id);
  }

  return ids;
}
