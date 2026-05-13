
import { PlateSolveMetadata, AstrometryAnnotation } from "../types";

/**
 * Astrometry.net Real API Integration
 * Using a CORS Proxy to bypass browser security restrictions.
 */

const getProxiedUrl = (endpoint: string) => {
  return `/proxy/astrometry/api/${endpoint}`;
};

const getAnnotatedImageUrl = (jobId: number) => {
  return `/proxy/astrometry/annotated_display/${jobId}`;
};

// API key must be provided via ASTROMETRY_API_KEY env var (see .env.example)

const base64ToBlob = (base64: string): Blob => {
  const parts = base64.split(';base64,');
  const contentType = parts[0]?.split(':')[1] || 'image/jpeg';
  const raw = window.atob(parts[1]);
  const rawLength = raw.length;
  const uInt8Array = new Uint8Array(rawLength);
  for (let i = 0; i < rawLength; ++i) {
    uInt8Array[i] = raw.charCodeAt(i);
  }
  return new Blob([uInt8Array], { type: contentType });
};

// Returns object with data and dimensions
const downscaleImage = (base64: string, maxWidth = 1800): Promise<{data: string, width: number, height: number}> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let width = img.width;
      let height = img.height;
      
      if (width <= maxWidth && height <= maxWidth) {
        resolve({ data: base64, width, height });
        return;
      }

      if (width > height) {
        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }
      } else {
        if (height > maxWidth) {
          width = Math.round((width * maxWidth) / height);
          height = maxWidth;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          resolve({ data: canvas.toDataURL('image/jpeg', 0.85), width, height });
      } else {
          resolve({ data: base64, width, height });
      }
    };
    img.onerror = () => resolve({ data: base64, width: 0, height: 0 }); // Fallback
    img.src = base64;
  });
};

