
import { GoogleGenAI, Type, GenerateContentResponse, Chat } from "@google/genai";
import { IdentificationResult, PlateSolveMetadata, NeoObject, CometData, HorizonsData } from "../types";

const cleanResponseText = (text: string): string => {
  let clean = text.trim();
  if (clean.startsWith('```json')) clean = clean.slice(7);
  if (clean.startsWith('```')) clean = clean.slice(3);
  if (clean.endsWith('```')) clean = clean.slice(0, -3);
  return clean.trim();
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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

const getBestAspectRatio = (width: number, height: number): "1:1" | "3:4" | "4:3" | "9:16" | "16:9" => {
  if (!width || !height) return "1:1";
  const ratio = width / height;
  
  const supported: { ratio: number, str: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" }[] = [
    { ratio: 1.0, str: "1:1" },
    { ratio: 3/4, str: "3:4" },
    { ratio: 4/3, str: "4:3" },
    { ratio: 9/16, str: "9:16" },
    { ratio: 16/9, str: "16:9" }
  ];

  const closest = supported.reduce((prev, curr) => {
    return (Math.abs(curr.ratio - ratio) < Math.abs(prev.ratio - ratio) ? curr : prev);
  });
  return closest.str;
};

const getImageDimensions = (base64: string): Promise<{width: number, height: number}> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.width, height: img.height });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = base64;
  });
};

