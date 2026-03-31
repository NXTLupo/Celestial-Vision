
import { GoogleGenAI, Type, GenerateContentResponse, Chat } from "@google/genai";
import { IdentificationResult, PlateSolveMetadata, NeoObject, CometData, HorizonsData } from "../types";
import { catalogIdsMatch } from "../utils/catalogMatch";

const cleanResponseText = (text: string): string => {
  let clean = text.trim();
  if (clean.startsWith('```json')) clean = clean.slice(7);
  if (clean.startsWith('```')) clean = clean.slice(3);
  if (clean.endsWith('```')) clean = clean.slice(0, -3);
  clean = clean.trim();

  // If the response contains non-JSON text around the JSON object,
  // attempt to extract the outermost JSON object
  if (clean.length > 0 && clean[0] !== '{' && clean[0] !== '[') {
    const firstBrace = clean.indexOf('{');
    if (firstBrace !== -1) {
      clean = clean.substring(firstBrace);
    }
  }
  // Trim trailing non-JSON content after the closing brace
  const lastBrace = clean.lastIndexOf('}');
  if (lastBrace !== -1 && lastBrace < clean.length - 1) {
    clean = clean.substring(0, lastBrace + 1);
  }

  return clean.trim();
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// --- STAGE 0: VISUAL PRE-SCAN ---
// Examines the image for watermarks, overlays, text, or embedded metadata
// BEFORE plate solving, to extract date, time, location, target, instrument.

export interface ImagePreScan {
  date: string | null;       // "2026-01-15" or null
  time: string | null;       // "05:49" or null
  location: string | null;   // "Tiburon" or GPS coords
  target: string | null;     // "M 51", "NGC 891", "C/2023 A3", etc.
  instrument: string | null; // "Seestar S30", "ZWO ASI533MC Pro", etc.
  exposure: string | null;   // "24min", "120s", etc.
  notes: string | null;      // Any other text found
}

export const preScangImage = async (
  base64Image: string,
  onLog?: (msg: string) => void
): Promise<ImagePreScan> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

  const systemInstruction = `You are a deterministic image metadata extractor. Your ONLY job is to examine an astronomical photograph for ANY visible text, watermarks, overlays, timestamps, labels, or annotations burned into the image.

RULES:
- ONLY report text you can ACTUALLY SEE in the image. Do NOT guess or infer.
- If you see a date, convert it to YYYY-MM-DD format.
- If you see a time, report it in HH:MM format (24h).
- If you see a location name (city, observatory, coordinates), report it.
- If you see a celestial object name (M 51, NGC 891, C/2023 A3, etc.), report it as "target".
- If you see a camera/telescope name (Seestar, ZWO, Celestron, etc.), report it as "instrument".
- If you see exposure info (24min, 120s, 300x30s, etc.), report it.
- If you see NO text at all, return all null values. That is valid and common.
- Be literal. Report only text you can read in the image. Do not infer or guess.
- Smart telescopes (Seestar, Dwarf, Unistellar, Vaonis) often watermark: object name, date, time, location, exposure.
- DSLR/CCD images usually have NO watermarks — return nulls.`;

  const userPrompt = `Examine this astronomical image. Report ONLY text/watermarks/overlays that are visually present in the image. Return JSON.`;

  try {
    const result = await ai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: [{
        parts: [
          { inlineData: { mimeType: "image/jpeg", data: base64Image.split(',')[1] } },
          { text: userPrompt },
        ]
      }],
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            date: { type: Type.STRING, nullable: true },
            time: { type: Type.STRING, nullable: true },
            location: { type: Type.STRING, nullable: true },
            target: { type: Type.STRING, nullable: true },
            instrument: { type: Type.STRING, nullable: true },
            exposure: { type: Type.STRING, nullable: true },
            notes: { type: Type.STRING, nullable: true },
          },
        },
      }
    });

    const parsed = JSON.parse(cleanResponseText(result.text || '{}'));
    if (onLog) {
      const found: string[] = [];
      if (parsed.date) found.push(`Date: ${parsed.date}`);
      if (parsed.time) found.push(`Time: ${parsed.time}`);
      if (parsed.location) found.push(`Location: ${parsed.location}`);
      if (parsed.target) found.push(`Target: ${parsed.target}`);
      if (parsed.instrument) found.push(`Instrument: ${parsed.instrument}`);
      if (parsed.exposure) found.push(`Exposure: ${parsed.exposure}`);
      if (found.length > 0) {
        onLog(`[PRE-SCAN] Image text detected: ${found.join(' // ')}`);
      } else {
        onLog('[PRE-SCAN] No watermarks or text overlays detected in image.');
      }
    }
    return parsed;
  } catch (err: any) {
    if (onLog) onLog(`[PRE-SCAN] Visual scan failed: ${err.message}`);
    return { date: null, time: null, location: null, target: null, instrument: null, exposure: null, notes: null };
  }
};

// --- DEDICATED STREAK DETECTION ---
// Separate, focused Gemini call that ONLY looks for linear features.
// This runs independently from the main object identification to prevent
// the model from getting distracted by galaxies/stars and dismissing streaks.

export interface DetectedStreak {
  description: string;
  position: string;        // e.g. "upper-right quadrant, diagonal from top-right to center"
  approximate_angle_deg: number; // position angle on image
  brightness: string;      // "bright", "faint", "very faint"
  length: string;          // "short", "medium", "crosses entire frame"
  pixel_start_x: number;
  pixel_start_y: number;
  pixel_end_x: number;
  pixel_end_y: number;
}

export const detectStreaks = async (
  base64Image: string,
  imgWidth: number,
  imgHeight: number,
  onLog?: (msg: string) => void
): Promise<DetectedStreak[]> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

  const systemInstruction = `You are a streak detection algorithm. Your task is to find LINEAR FEATURES in this astronomical image.

LINEAR FEATURES include: satellite trails, space debris streaks, meteor trails, airplane tracks, or any other straight line.

DETECTION RULES:
- A streak is a line longer than 50 pixels that deviates less than 5 pixels from straight over its length
- Streaks can be bright or faint
- Streaks are NOT star diffraction spikes (those radiate from a single bright star)
- Streaks are NOT image edges or sensor artifacts at the very border of the frame
- Stars are round dots — streaks are elongated lines
- Report pixel coordinates as integers within image bounds

IMAGE DIMENSIONS: ${imgWidth} x ${imgHeight} pixels.
Report pixel coordinates relative to these dimensions (0,0 is top-left). All coordinates must be between 0 and the image dimensions.

If you find zero streaks, return an empty array. Both finding streaks and finding none are equally valid outcomes.`;

  const userPrompt = `Scan this astronomical image for linear features (streaks, trails, lines). Report each one with pixel start and end coordinates. Focus only on streaks — ignore stars, galaxies, nebulae.`;

  try {
    const result = await ai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: [{
        parts: [
          { inlineData: { mimeType: "image/jpeg", data: base64Image.split(',')[1] } },
          { text: userPrompt },
        ]
      }],
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            streaks: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  description: { type: Type.STRING },
                  position: { type: Type.STRING },
                  approximate_angle_deg: { type: Type.NUMBER },
                  brightness: { type: Type.STRING },
                  length: { type: Type.STRING },
                  pixel_start_x: { type: Type.NUMBER },
                  pixel_start_y: { type: Type.NUMBER },
                  pixel_end_x: { type: Type.NUMBER },
                  pixel_end_y: { type: Type.NUMBER },
                },
                required: ["description", "position", "brightness", "pixel_start_x", "pixel_start_y", "pixel_end_x", "pixel_end_y"]
              }
            }
          },
          required: ["streaks"]
        },
      }
    });

    const parsed = JSON.parse(cleanResponseText(result.text || '{"streaks":[]}'));
    const streaks: DetectedStreak[] = parsed.streaks || [];

    if (onLog) {
      if (streaks.length > 0) {
        onLog(`[STREAK DETECT] Found ${streaks.length} linear feature(s) in image:`);
        streaks.forEach((s, i) => {
          onLog(`[STREAK DETECT]   #${i + 1}: ${s.brightness} streak, ${s.position} (${s.pixel_start_x},${s.pixel_start_y})→(${s.pixel_end_x},${s.pixel_end_y})`);
        });
      } else {
        onLog('[STREAK DETECT] No linear features detected in image.');
      }
    }

    return streaks;
  } catch (err: any) {
    if (onLog) onLog(`[STREAK DETECT] Detection failed: ${err.message}`);
    return [];
  }
};

// --- WCS MATH UTILITIES ---