const safeJsonParse = async (response: Response) => {
  if (!response.ok) {
     throw new Error(`HTTP Error ${response.status}`);
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON response: ${text.substring(0, 50)}...`);
  }
};

const fetchWithTimeout = async (url: string, options: RequestInit = {}, timeout = 15000) => {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
};

export const solveAstrometry = async (
  base64Image: string, 
  onLog: (msg: string) => void
): Promise<PlateSolveMetadata | null> => {
  const apiKey = (process.env as any).ASTROMETRY_API_KEY;

  if (!apiKey) {
    onLog("[ASTROMETRY] API Key missing. Set ASTROMETRY_API_KEY in .env.local (get a free key at nova.astrometry.net).");
    return null;
  }

  try {
    onLog("[ASTROMETRY] Initializing Physics Engine (Astrometry.net)...");
    
    // 1. Login
    const loginParams = new URLSearchParams();
    loginParams.append('request-json', JSON.stringify({ apikey: apiKey }));

    const loginRes = await fetchWithTimeout(getProxiedUrl('login'), {
      method: 'POST',
      body: loginParams
    }, 20000); 
    
    const loginData = await safeJsonParse(loginRes);
    if (loginData.status !== 'success') {
       onLog(`[ASTROMETRY] Login failed: ${loginData.errormessage || 'Unknown error'}`);
       return null; 
    }
    const session = loginData.session;

    // 2. Pre-processing & Upload
    onLog("[ASTROMETRY] Optimizing sensor data for uplink...");
    const { data: optimizedBase64, width: imgWidth, height: imgHeight } = await downscaleImage(base64Image);
    const blob = base64ToBlob(optimizedBase64);
    
    onLog(`[ASTROMETRY] Uploading ${(blob.size / 1024).toFixed(0)}KB to solver node...`);

    const formData = new FormData();
    formData.append('request-json', JSON.stringify({
      session,
      allow_commercial_use: 'd',
      allow_modifications: 'd',
      publicly_visible: 'y',
    }));
    formData.append('file', blob, 'image.jpg');

    // Retry upload up to 3 times on server errors (Astrometry.net 500s are transient)
    let uploadData: any = null;
    for (let uploadAttempt = 0; uploadAttempt < 3; uploadAttempt++) {
      try {
        const uploadRes = await fetchWithTimeout(getProxiedUrl('upload'), {
          method: 'POST',
          body: formData
        }, 90000);

        if (uploadRes.status === 500 || uploadRes.status === 502 || uploadRes.status === 503) {
          onLog(`[ASTROMETRY] Server error (${uploadRes.status}), retrying... (${uploadAttempt + 1}/3)`);
          await new Promise(r => setTimeout(r, 3000 * (uploadAttempt + 1)));
          continue;
        }

        uploadData = await safeJsonParse(uploadRes);
        break;
      } catch (e: any) {
        if (uploadAttempt < 2) {
          onLog(`[ASTROMETRY] Upload failed (${e.message}), retrying... (${uploadAttempt + 1}/3)`);
          await new Promise(r => setTimeout(r, 3000 * (uploadAttempt + 1)));
        } else {
          throw e;
        }
      }
    }

    if (!uploadData || uploadData.status !== 'success') {
      onLog(`[ASTROMETRY] Upload rejected: ${uploadData?.errormessage || 'Server unavailable after 3 attempts'}`);
      return null;
    }
    const subId = uploadData.subid;

    onLog(`[ASTROMETRY] Submission #${subId} accepted. Queued.`);
    
    let jobId: number | null = null;
    let attempts = 0;
    
    // 3. Polling for Job ID
    // Increased loops to 60 * 3s = 180s
    while (!jobId && attempts < 60) { 
      await new Promise(r => setTimeout(r, 3000));
      try {
        const subRes = await fetchWithTimeout(getProxiedUrl(`submissions/${subId}`));
        const subData = await safeJsonParse(subRes);
        
        if (subData.jobs && subData.jobs.length > 0 && subData.jobs[0] !== null) {
          jobId = subData.jobs[0];
          onLog(`[ASTROMETRY] Worker assigned. Job ID: ${jobId}`);
        } else if (subData.job_calibrations && subData.job_calibrations.length > 0) {
          jobId = subData.job_calibrations[0][0]; 
          onLog(`[ASTROMETRY] Job ID inferred from calibration: ${jobId}`);
        } else if (subData.processing_started) {
          if (attempts % 5 === 0) onLog(`[ASTROMETRY] Processing... (Queue Position: ${subData.user_images_in_queue || 'Unknown'})`);
        } else {
          if (attempts % 5 === 0) onLog("[ASTROMETRY] Waiting in global queue...");
        }
      } catch (e) {
        console.warn("Polling error (ignoring):", e);
      }
      attempts++;
    }

    if (!jobId) {
        onLog("[ASTROMETRY] Queue timeout. Solver overloaded.");
        return null;
    }
    
    let calibration: any = null;
    let isFinished = false;
    attempts = 0;
    
    // 4. Polling for Result
    // Increased loops to 90 * 2s = 180s
    while (!isFinished && attempts < 90) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const statusRes = await fetchWithTimeout(getProxiedUrl(`jobs/${jobId}/info`));
        const statusData = await safeJsonParse(statusRes);
        
        if (statusData.status === 'success') {
          const calRes = await fetchWithTimeout(getProxiedUrl(`jobs/${jobId}/calibration`));
          calibration = await safeJsonParse(calRes);
          isFinished = true;
        } else if (statusData.status === 'failure') {
          onLog("[ASTROMETRY] Plate-solve failed. Field could not be resolved.");
          return null;
        } else {
          if (attempts % 10 === 0) onLog(`[ASTROMETRY] Calculating geometry...`);
        }
      } catch (e) {
        // Ignore transient network errors during polling
      }
      attempts++;
    }

    if (!calibration) {
        onLog("[ASTROMETRY] Solver timed out waiting for calibration.");
        return null;
    }

    onLog("[ASTROMETRY] WCS Calibration SUCCESS.");

    // 5. Fetch Annotations
    let annotations: AstrometryAnnotation[] = [];
    try {
      onLog("[ASTROMETRY] Downloading object catalog...");
      let annoAttempts = 0;
      while (annotations.length === 0 && annoAttempts < 5) {
        const annoRes = await fetchWithTimeout(getProxiedUrl(`jobs/${jobId}/annotations`), {}, 8000);
        const annoData = await safeJsonParse(annoRes);
        if (annoData && Array.isArray(annoData.annotations)) {
          annotations = annoData.annotations;
        } else {
          await new Promise(r => setTimeout(r, 1500));
        }
        annoAttempts++;
      }
      onLog(`[ASTROMETRY] Retrieved ${annotations.length} cataloged objects.`);
    } catch (e) {
      onLog("[ASTROMETRY] Warning: Annotation stream interrupted.");
    }

    // 6. Fetch Tags
    let constellation = "Deep Sky Field";
    try {
        const tagRes = await fetchWithTimeout(getProxiedUrl(`jobs/${jobId}/tags`), {}, 5000);
        const tagData = await safeJsonParse(tagRes);
        const found = tagData.tags?.find((t: string) => t.length > 2);
        if (found) constellation = found;
    } catch(e) { /* Ignore tag errors */ }

    // 7. Get Annotated Image URL
    const annotatedImageUrl = getAnnotatedImageUrl(jobId!);

    return {
      job_id: jobId!,
      annotated_image_url: annotatedImageUrl,
      center_ra: `${calibration.ra.toFixed(4)}°`,
      center_dec: `${calibration.dec.toFixed(4)}°`,
      plate_scale: `${calibration.pixscale.toFixed(3)} arcsec/pixel`,
      wcs_quality: 100,
      field_of_view: `${calibration.radius.toFixed(2)}° FOV`,
      constellation,
      orientation: calibration.orientation,
      pixscale: calibration.pixscale,
      annotations,
      image_width: imgWidth,
      image_height: imgHeight
    };

  } catch (error: any) {
    console.error(error);
    onLog(`[ASTROMETRY] Network Error: ${error.message}`);
    return null;
  }
};