export const generateScientificIllustration = async (
  base64Image: string,
  analysisContext: IdentificationResult,
  onThought: (text: string) => void
): Promise<string | null> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  onThought("Generating precise vector annotation map (Nano Banana Pro)...");
  const width = analysisContext.plate_solve?.image_width || 1000;
  const height = analysisContext.plate_solve?.image_height || 1000;
  const aspectRatio = getBestAspectRatio(width, height);

  onThought(`Optimizing vector map for aspect ratio: ${aspectRatio}`);

  const rawAnnotations = analysisContext.plate_solve?.annotations || [];
  const knownObjects = rawAnnotations.length > 0 
    ? rawAnnotations.flatMap(a => a.names).slice(0, 15).join(', ')
    : "Standard Star Field";

  try {
    const prompt = `
      Create a high-precision, scientific vector illustration of this astronomical field.
      CONTEXT: The image contains these verified objects: ${knownObjects}.
      STRICT PROHIBITIONS:
      1. **ABSOLUTELY NO TEXT**. No labels, numbers, coordinates.
      2. **NO SYMBOLS**. No crosshairs, arrows, grid lines.
      3. Clean INVERTED MAP (Black stars on White background).
      STYLE GUIDE: Technical Astronomy Chart (inverted). Fine Black vector lines. Solid Black circles.
      ALIGNMENT: Map MUST perfectly align with input image geometry. Do not crop.
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-3-pro-image-preview',
      contents: {
        parts: [
          { inlineData: { mimeType: "image/jpeg", data: base64Image.split(',')[1] } },
          { text: prompt },
        ],
      },
      config: {
        imageConfig: { aspectRatio: aspectRatio, imageSize: "1K" }
      },
    });

    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        return `data:image/png;base64,${part.inlineData.data}`;
      }
    }
    return null;
  } catch (error: any) {
    console.error("Image Generation Error:", error);
    onThought(`Vector Map Generation Failed: ${error.message}`);
    return null;
  }
};

export const analyzeCelestialImageStream = async (
  base64Image: string, 
  exifData: any,
  astrometry: PlateSolveMetadata | null,
  neos: NeoObject[],
  cometData: CometData | null,
  userTargetInput: string,
  horizonsData: HorizonsData | null,
  onThought: (text: string) => void
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
    
    const neoContext = neos.length > 0 
      ? neos.map(n => `- ${n.fullname}: ${n.dist} AU`).join('\n')
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
            ? `**GEOMETRIC CONFIRMATION**: Based on Plate Solving, this object is at Pixel coordinates X=${calculatedTargetPixel.x.toFixed(0)}, Y=${calculatedTargetPixel.y.toFixed(0)}. YOU MUST REPORT THIS LOCATION.`
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

    const forensicProtocol = `
      ROLE: Forensic Astronomer.
      
      PRIME DIRECTIVE 1: ACCURACY VIA MATH.
      - If you have RA/Dec coordinates (from Horizons or Google Search), prioritize them over visual guesses.
      - If the image is Plate Solved, the coordinates are absolute.
      
      PRIME DIRECTIVE 2: VISUAL CONFIRMATION.
      - For named objects (Comets, Messier Objects, Named Stars), search for a 'reference_image_url'.
      - PREFER: Wikimedia Commons, NASA, ESA, or reputable observatory image URLs.
      - DO NOT invent URLs. If none found, leave blank.
      
      TARGET: ${activeTargetName}
      - If this is an INTERSTELLAR OBJECT (e.g. 3I/ATLAS), it is POINT-LIKE (Stellar). It looks like a star. 
      - Do not dismiss "stars" at the predicted location.
      
      OUTPUT FORMAT: JSON.
      For the target object, if you found coordinates via search, put them in the 'ra' and 'dec' fields.
    `;

    const commonPromptData = `Obs Date: ${exifData.timestamp}\nTarget Data:\n${cometContext}`;

    if (isVisionMode) {
      systemInstruction = `${forensicProtocol}\nTASK: Blind Visual Inspection.`;
      userPrompt = `Analyze this image for ${activeTargetName}. ${commonPromptData}`;
      parts.push({ inlineData: { mimeType: "image/jpeg", data: base64Image.split(',')[1] } });
      parts.push({ text: userPrompt });
    } else {
      const annotationsList = (astrometry!.annotations || []).map(a => `NAME: "${a.names.join('/')}"`).join('\n');
      systemInstruction = `${forensicProtocol}\nTASK: Cross-Reference WCS Geometry.`;
      userPrompt = `
        ASTROMETRY DATA: ${annotationsList || "None"}
        CENTER: ${astrometry!.center_ra}, ${astrometry!.center_dec}
        FOV: ${astrometry!.field_of_view}
        
        ${commonPromptData}
        
        ACTION:
        1. If telemetry is missing, SEARCH for RA/Dec of ${activeTargetName} on this date.
        2. Identify if that RA/Dec falls within the image FOV.
        3. Search for a reference photo of the main object to show the user what it *should* look like.
        4. Return the identification.
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

    const response: GenerateContentResponse = await withRetry(() => apiCall);
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
      throw new Error("Failed to parse JSON.");
    }
    
    if (searchSources.length > 0) result.sources = [...(result.sources || []), ...searchSources];

    // --- POST-PROCESSING: DETERMINISTIC WCS PROJECTION OVERRIDE ---
    // If we have valid Plate Solving, we IGNORE the LLM's pixel guesses for the target
    // and replace them with mathematical projections derived from the RA/Dec the LLM (or Horizons) found.
    
    if (astrometry && wcsCenterRa !== null && wcsCenterDec !== null && wcsScale) {
        
        result.identifications = result.identifications.map((id: any) => {
            const name = id.primary_name?.toLowerCase() || "";
            const target = activeTargetName.toLowerCase();
            
            // Is this the target?
            const isTarget = target && (name.includes(target) || target.includes(name));
            
            // Do we have RA/Dec?
            const objRa = parseCoordinateToDegrees(id.ra);
            const objDec = parseCoordinateToDegrees(id.dec);

            if (isTarget && objRa !== null && objDec !== null) {
                // Perform Math
                const projected = projectWorldToPixel(
                    objRa, objDec,
                    wcsCenterRa!, wcsCenterDec!,
                    wcsScale!, wcsOrientation,
                    astrometry.image_width || originalDims.width,
                    astrometry.image_height || originalDims.height
                );

                if (projected) {
                    onThought(`[MATH OVERRIDE] Correcting ${id.primary_name} position to X:${projected.x.toFixed(0)}, Y:${projected.y.toFixed(0)}`);
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
        if (horizonsData && calculatedTargetPixel) {
            const alreadyListed = result.identifications.some((id: any) => 
                id.primary_name.toLowerCase().includes(activeTargetName.toLowerCase())
            );
            
            if (!alreadyListed) {
                onThought(`[INJECTION] Adding missed target ${activeTargetName} at projected coordinates.`);
                result.identifications.push({
                    object_type: "Comet (Projected)",
                    primary_name: horizonsData.id,
                    ra: horizonsData.ra,
                    dec: horizonsData.dec,
                    confidence: 1.0,
                    evidence: ["JPL Horizons Telemetry", "Geometric WCS Projection"],
                    recommended_followup: "Verify stellar point source at coordinates.",
                    pixel_coords: calculatedTargetPixel
                });
            }
        }
    }

    // --- VISUAL LAYER MERGING ---
    const existingAnnotations = astrometry?.annotations || result.plate_solve.annotations || [];
    const mergedAnnotations = [...existingAnnotations];
    
    // Scale Logic
    let scaleX = 1;
    let scaleY = 1;
    if (astrometry && astrometry.image_width && originalDims.width > 0) {
        scaleX = astrometry.image_width / originalDims.width;
        scaleY = astrometry.image_height! / originalDims.height;
    }
    
    if (result.identifications && Array.isArray(result.identifications)) {
        result.identifications.forEach((id: any) => {
            if (id.pixel_coords && typeof id.pixel_coords.x === 'number') {
                // Ensure coordinates are within reasonable bounds before adding
                // Note: projectWorldToPixel returns coordinates in the 'astrometry' dimension space usually
                // But Gemini might return original image space if we aren't careful.
                // Our WCS math used `astrometry.image_width`, so the result is already in astrometry space.
                // However, LLM guesses might be in original space. 
                // We'll assume the MATH override is correct (Astrometry Space).
                // If it wasn't overridden, it's ambiguous.
                
                // Let's assume Pixel Coords are in the same space as the 'width' passed to the prompt/math.
                const x = id.pixel_coords.x;
                const y = id.pixel_coords.y;

                // Simple duplicate check
                const isDuplicate = mergedAnnotations.some((a: any) => {
                    const dx = a.pixelx - x;
                    const dy = a.pixely - y;
                    return Math.sqrt(dx*dx + dy*dy) < 50; 
                });

                if (!isDuplicate) {
                    mergedAnnotations.push({
                        pixelx: x,
                        pixely: y,
                        radius: 20,
                        names: [id.primary_name],
                        type: id.object_type
                    });
                } else {
                     // Update existing label
                    const idx = mergedAnnotations.findIndex((a: any) => {
                         const dx = a.pixelx - x;
                         const dy = a.pixely - y;
                         return Math.sqrt(dx*dx + dy*dy) < 50;
                    });
                    if (idx !== -1 && !mergedAnnotations[idx].names.includes(id.primary_name)) {
                         mergedAnnotations[idx].names.unshift(id.primary_name);
                    }
                }
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

export const askAstronomer = async (
  message: string,
  base64Image: string,
  context: IdentificationResult,
  history: { role: 'user' | 'model'; text: string }[]
): Promise<string> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const objectList = (context.identifications || []).map(id => `- ${id.primary_name} (${id.object_type})`).join('\n');
  const systemInstruction = `Expert Astronomer. DATA: FOV ${context.plate_solve.field_of_view}. OBJECTS:\n${objectList}\nSUMMARY:${context.summary}`;
  
  const historyParts: any[] = history.map((h, i) => {
    const parts: any[] = [{ text: h.text }];
    if (i === 0 && h.role === 'user') parts.unshift({ inlineData: { mimeType: "image/jpeg", data: base64Image.split(',')[1] } });
    return { role: h.role, parts: parts };
  });

  const chat = ai.chats.create({ model: 'gemini-3-pro-preview', config: { systemInstruction }, history: historyParts });
  const msgParts: any[] = [{ text: message }];
  if (history.length === 0) msgParts.unshift({ inlineData: { mimeType: "image/jpeg", data: base64Image.split(',')[1] } });
  
  const result = await chat.sendMessage({ message: msgParts });
  return result.text;
};