const parseCoordinateToDegrees = (coord: string | number): number | null => {
  if (typeof coord === 'number') return coord;
  if (!coord) return null;
  const c = coord.trim().toLowerCase();
  
  // Handle "123.456" or "123.456°"
  const simpleFloat = parseFloat(c.replace(/[^\d.-]/g, ''));
  if (!c.includes('h') && !c.includes('m') && !c.includes(':')) {
      return isNaN(simpleFloat) ? null : simpleFloat;
  }

  // Handle HMS / DMS format (Simple parsing for AI output)
  // This is a basic parser, for robust parsing we might need a library, 
  // but for Gemini standardized output it usually suffices.
  // Assumes space or colon delimiters
  const parts = c.split(/[ :hms°'"]+/).filter(Boolean).map(parseFloat);
  if (parts.length < 2) return isNaN(simpleFloat) ? null : simpleFloat;

  let val = 0;
  if (c.includes('h') || (parts[0] < 24 && c.includes(':'))) { 
      // RA in Hours? Convert to Deg (1h = 15deg)
      // Heuristic: If explicitly 'h' or looks like RA
      val = (parts[0] + parts[1]/60 + (parts[2]||0)/3600) * 15;
  } else {
      // Dec in Degrees
      const sign = c.includes('-') || c.startsWith('s') ? -1 : 1;
      const absDeg = Math.abs(parts[0]);
      val = sign * (absDeg + parts[1]/60 + (parts[2]||0)/3600);
  }
  return val;
};

// Gnomonic Projection (Tangent Plane) Approximation
const projectWorldToPixel = (
    ra: number, 
    dec: number, 
    centerRa: number, 
    centerDec: number, 
    scaleArcsecPerPixel: number, 
    orientationDeg: number,
    imgW: number,
    imgH: number
): { x: number, y: number } | null => {
    
    // Convert to Radians
    const deg2rad = Math.PI / 180;
    const raRad = ra * deg2rad;
    const decRad = dec * deg2rad;
    const centerRaRad = centerRa * deg2rad;
    const centerDecRad = centerDec * deg2rad;

    // Standard Gnomonic Projection formulas
    // X is East-West (RA), Y is North-South (Dec)
    const cosDec = Math.cos(decRad);
    const sinDec = Math.sin(decRad);
    const cosCenterDec = Math.cos(centerDecRad);
    const sinCenterDec = Math.sin(centerDecRad);
    const cosRaDiff = Math.cos(raRad - centerRaRad);
    const sinRaDiff = Math.sin(raRad - centerRaRad);

    const denom = sinCenterDec * sinDec + cosCenterDec * cosDec * cosRaDiff;
    if (denom === 0) return null; // Infinite projection

    const xi = (cosDec * sinRaDiff) / denom;
    const eta = (cosCenterDec * sinDec - sinCenterDec * cosDec * cosRaDiff) / denom;

    // Convert Radians to Degrees for scaling
    const xiDeg = xi / deg2rad;
    const etaDeg = eta / deg2rad;

    // Convert to Pixels (Scale is arcsec/pixel -> deg/pixel = scale/3600)
    const degPerPixel = scaleArcsecPerPixel / 3600;
    
    // Standard Image Coordinates (North Up, East Left)
    // xi corresponds to Easting. Positive xi is East (Left).
    // eta corresponds to Northing. Positive eta is North (Up).
    // Image X increases Right (West). Image Y increases Down (South).
    let xBase = -xiDeg / degPerPixel;
    let yBase = -etaDeg / degPerPixel;

    // Rotation (Astrometry Orientation)
    // Orientation is usually "Up is X degrees East of North"
    // We need to derotate or rotate into image frame.
    // Let's apply standard 2D rotation matrix.
    // Note: This matches Astrometry.net's simplified rotation behavior
    const rotRad = (orientationDeg) * deg2rad;
    const cosRot = Math.cos(rotRad);
    const sinRot = Math.sin(rotRad);

    // Coordinate Rotation
    const xRot = xBase * cosRot - yBase * sinRot;
    const yRot = xBase * sinRot + yBase * cosRot;

    // Center Shift
    const finalX = (imgW / 2) + xRot;
    const finalY = (imgH / 2) + yRot;

    return { x: finalX, y: finalY };
};

// --- API ---

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  let lastError: any;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      const errorStr = JSON.stringify(error).toLowerCase();
      if ((errorStr.includes('503') || errorStr.includes('overloaded') || errorStr.includes('fetch failed')) && i < maxRetries - 1) {
        const delay = Math.pow(2, i) * 2000;
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

// getBestAspectRatio removed — vector map is now deterministic Canvas render

const getImageDimensions = (base64: string): Promise<{width: number, height: number}> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.width, height: img.height });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = base64;
  });
};

// generateScientificIllustration removed — replaced by deterministic Canvas render
// in utils/vectorMap.ts (renderDeterministicVectorMap). See Phase 1 of anti-hallucination plan.

