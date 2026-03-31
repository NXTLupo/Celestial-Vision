/**
 * Deterministic Vector Map Renderer
 *
 * Extracts actual star positions from the source photo by scanning for bright
 * pixels, then renders them as clean dots on a white background. Cataloged
 * objects (galaxies, nebulae) from Astrometry.net annotations get distinct shapes.
 *
 * This produces a star chart that matches the original photo 1:1 — every dot
 * corresponds to a real bright source at its exact pixel position.
 *
 * Output: white background, black dots/shapes. CSS `invert` in the UI
 * transforms this to the dark theme aesthetic (black bg, white dots).
 */

import { AstrometryAnnotation, Identification } from '../types';

interface StarSource {
  x: number;
  y: number;
  brightness: number; // 0-1 normalized
  radius: number;     // display radius in pixels
}

/**
 * Extract bright sources (stars) from an image by scanning pixel brightness.
 * Uses adaptive thresholding relative to the image's brightness distribution.
 */
function extractStarsFromImage(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): StarSource[] {
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  // Step 1: Compute brightness histogram to find adaptive threshold
  const step = Math.max(1, Math.floor(Math.sqrt(width * height) / 400));
  const brightnesses: number[] = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const idx = (y * width + x) * 4;
      const brightness = (data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114) / 255;
      brightnesses.push(brightness);
    }
  }
  brightnesses.sort((a, b) => a - b);

  // Aggressive threshold: only the top 0.5% brightest pixels = real stars
  // This produces a clean, sparse chart instead of a noisy reproduction
  const thresholdIdx = Math.floor(brightnesses.length * 0.995);
  const threshold = Math.max(0.25, brightnesses[thresholdIdx] || 0.5);

  // Step 2: Scan with large grid cells to keep chart sparse and readable
  // Each cell picks only the single brightest pixel — prevents clustering
  const cellSize = Math.max(8, Math.floor(Math.min(width, height) / 80));
  const stars: StarSource[] = [];

  for (let gy = 0; gy < height; gy += cellSize) {
    for (let gx = 0; gx < width; gx += cellSize) {
      let maxBrightness = 0;
      let maxX = gx;
      let maxY = gy;

      const cellEndY = Math.min(gy + cellSize, height);
      const cellEndX = Math.min(gx + cellSize, width);

      for (let y = gy; y < cellEndY; y++) {
        for (let x = gx; x < cellEndX; x++) {
          const idx = (y * width + x) * 4;
          const b = (data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114) / 255;
          if (b > maxBrightness) {
            maxBrightness = b;
            maxX = x;
            maxY = y;
          }
        }
      }

      if (maxBrightness >= threshold) {
        const normalizedBrightness = (maxBrightness - threshold) / (1 - threshold);
        // Larger dot range for clean visibility: 2-8px radius
        const radius = 2 + normalizedBrightness * 6;

        stars.push({
          x: maxX,
          y: maxY,
          brightness: maxBrightness,
          radius,
        });
      }
    }
  }

  // Cap total stars for readability — keep only the brightest
  const MAX_STARS = 150;
  if (stars.length > MAX_STARS) {
    stars.sort((a, b) => b.brightness - a.brightness);
    stars.length = MAX_STARS;
  }

  return stars;
}

/**
 * Render a deterministic vector annotation map by extracting stars from the
 * source photo and drawing them as clean dots. Cataloged objects get distinct
 * shapes (ellipses for galaxies, circles for nebulae, etc.).
 *
 * @param sourceImage  The original photo as a base64 data URL
 * @param annotations  WCS-projected annotations from Astrometry.net + Gemini merge
 * @param identifications  Gemini identifications (for object_type → shape mapping)
 * @param imgWidth   Original image width in pixels
 * @param imgHeight  Original image height in pixels
 * @returns Promise<data:image/png;base64,...> or null
 */
export async function renderDeterministicVectorMap(
  sourceImage: string,
  annotations: AstrometryAnnotation[],
  identifications: Identification[],
  imgWidth: number,
  imgHeight: number
): Promise<string | null> {
  // Load the source image to extract star positions
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = reject;
    el.src = sourceImage;
  });

  // Create a working canvas with the source image
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = imgWidth;
  srcCanvas.height = imgHeight;
  const srcCtx = srcCanvas.getContext('2d');
  if (!srcCtx) return null;
  srcCtx.drawImage(img, 0, 0, imgWidth, imgHeight);

  // Extract star positions from the actual photo
  const stars = extractStarsFromImage(srcCtx, imgWidth, imgHeight);

  // Create the output canvas
  const canvas = document.createElement('canvas');
  canvas.width = imgWidth;
  canvas.height = imgHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // White background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, imgWidth, imgHeight);

  // Draw extracted stars as black dots
  ctx.fillStyle = '#000000';
  for (const star of stars) {
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
    ctx.fill();
  }

  // Overlay cataloged objects with distinct shapes
  if (annotations && annotations.length > 0) {
    const typeMap = new Map<string, string>();
    for (const id of identifications) {
      if (id.primary_name && id.object_type) {
        typeMap.set(id.primary_name.toLowerCase(), id.object_type.toLowerCase());
      }
    }

    const getObjType = (names: string[]): string => {
      for (const name of names) {
        const t = typeMap.get(name.toLowerCase());
        if (t) return t;
      }
      return '';
    };

    for (const anno of annotations) {
      const x = anno.pixelx;
      const y = anno.pixely;
      if (x < 0 || x > imgWidth || y < 0 || y > imgHeight) continue;

      const objType = getObjType(anno.names) || (anno.type || '').toLowerCase();
      const baseRadius = Math.max(4, Math.min(anno.radius || 10, 50));
      const r = baseRadius * 0.5;

      ctx.fillStyle = '#000000';
      ctx.strokeStyle = '#000000';

      if (objType.includes('galaxy')) {
        // Clear area first so the shape is crisp, then draw ellipse
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.ellipse(x, y, r * 2, r * 1.2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#000000';
        ctx.beginPath();
        ctx.ellipse(x, y, r * 2, r * 1.2, 0, 0, Math.PI * 2);
        ctx.fill();
      } else if (objType.includes('nebula')) {
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, r * 2, 0, Math.PI * 2);
        ctx.stroke();
      } else if (objType.includes('cluster')) {
        // Larger dot for cluster center
        ctx.beginPath();
        ctx.arc(x, y, r * 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
      // Stars from annotations are already drawn by the star extraction pass
    }
  }

  return canvas.toDataURL('image/png');
}