export const analyzeCelestialImageStream = async (
  base64Image: string,
  exifData: any,
  astrometry: PlateSolveMetadata | null,
  neos: NeoObject[],
  cometData: CometData | null,
  userTargetInput: string,
  horizonsData: HorizonsData | null,
  onThought: (text: string) => void,
  satelliteMatches?: { name: string; noradId: string; ra: number; dec: number; altitude: number; velocity: number; angularSep: number; illuminated: boolean; streakMatchScore?: number; transitAngleDeg?: number; transitPath?: any[] }[],
  preDetectedStreaks?: DetectedStreak[]
): Promise<IdentificationResult | null> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  const originalDims = await getImageDimensions(base64Image);

  // WCS DATA EXTRACTION FOR MATH
  let wcsCenterRa: number | null = null;
  let wcsCenterDec: number | null = null;
  let wcsScale: number | null = null;
  let wcsOrientation: number = 0;
  
  if (astrometry) {
      wcsCenterRa = parseCoordinateToDegrees(astrometry.center_ra);
      wcsCenterDec = parseCoordinateToDegrees(astrometry.center_dec);
      // Astrometry service returns "0.75 arcsec/pixel" string, or raw number in some contexts
      const scaleStr = astrometry.plate_scale.toString(); 
      wcsScale = parseFloat(scaleStr.replace(/[^\d.]/g, ''));
      wcsOrientation = astrometry.orientation || 0;
  }

  // Pre-calculate Pixel Coordinates for Hard Telemetry (Horizons)
  let calculatedTargetPixel: { x: number, y: number } | null = null;
  const activeTargetName = horizonsData?.id || cometData?.object.fullname || userTargetInput || "";

  if (horizonsData && astrometry && wcsCenterRa !== null && wcsCenterDec !== null && wcsScale) {
     const hRa = parseCoordinateToDegrees(horizonsData.ra);
     const hDec = parseCoordinateToDegrees(horizonsData.dec);
     if (hRa !== null && hDec !== null) {
        const proj = projectWorldToPixel(
            hRa, hDec, 
            wcsCenterRa, wcsCenterDec, 
            wcsScale, wcsOrientation, 
            astrometry.image_width || originalDims.width, 
            astrometry.image_height || originalDims.height
        );
        if (proj) {
            calculatedTargetPixel = proj;
            onThought(`[MATH] Projected ${activeTargetName} to X:${proj.x.toFixed(0)}, Y:${proj.y.toFixed(0)}`);
        }
     }
  }

  const isVisionMode = !astrometry;
  
  try {
    const selectedModel = 'gemini-3-pro-preview';
    onThought(isVisionMode ? `Plate solve failed. Engaging Gemini 3 Vision...` : `Engaging Gemini 3 Pro for Multi-Pass Forensics...`);

    let systemInstruction = "";
    let userPrompt = "";
    const parts: any[] = [];
    
    const inFieldNeos = neos.filter(n => n.in_field);
    const neoContext = neos.length > 0
      ? [
          ...(inFieldNeos.length > 0
            ? [`** ${inFieldNeos.length} NEO(s) CONFIRMED IN FIELD OF VIEW **`,
               ...inFieldNeos.map(n => `- ${n.fullname}: ${n.dist} AU, RA=${n.ra}°, Dec=${n.dec}°, V=${n.magnitude_v || '?'}, Pixel=(${n.pixel_x?.toFixed(0)},${n.pixel_y?.toFixed(0)}) ** IN IMAGE **`)]
            : []),
          ...neos.filter(n => !n.in_field).map(n => `- ${n.fullname}: ${n.dist} AU (outside FOV)`)
        ].join('\n')
      : "No close NEOs.";
      
    let cometContext = "No specific comet targeted.";

    if (horizonsData) {
        cometContext = `
        HARD TELEMETRY (JPL Horizons):
        Target: ${horizonsData.id}
        RA: ${horizonsData.ra}
        Dec: ${horizonsData.dec}
        Mag: ${horizonsData.magnitude}
        Distance: ${horizonsData.distance_au} AU

        ${calculatedTargetPixel
            ? `**GEOMETRIC CONFIRMATION**: Based on Plate Solving, this object is at Pixel coordinates X=${calculatedTargetPixel.x.toFixed(0)}, Y=${calculatedTargetPixel.y.toFixed(0)}. Report this location in your identifications.`
            : `Coordinates are provided. Use them.`}
        `;
    } else if (userTargetInput) {
        cometContext = `
        User Target: "${userTargetInput}"
        MISSING PRECISE COORDINATES:
        1. Use 'googleSearch' tool to find the Right Ascension (RA) and Declination (Dec) for "${userTargetInput}" on ${exifData.timestamp}.
        2. REPORT the RA/Dec you find.
        3. Do NOT guess pixel coordinates if you don't know where it is.
        `;
    }

    // If visible comets were found on this date but ephemeris couldn't be resolved
    // (e.g., plate solve failed so FOV check was impossible), mention them as candidates
    const visibleComets = (exifData as any).visibleComets as string[] | undefined;
    if (visibleComets && visibleComets.length > 0 && !horizonsData) {
        cometContext += `

        COMETS VISIBLE ON THIS DATE (from COBS database):
        ${visibleComets.join(', ')}

        These comets were confirmed visible on the observation date. Without a plate solve,
        their positions could not be checked against the field of view. If you can identify
        a fuzzy/diffuse object in the image that matches a comet appearance, note it as a
        CANDIDATE match with the comet name. Use Google Search to verify the comet's expected
        position and brightness on ${exifData.timestamp}.`;
    }

    const forensicProtocol = `
      ROLE: Astronomical Data Synthesizer.
      You summarize and narrate the results of deterministic data analyses. You do NOT perform your own visual object identification. All object identifications are provided to you from authoritative sources (Astrometry.net plate solving, CelesTrak/SGP4 satellite propagation, IAU SatChecker, JPL Horizons, NASA NeoWs, COBS comet database).

      YOUR JOB:
      1. Take the identified objects provided below and write a clear, professional summary.
      2. For each identified object, include it in the identifications array with the data provided.
      3. For the target object, use Google Search to find a reference_image_url (return null if not found via search — never guess URLs).
      4. Write a concise summary paragraph describing the field and what was found.

      DO NOT:
      - Identify objects yourself by looking at the image
      - Override or contradict the identifications provided from the data pipeline
      - Add objects that are not in the provided data
      - Claim "no streaks detected" if a streak identification is provided to you
      - INVENT or GUESS any numeric values (distances, magnitudes, dates, counts). If a number is in the data, QUOTE IT EXACTLY. If a number is NOT in the data, DO NOT make one up. Say "unknown" instead.

      TARGET: ${activeTargetName}

      OBJECT TYPES: galaxy, nebula, star, asteroid, comet, meteor, satellite_trail, space_debris, streak

      OUTPUT FORMAT: JSON.
    `;

    // Build satellite context — declarative facts, not instructions to "match"
    const allSats = satelliteMatches || [];

    let satContext = '';
    if (allSats.length > 0) {
      satContext += `\nSATELLITES IN FIELD (confirmed via SGP4/TLE propagation + IAU SatChecker):\n` +
        allSats.slice(0, 10).map(s => {
          const verified = (s as any).satCheckerVerified ? ' [IAU Verified]' : '';
          const illum = s.illuminated ? 'sunlit' : 'in shadow';
          return `- ${s.name} (NORAD ${s.noradId}): RA=${s.ra.toFixed(4)}°, Dec=${s.dec.toFixed(4)}°, Alt=${s.altitude.toFixed(0)}km, ${illum}${verified}`;
        }).join('\n') +
        `\nMention these satellites in your summary as confirmed by orbital data.`;
    }

    const streakContext = preDetectedStreaks && preDetectedStreaks.length > 0
      ? `\n\nDETECTED LINEAR FEATURES:\n` +
        preDetectedStreaks.map((s, i) =>
          `STREAK #${i + 1}: ${s.brightness} streak at ${s.position}. Pixels: (${s.pixel_start_x},${s.pixel_start_y})→(${s.pixel_end_x},${s.pixel_end_y}). ${s.description}`
        ).join('\n') +
        `\nInclude these streaks in your identifications array. They have been detected by the image analysis pipeline.`
      : '';

    const commonPromptData = `Obs Date: ${exifData.timestamp}\nTarget Data:\n${cometContext}${satContext}${streakContext}`;

    if (isVisionMode) {
      systemInstruction = `${forensicProtocol}`;
      userPrompt = `Summarize the following observation data. ${commonPromptData}
        Write a summary of the field and include all provided identifications in the output.`;
      parts.push({ inlineData: { mimeType: "image/jpeg", data: base64Image.split(',')[1] } });
      parts.push({ text: userPrompt });
    } else {
      const annotationsList = (astrometry!.annotations || []).map(a => `NAME: "${a.names.join('/')}"`).join('\n');
      systemInstruction = `${forensicProtocol}`;
      userPrompt = `
        PLATE-SOLVED ASTROMETRY DATA:
        Objects identified by Astrometry.net: ${annotationsList || "None"}
        CENTER: ${astrometry!.center_ra}, ${astrometry!.center_dec}
        FOV: ${astrometry!.field_of_view}

        ${commonPromptData}

        TASK:
        1. Include every object from the astrometry annotations in your identifications array with their catalog names.
        2. Include any streaks and satellites listed above in identifications.
        3. Use Google Search to find a reference_image_url for the primary target (return null if not found).
        4. Write a professional summary describing the field, identified objects, and any satellites or streaks.
      `;
      parts.push({ text: userPrompt });
    }

    const apiCall = ai.models.generateContent({
      model: selectedModel,
      contents: [{ parts }],
      config: {
        systemInstruction,
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            identifications: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  object_type: { type: Type.STRING },
                  primary_name: { type: Type.STRING },
                  ra: { type: Type.STRING },
                  dec: { type: Type.STRING },
                  confidence: { type: Type.NUMBER },
                  evidence: { type: Type.ARRAY, items: { type: Type.STRING } },
                  recommended_followup: { type: Type.STRING },
                  reference_image_url: { type: Type.STRING }, // Requested field
                  pixel_coords: {
                    type: Type.OBJECT,
                    properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER } },
                    required: ["x", "y"]
                  },
                  streak_info: {
                    type: Type.OBJECT,
                    properties: {
                      length_pixels: { type: Type.NUMBER },
                      position_angle_deg: { type: Type.NUMBER },
                      snr_estimate: { type: Type.STRING },
                      angular_velocity: { type: Type.STRING },
                      orbit_regime: { type: Type.STRING },
                      brightness_variation: { type: Type.STRING },
                      catalog_match: { type: Type.STRING },
                    }
                  }
                },
                required: ["object_type", "primary_name", "ra", "dec", "confidence", "evidence", "recommended_followup"]
              }
            },
            summary: { type: Type.STRING },
            sources: {
                type: Type.ARRAY,
                items: { type: Type.OBJECT, properties: { title: { type: Type.STRING }, uri: { type: Type.STRING } } }
            },
            plate_solve: {
              type: Type.OBJECT,
              properties: {
                center_ra: { type: Type.STRING },
                center_dec: { type: Type.STRING },
                plate_scale: { type: Type.STRING },
                wcs_quality: { type: Type.NUMBER },
                field_of_view: { type: Type.STRING },
                constellation: { type: Type.STRING }
              },
              required: ["center_ra", "center_dec", "plate_scale", "wcs_quality", "field_of_view"]
            }
          },
          required: ["identifications", "summary", "plate_solve"]
        }
      }
    });

    let response: GenerateContentResponse = await withRetry(() => apiCall);
    if (!response.text) throw new Error("Empty AI response");

    // Extract search grounding
    let searchSources: any[] = [];
    if (response.candidates?.[0]?.groundingMetadata?.groundingChunks) {
        searchSources = response.candidates[0].groundingMetadata.groundingChunks
            .filter((c: any) => c.web?.uri)
            .map((c: any) => ({ title: c.web.title || "Grounding Source", uri: c.web.uri }));
    }

    let result;
    try {
      result = JSON.parse(cleanResponseText(response.text));
    } catch (e) {
      // Google Search grounding can interfere with JSON output.
      // Retry without search tool as fallback.
      onThought("[RETRY] JSON parse failed with search grounding. Retrying without Google Search...");
      const retryCall = ai.models.generateContent({
        model: selectedModel,
        contents: [{ parts }],
        config: {
          systemInstruction,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              identifications: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    object_type: { type: Type.STRING },
                    primary_name: { type: Type.STRING },
                    ra: { type: Type.STRING },
                    dec: { type: Type.STRING },
                    confidence: { type: Type.NUMBER },
                    evidence: { type: Type.ARRAY, items: { type: Type.STRING } },
                    recommended_followup: { type: Type.STRING },
                    reference_image_url: { type: Type.STRING },
                    pixel_coords: {
                      type: Type.OBJECT,
                      properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER } },
                      required: ["x", "y"]
                    }
                  },
                  required: ["object_type", "primary_name", "ra", "dec", "confidence", "evidence", "recommended_followup"]
                }
              },
              summary: { type: Type.STRING },
              sources: {
                type: Type.ARRAY,
                items: { type: Type.OBJECT, properties: { title: { type: Type.STRING }, uri: { type: Type.STRING } } }
              },
              plate_solve: {
                type: Type.OBJECT,
                properties: {
                  center_ra: { type: Type.STRING },
                  center_dec: { type: Type.STRING },
                  plate_scale: { type: Type.STRING },
                  wcs_quality: { type: Type.NUMBER },
                  field_of_view: { type: Type.STRING },
                  constellation: { type: Type.STRING }
                },
                required: ["center_ra", "center_dec", "plate_scale", "wcs_quality", "field_of_view"]
              }
            },
            required: ["identifications", "summary", "plate_solve"]
          }
        }
      });
      response = await withRetry(() => retryCall);
      if (!response.text) throw new Error("Empty AI response on retry");
      result = JSON.parse(cleanResponseText(response.text));
    }
    
    if (searchSources.length > 0) result.sources = [...(result.sources || []), ...searchSources];

    // --- POST-PROCESSING: DETERMINISTIC WCS PROJECTION FOR ALL IDENTIFICATIONS ---
    // Project ALL identifications with RA/Dec to accurate pixel positions via WCS math.
    // This replaces unreliable LLM pixel guesses with mathematically derived coordinates.

    if (astrometry && wcsCenterRa !== null && wcsCenterDec !== null && wcsScale) {
        const projW = astrometry.image_width || originalDims.width;
        const projH = astrometry.image_height || originalDims.height;

        result.identifications = result.identifications.map((id: any) => {
            const objRa = parseCoordinateToDegrees(id.ra);
            const objDec = parseCoordinateToDegrees(id.dec);

            if (objRa !== null && objDec !== null) {
                const projected = projectWorldToPixel(
                    objRa, objDec,
                    wcsCenterRa!, wcsCenterDec!,
                    wcsScale!, wcsOrientation,
                    projW, projH
                );

                if (projected) {
                    onThought(`[WCS] Projected ${id.primary_name} → X:${projected.x.toFixed(0)}, Y:${projected.y.toFixed(0)}`);
                    return {
                        ...id,
                        pixel_coords: { x: projected.x, y: projected.y },
                        evidence: [...(id.evidence || []), "Position verified via WCS Projection"]
                    };
                }
            }
            return id;
        });

        // CORNER CASE: If Horizons had data but LLM failed to list it in identifications
        if (horizonsData && calculatedTargetPixel && activeTargetName) {
            const alreadyListed = result.identifications.some((id: any) =>
                id.primary_name.toLowerCase().includes(activeTargetName.toLowerCase())
            );

            if (!alreadyListed) {
                onThought(`[INJECTION] Adding missed target ${activeTargetName} at projected coordinates (ephemeris only — not visually confirmed).`);
                result.identifications.push({
                    object_type: "Comet (Projected)",
                    primary_name: horizonsData.id,
                    ra: horizonsData.ra,
                    dec: horizonsData.dec,
                    confidence: 0.5,
                    evidence: ["JPL Horizons Telemetry", "Geometric WCS Projection", "Ephemeris position only — not visually confirmed"],
                    verification_status: 'ephemeris_only',
                    recommended_followup: "Verify stellar point source at coordinates.",
                    pixel_coords: calculatedTargetPixel
                });
            }
        }
    }

    // --- CONFIDENCE CALIBRATION & VERIFICATION STATUS ---
    // Adjust raw Gemini confidence scores based on verification level
    result.identifications = result.identifications.map((id: any) => {
      let adjustedConfidence = id.confidence ?? 0.5;
      let verificationStatus = id.verification_status || 'vision_only';

      // WCS-verified positions get a boost
      if (id.evidence?.includes("Position verified via WCS Projection")) {
        adjustedConfidence = Math.min(1.0, adjustedConfidence + 0.1);
        verificationStatus = 'wcs_confirmed';
      }

      // Vision-only (no plate solve) — cap confidence
      if (!astrometry) {
        adjustedConfidence = Math.min(adjustedConfidence, 0.6);
        verificationStatus = 'vision_only';
      }

      // Streaks without SGP4 corroboration — cap confidence
      const isStreak = ['satellite_trail', 'space_debris', 'streak'].includes(id.object_type);
      if (isStreak && !id.streak_info?.catalog_match) {
        adjustedConfidence = Math.min(adjustedConfidence, 0.5);
        if (verificationStatus !== 'wcs_confirmed') verificationStatus = 'candidate';
      }

      return { ...id, confidence: adjustedConfidence, verification_status: verificationStatus };
    });

    // --- REFERENCE IMAGE URL VALIDATION ---
    // Validate URLs with HEAD requests — remove hallucinated URLs
    result.identifications = await Promise.all(
      result.identifications.map(async (id: any) => {
        if (id.reference_image_url) {
          try {
            const res = await fetch(id.reference_image_url, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
            if (!res.ok || !res.headers.get('content-type')?.startsWith('image/')) {
              return { ...id, reference_image_url: null };
            }
          } catch {
            return { ...id, reference_image_url: null };
          }
        }
        return id;
      })
    );

    // --- VISUAL LAYER MERGING ---
    // Astrometry annotations are authoritative for position. Gemini identifications
    // provide richer names. Merge by matching names, then add any unmatched Gemini IDs.
    const existingAnnotations = astrometry?.annotations || result.plate_solve.annotations || [];
    const mergedAnnotations = [...existingAnnotations];

    // Helper: check if two names refer to the same object
    // e.g. "56 Cyg" matches "56 Cygni", "IC 5070" matches "IC 5070 (Pelican Nebula)"
    // Use proper catalog ID matching — no more substring false positives
    const namesMatch = catalogIdsMatch;

    if (result.identifications && Array.isArray(result.identifications)) {
        result.identifications.forEach((id: any) => {
            const geminiName = id.primary_name || "";

            // First: try to find a name match in existing astrometry annotations
            const nameMatchIdx = mergedAnnotations.findIndex((a: any) =>
                a.names.some((n: string) => namesMatch(n, geminiName))
            );

            if (nameMatchIdx !== -1) {
                // Upgrade the astrometry annotation's label with the richer Gemini name
                const existing = mergedAnnotations[nameMatchIdx];
                if (!existing.names.some((n: string) => namesMatch(n, geminiName))) {
                    existing.names.unshift(geminiName);
                } else if (geminiName.length > existing.names[0].length) {
                    // Replace abbreviated name with full name as primary
                    existing.names = [geminiName, ...existing.names.filter((n: string) => !namesMatch(n, geminiName))];
                }
                if (id.object_type) existing.type = id.object_type;
            } else if (id.pixel_coords && typeof id.pixel_coords.x === 'number') {
                // Skip satellite/streak/debris — AI pixel coords are unreliable for linear features.
                // These are reported in the text analysis instead.
                const objType = (id.object_type || '').toLowerCase();
                if (objType.includes('satellite') || objType.includes('debris') || objType.includes('streak')) {
                    return;
                }

                // No name match — add as new annotation using WCS-projected coords
                const x = id.pixel_coords.x;
                const y = id.pixel_coords.y;

                mergedAnnotations.push({
                    pixelx: x,
                    pixely: y,
                    radius: 20,
                    names: [geminiName],
                    type: id.object_type
                });
            }
        });
    }

    if (astrometry) {
      result.plate_solve = { ...result.plate_solve, ...astrometry, annotations: mergedAnnotations, wcs_quality: astrometry.wcs_quality };
    } else {
      result.plate_solve = {
        ...result.plate_solve,
        job_id: 0,
        wcs_quality: 0, 
        annotated_image_url: undefined, 
        annotations: mergedAnnotations,
        image_width: originalDims.width,
        image_height: originalDims.height,
        constellation: result.plate_solve.constellation || "Visual Estimation",
      };
    }

    return result as IdentificationResult;

  } catch (error) {
    console.error("Gemini Formatting Error:", error);
    onThought(`Formatting Failed: ${error instanceof Error ? error.message : "Internal Error"}`);
    return null;
  }
};

/**
 * Generates an Instagram caption for the analyzed astronomical image.
 * Professional science communicator voice with historical plate context.
 */
export const generateInstagramCaption = async (
  base64Image: string,
  context: IdentificationResult,
  archivalReports?: { plate: any; analysis: any }[]
): Promise<string> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

  const objectList = (context.identifications || [])
    .map(id => `${id.primary_name} (${id.object_type}, RA: ${id.ra}, Dec: ${id.dec}, Confidence: ${id.confidence})`)
    .join('\n');

  const constellationInfo = context.plate_solve.constellation || 'unknown region';
  const fov = context.plate_solve.field_of_view || 'unknown';

  const inFieldNeos = (context.neos || []).filter((n: any) => n.in_field);
  const streaks = (context.identifications || []).filter(id => {
    const t = (id.object_type || '').toLowerCase();
    return t.includes('satellite') || t.includes('debris') || t.includes('streak');
  });

  // Build archival plate context for historical flavor
  let archivalContext = '';
  if (archivalReports && archivalReports.length > 0) {
    const plateDetails = archivalReports.map(r => {
      const year = r.plate.date_orig?.substring(0, 4) || '?';
      const telescope = r.plate.telescope || 'unknown telescope';
      const plateNum = r.plate.plate_num || r.plate.plate_id;
      const anomalyCount = r.analysis.anomalies?.length || 0;
      return `Plate ${plateNum} (${year}, ${telescope}): ${anomalyCount > 0 ? `${anomalyCount} anomalies detected` : 'field consistent across epochs'}`;
    }).join('\n');

    const oldestYear = Math.min(...archivalReports.map(r => parseInt(r.plate.date_orig?.substring(0, 4) || '9999')).filter(y => y < 9999));
    const baseline = oldestYear < 9999 ? new Date().getFullYear() - oldestYear : 0;
    const telescopes = [...new Set(archivalReports.map(r => r.plate.telescope).filter(Boolean))];

    archivalContext = `
HISTORICAL ARCHIVAL PLATES ANALYZED:
${plateDetails}
Time baseline: ~${baseline} years (oldest plate: ${oldestYear})
Telescopes: ${telescopes.join(', ') || 'Unknown'}
Total plates compared: ${archivalReports.length}
Source: APPLAUSE (Archives of Photographic PLates for Astronomical USE) — digitized photographic glass plates from European observatories spanning 1890s-1990s.`;
  }

  // Build satellite/debris context with historical notes
  const satelliteContext = streaks.length > 0 ? `
SATELLITE/DEBRIS IN IMAGE:
${streaks.map(s => {
  const name = s.primary_name || 'Unknown streak';
  const norad = (s as any).norad_id || '';
  return `- ${name}${norad ? ` (NORAD ${norad})` : ''}`;
}).join('\n')}

IMPORTANT: If satellite trails or space debris were identified, research and include a brief history of the specific object:
- For COSMOS 2251 debris: mention the 2009 Cosmos-Iridium collision — the first accidental hypervelocity collision between two intact satellites (Cosmos 2251 and Iridium 33 at 11.7 km/s over northern Siberia), which created thousands of trackable debris fragments still orbiting today.
- For FENGYUN 1C debris: mention China's 2007 anti-satellite test that destroyed the Fengyun-1C weather satellite at 865 km altitude, creating the largest single debris cloud in orbital history (~3,400 trackable pieces).
- For SL-8 R/B (or other Russian rocket bodies): mention these are spent upper stages from Soviet/Russian Kosmos-3M launch vehicles, many launched in the 1970s-1990s, now among the most dangerous debris objects due to their large mass (~1,400 kg).
- For DELTA debris: mention these are fragments from early American Delta rocket stages, some dating to the 1960s — among the oldest tracked objects still in orbit.
- For Starlink satellites: mention SpaceX's mega-constellation and its impact on astronomical observations.
- For any satellite/debris: mention it was cross-referenced against CelesTrak's catalog of ~27,000 tracked objects (active satellites, debris, and rocket bodies) and verified via IAU SatChecker.
Frame this as responsible space situational awareness, not complaint.` : '';

  const systemInstruction = `
ROLE: You are ghostwriting an Instagram post for Jonathan Lupo, an astrophotographer who built CelestialVision AI to autonomously identify every object in his images. Write in FIRST PERSON as Jonathan — "I captured", "my image", "I ran this through my pipeline". The tone is warm, curious, and knowledgeable — like an enthusiastic astronomer sharing what he found with friends. NOT corporate, NOT "we", NOT detached science writing.

VOICE:
- First person singular: "I", "my", "me" — never "we" or "our" or passive voice
- Conversational but scientifically precise. Understated. Like quietly sharing what you found, not shouting about it.
- Humble and matter-of-fact. Let the data speak. Don't hype or oversell.
- NO excitement, NO exclamation points, NO "incredible", "amazing", "mind-blowing". Just share what's there.
- Share the STORY behind the objects, not just catalog data
- Replace catalog IDs with common names on first mention, then parenthetical catalog ID: "the Whirlpool Galaxy (M51)"
- If exposure time is known, mention it naturally: "a 24-minute exposure" or "10 minutes on this target"

ATTRIBUTION — WHO FOUND WHAT (CRITICAL):
- Objects VISIBLE in the image (bright comet, galaxy, nebula, star trails): "I captured", "I shot", "you can see"
- Objects found by the pipeline through DATABASE QUERIES but NOT visually obvious in the image (satellites, debris, faint NEOs, catalog cross-matches): "CelestialVision identified", "the pipeline flagged", "my pipeline cross-referenced and found". These are NOT things "I picked up" or "I caught" - they were found through metadata analysis (date, time, location, coordinates) and database queries, not by looking at the photo.
- Be honest about this distinction. Satellite debris isn't something you SEE in a photo. It's something the software found by checking what was overhead at that time and place.
- Exception: if a satellite trail is VISIBLE as a streak in the image, you can say "I caught a satellite trail" but still attribute the IDENTIFICATION to the pipeline: "the pipeline identified it as FREGAT R/B"

CRITICAL — WRITE LIKE A REAL HUMAN, NOT AN AI:
- NEVER use en dashes (–) or em dashes (—). Use regular hyphens (-) or just rewrite the sentence.
- NEVER use the word "delve", "tapestry", "testament", "journey", "remarkable", "utilize", "leverage", "Furthermore", "Moreover", "Additionally", "It's worth noting", "Interestingly"
- NEVER use the construction "not just X, but Y" or "from X to Y" as a rhetorical device
- NEVER use "nestled", "captures the essence", "a testament to", "serves as a reminder"
- NEVER start sentences with "This" referring to the previous sentence's subject
- NEVER use semicolons in casual writing. Use periods.
- Keep sentences SHORT. If a sentence has more than one comma, break it up.
- Use contractions naturally: "it's", "didn't", "wasn't", "can't"
- Use casual transitions: "Turns out", "Pretty wild that", "What's cool is", "The thing is"
- It's okay to start sentences with "And" or "But"
- Write like someone texting a friend who happens to be into astronomy, not like a Wikipedia article
- NO flowery adjectives: not "breathtaking", "stunning", "magnificent", "awe-inspiring", "celestial dance"
- Prefer plain words: "old" not "ancient", "big" not "massive", "found" not "discovered", "cool" not "fascinating"

OBJECT HISTORY (CRITICAL — this is what makes the post interesting):
- For EACH identified deep-sky object, include 1-2 sentences of its discovery history: who discovered it, when, with what telescope, and one fascinating scientific fact. Use Google Search to verify.
  Examples:
  - M51: "First sketched by Charles Messier in 1773, but it was Lord Rosse who, in 1845, peered through his massive 72-inch Leviathan of Parsonstown and became the first human to see spiral structure in a galaxy — decades before anyone understood what galaxies even were."
  - NGC 891: "William Herschel found this edge-on spiral in 1784. It's become the textbook example of what the Milky Way might look like from outside."
  - M42: "Christiaan Huygens sketched it in 1659, making it one of the first nebulae ever documented."
- Weave the history naturally into the narrative — don't list facts like bullet points

${satelliteContext}

HISTORICAL PLATE STORYTELLING (if archival plates were analyzed):
- Dedicate 2-3 sentences to the historical plates. This is a unique, personal feature of my pipeline.
- Research the specific telescope that took the archival plates — when it was built, its aperture, notable discoveries, and whether it still exists
- Frame the time comparison personally: "I cross-referenced my capture against photographic glass plates exposed [N] years ago through [telescope name] at [observatory]"
- If no anomalies found: "The field has remained remarkably stable across [N] years of observation — a quiet testament to the permanence of deep space"
- Reference APPLAUSE by name: "the APPLAUSE archive — digitized photographic glass plates from European observatories dating back to the 1890s"

DATABASE CITATIONS (REQUIRED — list every database used in the analysis):
Explicitly cite EACH database that contributed to the analysis. Format naturally, not as a bulleted list:
- Astrometry.net (Dustin Lang, University of Toronto) — plate solving, WCS calibration
- NASA NeoWs (NASA Jet Propulsion Laboratory / CNEOS) — near-Earth object detection
- JPL Horizons (NASA JPL / Solar System Dynamics Group) — precise ephemeris computation
- CelesTrak (Dr. T.S. Kelso / AGI) — satellite TLE catalog (~27,000 tracked objects from US Space Force 18th Space Defense Squadron)
- IAU CPS SatChecker (International Astronomical Union Centre for the Protection of Dark and Quiet Sky) — satellite ephemeris verification
- Project Pluto (Bill Gray / sat_code) — authoritative satellite identification using historical TLEs
- COBS (Comet Observation Database / Crni Vrh Observatory, Slovenia) — comet visibility data
- US Space Force 18th SDS (via Space-Track.org) — space surveillance catalog, the primary source of TLE orbital data worldwide
- ESA GAIA DR3 (European Space Agency) — reference star catalog
- APPLAUSE (Leibniz Institute for Astrophysics Potsdam / AIP) — archival photographic plates (if used)
- Google Gemini — AI synthesis of deterministic pipeline results

STRUCTURE (locked format — follow exactly):
LINE 1: A quiet, understated hook under 125 characters. Factual, not clickbait. This shows before "...more".
LINE 2: Empty line
LINES 3-8: 2-3 paragraphs. The story of what I captured and what the pipeline found. Weave in object discovery history, scientific facts, and how the identification was made (plate solving, catalog matching, ephemeris cross-referencing). If satellites/debris were identified, include their specific history.
LINE 9: Empty line
LINES 10-12: If archival plates exist: 1 paragraph about the historical plate comparison with telescope history. If no archival plates: skip this section entirely.
LINE 13: Empty line
LINE 14: Citations paragraph. Natural prose citing databases and their operators: "Field plate-solved via Astrometry.net. Objects cross-referenced against NASA JPL's NeoWs and Horizons databases, the US Space Force 18th SDS orbital catalog via CelesTrak, the IAU's SatChecker service, and Bill Gray's Project Pluto sat_code. Analysis synthesized by Google Gemini."
LINE 15: Empty line
LINE 16: Exactly: "Captured and analyzed by Jonathan Lupo // CelestialVision AI"
LINE 17: Empty line
LINE 18: 20-30 hashtags organized by category. Select from the MANDATORY and CONDITIONAL lists below:

MANDATORY HASHTAGS (always include):
#astrophotography #CelestialVisionAI #BackyardAstronomy #DeepSky

Database/Agency source tags (always include):
#AstrometryNet #NASA #JPL #JPLHorizons #GoogleGemini

Government/institutional tags (always include):
#USSF #SpaceForce #USSpaceCommand #ESA #GAIADR3

Include object-specific tags for EACH identified object:
- Messier objects: #M51 #MessierMonday (or appropriate Messier tag)
- NGC objects: #NGC5194 #NGC5195 etc.
- IC objects: #IC4263 etc.
- Common names: #WhirlpoolGalaxy #OrionNebula #AndromedaGalaxy etc.
- Constellation: #CanesVenatici #Orion #Andromeda etc.

Include instrument tags if known: #Seestar #SeeStar30 #ZWO #SmartTelescope etc.

${streaks.length > 0 ? `CONDITIONAL — Satellite/Debris detected (include ALL):
#SpaceDebris #SpaceSituationalAwareness #SatelliteTrail #OrbitalDebris
#CelesTrak #IAU #IAUSatChecker #IAUCentre #DarkAndQuietSky
#ProjectPluto #BillGray #SatCode
#SpaceTrack #18SDS #SpaceSurveillance #SSA
#Roscosmos (if Russian debris like Cosmos, SL-8, Fregat)
#CNSA (if Chinese debris like Fengyun, CZ-series)
#SpaceX #Starlink (if Starlink satellite)
#OneWeb (if OneWeb satellite)
#Iridium (if Iridium satellite)` : ''}
${inFieldNeos.length > 0 ? `CONDITIONAL — Near-Earth Objects detected (include ALL):
#NearEarthObject #NEO #PlanetaryDefense #AsteroidWatch
#NASANeoWs #CNEOS #PlanetaryDefenseOfficer
#Asteroid #NearEarthAsteroid` : ''}
${archivalReports && archivalReports.length > 0 ? `CONDITIONAL — Archival plates analyzed (include ALL):
#APPLAUSE #PhotographicPlates #ArchivalAstronomy #HistoryOfScience
#AIP #LeibnizInstitute #Potsdam
#GlassPlates #AstronomicalHeritage` : ''}

FAILURE PREVENTION:
- Total caption MUST be under 2200 characters (Instagram hard limit). If over, CUT hashtags first, then trim history paragraphs. NEVER cut citations.
- Do NOT invent object names, facts, distances, or ages — ONLY reference the data provided below, supplemented by Google Search for verified historical facts
- Do NOT use markdown formatting (no **, no #headers, no [links])
- Do NOT use emojis in the main caption body — only in the hashtag divider line if desired
- NEVER say "we" — always "I"
- NEVER use corporate/institutional voice — this is Jonathan's personal post
- ZERO en dashes (–) or em dashes (—) anywhere in the output. Use hyphens (-) or rewrite.
- ZERO AI-tell words: delve, tapestry, testament, journey, remarkable, utilize, leverage, Furthermore, Moreover, Additionally, nestled, awe-inspiring, celestial dance, breathtaking, stunning, magnificent
- NEVER invent numeric values. Distances, magnitudes, counts, dates, and measurements must come DIRECTLY from the data provided. If the data says distance_au=1.97, write "about 2 AU". Do NOT round 1.97 to 15, do NOT guess, do NOT make up numbers.
- If a comet is BRIGHT and VISIBLE in the image, do NOT say it's magnitude 15 (that's barely visible). A comet that dominates the frame is magnitude 5-10 at most. If the pipeline magnitude seems wrong compared to how bright the object appears, note the discrepancy or omit the magnitude rather than stating a number that contradicts the visual evidence.
- Read your output back. If it sounds like ChatGPT wrote it, rewrite it to sound like a person.
`;

  // Build satellite match details
  const satellites = (context as any).satellites || [];
  const satelliteDetails = satellites.length > 0
    ? `\nSatellites/Debris Identified (via CelesTrak + SGP4 + IAU SatChecker + Project Pluto):\n${satellites.slice(0, 10).map((s: any) => {
        const pluto = s.plutoVerified ? ' [Project Pluto VERIFIED — Bill Gray sat_code, historical TLEs]' : '';
        const verified = s.satCheckerVerified ? ' [IAU SatChecker Verified]' : '';
        const illum = s.illuminated ? 'sunlit' : 'in shadow';
        const motion = s.plutoMotion ? `, motion=${s.plutoMotion.toFixed(1)}'/min PA=${s.plutoPA?.toFixed(1)}°` : '';
        // Determine origin agency for hashtag guidance
        const name = (s.name || '').toUpperCase();
        let origin = '';
        if (name.includes('SL-') || name.includes('COSMOS') || name.includes('FREGAT') || name.includes('BREEZE') || name.includes('METEOR')) origin = ' [Russian/Soviet — Roscosmos]';
        else if (name.includes('CZ-') || name.includes('FENGYUN') || name.includes('HULIANWANG')) origin = ' [Chinese — CNSA]';
        else if (name.includes('STARLINK')) origin = ' [SpaceX Starlink]';
        else if (name.includes('ONEWEB')) origin = ' [OneWeb]';
        else if (name.includes('IRIDIUM')) origin = ' [Iridium Communications]';
        else if (name.includes('DELTA') || name.includes('ATLAS') || name.includes('TITAN')) origin = ' [US — ULA/NASA legacy]';
        else if (name.includes('USA ')) origin = ' [US — classified/military]';
        else if (name.includes('NOAA') || name.includes('GOES')) origin = ' [US — NOAA]';
        return `- ${s.name} (NORAD ${s.noradId}): ${illum}, alt=${Math.round(s.altitude)}km${s.rangeKm ? `, range=${Math.round(s.rangeKm)}km` : ''}${motion}${origin}${pluto}${verified}`;
      }).join('\n')}`
    : '';

  const userPrompt = `
ANALYSIS DATA:
Constellation: ${constellationInfo}
Field of View: ${fov}
Plate Scale: ${context.plate_solve.plate_scale}
Center: RA ${context.plate_solve.center_ra}, Dec ${context.plate_solve.center_dec}
WCS Quality: ${context.plate_solve.wcs_quality}%

Objects Identified:
${objectList}
${inFieldNeos.length > 0 ? `\nNEOs In Field: ${inFieldNeos.map((n: any) => `${n.fullname} (${(parseFloat(n.dist) * 389.17).toFixed(1)} lunar distances)`).join(', ')}` : ''}
${streaks.length > 0 ? `\nStreaks/Trails Detected: ${streaks.map(s => {
  const info = s.streak_info ? ` — ${s.streak_info.length_pixels}px long, PA ${s.streak_info.position_angle_deg?.toFixed(0)}°` : '';
  return `${s.primary_name}${info}`;
}).join(', ')}` : ''}
${satelliteDetails}

Databases and Agencies Used in This Analysis:
- Astrometry.net (Dustin Lang, University of Toronto): plate solving, WCS astrometric calibration
- NASA NeoWs (NASA JPL / Center for Near Earth Object Studies): near-Earth object detection within 0.1 AU
- JPL Horizons (NASA Jet Propulsion Laboratory, Solar System Dynamics Group): precise ephemeris
- CelesTrak (Dr. T.S. Kelso): TLE catalog sourced from US Space Force 18th Space Defense Squadron (18 SDS) via Space-Track.org
- IAU CPS SatChecker (International Astronomical Union, Centre for the Protection of Dark and Quiet Sky from Satellite Constellation Interference): satellite ephemeris verification
- Project Pluto (Bill Gray, sat_code): authoritative satellite identification using archived historical TLEs — the same tool used by professional asteroid surveyors
- COBS (Comet Observation Database, Crni Vrh Observatory, Slovenia): comet visibility data
- ESA GAIA DR3 (European Space Agency): reference star catalog with ~1.8 billion sources
- Google Gemini 3 Pro: AI synthesis of deterministic pipeline results
${archivalContext ? `- APPLAUSE (Archives of Photographic PLates for Astronomical USE, Leibniz Institute for Astrophysics Potsdam / AIP, Germany): historical photographic glass plates from European observatories (1890s-1990s)` : ''}
${archivalContext}

Summary: ${context.summary}

Generate the Instagram caption now. Write as Jonathan Lupo in first person. Follow the locked structure exactly. Include discovery history for identified objects. If satellites/debris were found, include their specific history. If archival plates are listed above, you MUST include the historical plate paragraph. Cite the databases used.
`;

  const parts: any[] = [
    { inlineData: { mimeType: "image/jpeg", data: base64Image.split(',')[1] } },
    { text: userPrompt }
  ];

  const result = await ai.models.generateContent({
    model: 'gemini-3-pro-preview',
    contents: [{ parts }],
    config: {
      systemInstruction,
    }
  });

  // Enforce 2200 character limit programmatically (Instagram max)
  let caption = result.text || 'Caption generation failed. Please try again.';
  if (caption.length > 2200) {
    const truncated = caption.substring(0, 2200);
    const lastPeriod = truncated.lastIndexOf('.');
    caption = lastPeriod > 1800 ? truncated.substring(0, lastPeriod + 1) : truncated;
  }
  return caption;
};

/**
 * Cross-epoch analysis: compare a modern user image against historical archival plates.
 * Returns a structured anomaly report that feeds into the Ask the Astronomer chat.
 */
export interface ArchivalCrossAnalysis {
  anomalies: {
    type: 'new_object' | 'vanished_object' | 'variable' | 'transient' | 'proper_motion';
    description: string;
    significance: 'high' | 'medium' | 'low';
    possible_explanations: string[];
  }[];
  summary: string;
  plate_assessment: string; // quality/overlap assessment of the archival plate
}

export const analyzeArchivalCrossMatch = async (
  base64UserImage: string,
  archivalPreviewUrl: string,
  userContext: IdentificationResult,
  plateMetadata: {
    plate_id: string;
    plate_num: string;
    date_orig: string;
    telescope: string;
    ra_icrs: string;
    dec_icrs: string;
    fov1: string;
    fov2: string;
    exptime: string;
  }
): Promise<ArchivalCrossAnalysis> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const objectList = (userContext.identifications || [])
    .map(id => `- ${id.primary_name} (${id.object_type}, RA: ${id.ra}, Dec: ${id.dec})`)
    .join('\n');

  const plateYear = plateMetadata.date_orig ? plateMetadata.date_orig.substring(0, 4) : 'unknown';
  const baseline = plateMetadata.date_orig
    ? new Date().getFullYear() - parseInt(plateYear)
    : 0;

  const systemInstruction = `You are an expert astronomer specializing in transient detection and multi-epoch analysis (VASCO / FAST methodology). You are comparing a MODERN astronomical photograph against a HISTORICAL photographic plate from the APPLAUSE archive.

Your task: identify ANY differences between the two epochs that could indicate:
1. NEW OBJECTS — sources present in the modern image but absent in the historical plate
2. VANISHED OBJECTS — sources visible in the historical plate but gone in the modern image
3. VARIABLE SOURCES — objects that appear significantly different in brightness
4. TRANSIENTS — objects that appear in only one epoch (supernovae, novae, asteroids)
5. PROPER MOTION — objects that have shifted position between epochs

METHODOLOGY (based on Rachith, Hellmich & Kneib 2025 — multi-epoch archival analysis):
- Be scientifically rigorous. Most differences are due to plate depth, resolution, or FOV mismatch — note these.
- Clearly distinguish between REAL anomalies and artifacts of different imaging technology.
- Historical plates are photographic negatives (bright stars = dark spots) and have different sensitivity curves.
- The archival plate may cover a MUCH larger field than the user's image — only compare the overlapping region.
- Use Google Search to verify if any anomaly candidates are known variable stars, novae, or transients.

PHOTOMETRIC AWARENESS:
- Archival photographic plates have non-linear response curves (unlike modern CCDs).
- Plate sensitivity varies by emulsion type and filter — blue-sensitive plates may miss red objects and vice versa.
- The limiting magnitude of a photographic plate depends on emulsion, exposure time, telescope aperture, and seeing.
- Objects near the plate limit may appear/disappear between epochs due to sensitivity differences, NOT real variability.
- True transients should be significantly brighter than the plate limit to be credible detections.

STREAK/TRAIL AWARENESS:
- Linear features in archival plates may be satellite trails (post-1957), aircraft, or plate defects.
- Pre-Sputnik plates (before 1957) cannot contain satellite trails — any linear features are aircraft, meteors, or defects.
- Modern images frequently contain Starlink and other mega-constellation trails — these are NOT anomalies.
- Space debris density has increased dramatically since the 1990s — trails in recent data are expected.

RESPOND IN THIS EXACT JSON FORMAT (no markdown, no code fences):
{
  "anomalies": [
    {
      "type": "new_object|vanished_object|variable|transient|proper_motion",
      "description": "Clear description of what was detected",
      "significance": "high|medium|low",
      "possible_explanations": ["explanation 1", "explanation 2"]
    }
  ],
  "summary": "2-3 sentence narrative summary of the cross-epoch comparison findings",
  "plate_assessment": "Assessment of the archival plate quality, overlap coverage, and comparison limitations"
}`;

  const userPrompt = `CROSS-EPOCH COMPARISON DATA:

MODERN IMAGE (${new Date().getFullYear()}):
- Center: RA ${userContext.plate_solve.center_ra}, Dec ${userContext.plate_solve.center_dec}
- FOV: ${userContext.plate_solve.field_of_view}
- Identified objects:
${objectList}

ARCHIVAL PLATE (${plateYear}, ~${baseline} year baseline):
- Plate: ${plateMetadata.plate_num || plateMetadata.plate_id}
- Telescope: ${plateMetadata.telescope || 'Unknown'}
- Center: RA ${plateMetadata.ra_icrs}°, Dec ${plateMetadata.dec_icrs}°
- FOV: ${plateMetadata.fov1 ? parseFloat(plateMetadata.fov1).toFixed(1) + '°' : 'unknown'}${plateMetadata.fov2 ? ' x ' + parseFloat(plateMetadata.fov2).toFixed(1) + '°' : ''}
- Exposure: ${plateMetadata.exptime || 'unknown'}s

Compare these two images and report any genuine anomalies. The first image is the modern observation, the second is the archival plate (may be inverted/negative).

FILTERING RULES:
${plateYear && parseInt(plateYear) < 1957 ? `- This plate is from ${plateYear}, BEFORE Sputnik (1957). There were ZERO artificial satellites or debris in orbit.
- ANY satellite trail or debris streak in the MODERN image is routine contamination from today's 10,000+ active satellites.
- Do NOT report modern satellite trails as anomalies when comparing against pre-1957 plates. This is trivially expected.
- Only report anomalies involving ASTRONOMICAL objects (stars, galaxies, nebulae appearing/vanishing/changing).` : ''}
- A feature must be genuinely scientifically surprising to be marked HIGH significance.
- Differences in limiting magnitude, resolution, or sensitivity between epochs are NOT anomalies.
- If you find ZERO genuine anomalies, return an empty anomalies array. That is a valid and common result.`;

  const parts: any[] = [
    { inlineData: { mimeType: "image/jpeg", data: base64UserImage.split(',')[1] } },
    { text: userPrompt }
  ];

  // Try to fetch and include the archival plate image
  try {
    const plateRes = await fetch(archivalPreviewUrl);
    if (plateRes.ok) {
      const plateBuffer = await plateRes.arrayBuffer();
      const plateBase64 = btoa(String.fromCharCode(...new Uint8Array(plateBuffer)));
      parts.splice(1, 0, { inlineData: { mimeType: "image/png", data: plateBase64 } });
    }
  } catch {
    // If we can't fetch the plate image, proceed with text-only comparison
  }

  const archivalResponseSchema = {
      type: Type.OBJECT,
      properties: {
        anomalies: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              type: { type: Type.STRING },
              description: { type: Type.STRING },
              significance: { type: Type.STRING },
              possible_explanations: { type: Type.ARRAY, items: { type: Type.STRING } }
            },
            required: ["type", "description", "significance", "possible_explanations"]
          }
        },
        summary: { type: Type.STRING },
        plate_assessment: { type: Type.STRING }
      },
      required: ["anomalies", "summary", "plate_assessment"]
  };

  let result;
  try {
    result = await ai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: [{ parts }],
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: archivalResponseSchema,
        tools: [{ googleSearch: {} }],
      }
    });
  } catch {
    // Retry without Google Search if it fails
    result = await ai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: [{ parts }],
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: archivalResponseSchema,
      }
    });
  }

  try {
    let cleaned = cleanResponseText(result.text || '{}');
    let parsed: ArchivalCrossAnalysis;

    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // Google Search grounding can corrupt JSON — retry without it
      const retryResult = await ai.models.generateContent({
        model: 'gemini-3-pro-preview',
        contents: [{ parts }],
        config: {
          systemInstruction,
          responseMimeType: "application/json",
          responseSchema: archivalResponseSchema,
        }
      });
      cleaned = cleanResponseText(retryResult.text || '{}');
      parsed = JSON.parse(cleaned);
    }

    // POST-PROCESSING: Filter false positives
    const plateYear = plateMetadata.date_orig ? parseInt(plateMetadata.date_orig.substring(0, 4)) : 0;
    const isPreSputnik = plateYear > 0 && plateYear < 1957;

    if (parsed.anomalies && Array.isArray(parsed.anomalies)) {
      parsed.anomalies = parsed.anomalies.map(a => {
        const desc = (a.description || '').toLowerCase();
        const isSatelliteTrail = desc.includes('satellite') || desc.includes('debris') ||
          desc.includes('trail') || desc.includes('streak') || desc.includes('tumbling');
        const isModernOnlyFeature = desc.includes('absent') && (desc.includes('archival') || desc.includes('historical'));

        // Pre-Sputnik plates: any modern satellite/debris trail is trivially expected, not anomalous
        if (isPreSputnik && isSatelliteTrail && isModernOnlyFeature) {
          return {
            ...a,
            significance: 'low' as const,
            description: a.description + ' (Note: This is expected — the archival plate predates the space age. Modern satellite/debris trails are routine contamination, not true anomalies.)',
            possible_explanations: [
              'Modern satellite trail (Starlink, ISS, or other active satellite)',
              'Space debris from post-1957 space operations',
              ...(a.possible_explanations || []),
            ],
          };
        }
        return a;
      });
    }

    return parsed;
  } catch {
    return {
      anomalies: [],
      summary: result.text || 'Cross-analysis could not be completed.',
      plate_assessment: 'Unable to parse structured response.',
    };
  }
};

export const askAstronomer = async (
  message: string,
  base64Image: string,
  context: IdentificationResult,
  history: { role: 'user' | 'model'; text: string }[]
): Promise<string> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const objectList = (context.identifications || []).map(id => {
    const streakNote = id.streak_info ? ` [STREAK: ${id.streak_info.orbit_regime || 'unknown'} orbit, SNR~${id.streak_info.snr_estimate || '?'}]` : '';
    return `- ${id.primary_name} (${id.object_type})${streakNote}`;
  }).join('\n');

  const neoContext = (context.neos || []).filter(n => n.in_field).map(n =>
    `- ${n.fullname}: ${n.dist} AU, RA=${n.ra}°, Dec=${n.dec}°, V=${n.magnitude_v || '?'}`
  ).join('\n');

  const systemInstruction = `You are an expert astronomer with deep knowledge spanning:
- Classical astrometry and plate solving (WCS solutions, gnomonic projection, GAIA reference frames)
- Transient phenomena and multi-epoch analysis (VASCO methodology, FAST transients)
- Space debris detection and characterization (per Rachith, Hellmich & Kneib 2025)
- Near-Earth object dynamics (JPL Horizons ephemeris, close approach geometry)
- Photometric analysis (Moffat PSF profiles, aperture photometry, light curve extraction)

You have access to the user's plate-solved image and full analysis data.

CONTEXT DATA:
- Field of View: ${context.plate_solve.field_of_view}
- Center: RA ${context.plate_solve.center_ra}, Dec ${context.plate_solve.center_dec}
- Constellation: ${context.plate_solve.constellation || 'Unknown'}
- Plate Scale: ${context.plate_solve.plate_scale}
- Objects identified:
${objectList}
${neoContext ? `- NEOs confirmed in field:\n${neoContext}` : ''}
- Analysis summary: ${context.summary}

DOMAIN EXPERTISE (apply when relevant):
- **Streak/Trail Analysis**: Satellite trails appear as straight lines. LEO objects (~300-2000km) cross
  a wide-field detector in seconds, producing bright short streaks. GEO objects (~36,000km) produce
  very slow, faint trails. Brightness variations along a streak indicate tumbling (extractable via
  Fourier analysis of the intensity profile). Debris as small as 5cm in LEO can be detected.
- **Photometric Principles**: SNR = naper / sqrt(naper + nsky·p + p·σR²). Rectangular aperture
  photometry along streaks yields light curves. Moffat profile (β≈2.5) models the PSF.
  GAIA DR2/DR3 reference stars enable absolute calibration to ~0.01 mag.
- **Orbit Estimation**: Angular velocity determines orbit altitude. For circular orbits:
  v = w/τ where τ = D_telescope/v_wind. Then h = (μ⊕/(v·θ)²)^(1/3) - R⊕.
- **Multi-epoch Analysis**: Comparing modern vs archival plates can reveal vanished/appeared objects,
  proper motion, and variable sources. Historical photographic plates (APPLAUSE archive) have different
  sensitivity curves and are typically negatives (bright stars = dark spots).
- **NEO Detection**: When asteroids are confirmed in the field of view via Horizons ephemeris,
  they may appear as short trails or point sources depending on their angular velocity and exposure time.

RESPONSE STYLE:
- Use clear paragraph structure with line breaks between sections
- Lead with the direct answer, then supporting detail
- Use **bold** for object names, key terms, and important values
- Use bullet points for lists
- When discussing anomalies or detections, clearly state significance level
- Reference specific catalog designations and coordinates when relevant
- Keep responses authoritative but accessible — explain jargon on first use
- Use Google Search to verify facts when the user asks about specific objects`;

  const historyParts: any[] = history.map((h, i) => {
    const parts: any[] = [{ text: h.text }];
    if (i === 0 && h.role === 'user') parts.unshift({ inlineData: { mimeType: "image/jpeg", data: base64Image.split(',')[1] } });
    return { role: h.role, parts: parts };
  });

  const chat = ai.chats.create({
    model: 'gemini-3-pro-preview',
    config: {
      systemInstruction,
      tools: [{ googleSearch: {} }],
    },
    history: historyParts
  });
  const msgParts: any[] = [{ text: message }];
  if (history.length === 0) msgParts.unshift({ inlineData: { mimeType: "image/jpeg", data: base64Image.split(',')[1] } });

  const result = await chat.sendMessage({ message: msgParts });
  return result.text;
};
