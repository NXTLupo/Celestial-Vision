
import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { ImageUploader } from './components/ImageUploader';
import { ResultsDashboard } from './components/ResultsDashboard';
import { ProcessingOverlay } from './components/ProcessingOverlay';
import { IdentificationResult, ProcessingState, ThoughtLog } from './types';
import { analyzeCelestialImageStream, preScangImage, detectStreaks, DetectedStreak } from './services/gemini';
import { solveAstrometry } from './services/astrometry';
import { fetchNearEarthObjects, enrichNeosWithEphemeris } from './services/nasa';
import { fetchCometData, getCometsByDate } from './services/cobs';
import { fetchHorizonsEphemeris } from './services/horizons';
import { identifySatellitesInField, matchStreaksToSatellites } from './services/satellites';
import { verifySatellitesWithSatChecker, findSatellitesViaSatChecker } from './services/satchecker';
import { resolveUnknownObjects } from './services/resolver';
import { queryProjectPluto, PlutoSatellite } from './services/pluto';

declare const EXIF: any;
declare const window: any;

const App: React.FC = () => {
  const [image, setImage] = useState<string | null>(null);
  const [rawFile, setRawFile] = useState<File | null>(null);
  const [results, setResults] = useState<IdentificationResult | null>(null);
  const [hasKey, setHasKey] = useState<boolean>(false);
  const [targetComet, setTargetComet] = useState<string>("");
  const [status, setStatus] = useState<ProcessingState>({
    step: 'idle',
    message: '',
    progress: 0,
    logs: []
  });

  useEffect(() => {
    const checkKey = async () => {
      if (window.aistudio?.hasSelectedApiKey) {
        const selected = await window.aistudio.hasSelectedApiKey();
        setHasKey(selected);
      } else {
        setHasKey(true);
      }
    };
    checkKey();
  }, []);

  const handleSelectKey = async () => {
    if (window.aistudio?.openSelectKey) {
      await window.aistudio.openSelectKey();
      setHasKey(true);
    }
  };

  const addLog = (message: string, type: ThoughtLog['type'] = 'info') => {
    const log: ThoughtLog = {
      timestamp: new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      message,
      type
    };
    setStatus(prev => ({ ...prev, logs: [log, ...prev.logs].slice(0, 100) }));
  };

  const handleImageUpload = async (file: File, target?: string, manualDate?: string) => {
    setRawFile(file);
    if (target) setTargetComet(target);
    
    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64 = e.target?.result as string;
      setImage(base64);
      processImage(base64, file, target, manualDate);
    };
    reader.readAsDataURL(file);
  };

  const extractExif = (file: File): Promise<any> => {
    return new Promise((resolve) => {
      const defaults = {
        instrument: "Standard Optical Array",
        timestamp: null as string | null, // null = no date found, MUST be provided by user or file metadata
        focalLength: "Unknown",
        fNumber: "f/--",
        iso: "Auto",
        location: { lat: null, lon: null }
      };

      const timeoutId = setTimeout(() => resolve(defaults), 5000);

      try {
        EXIF.getData(file, function(this: any) {
          clearTimeout(timeoutId);
          const allMetaData = EXIF.getAllTags(this);

          if (!allMetaData) {
            // Try file.lastModified as fallback before giving up
            if (file.lastModified) {
              defaults.timestamp = new Date(file.lastModified).toISOString().split('T')[0];
            }
            resolve(defaults);
            return;
          }

          const convertToDecimal = (gpsArr: any, ref: string) => {
            if (!gpsArr || !gpsArr[0]) return null;
            let decimal = gpsArr[0] + gpsArr[1]/60 + gpsArr[2]/3600;
            if (ref === 'S' || ref === 'W') decimal *= -1;
            return decimal;
          };

          // Try multiple EXIF date tags — different cameras/apps use different ones
          const rawDate = allMetaData.DateTimeOriginal
            || allMetaData.DateTimeDigitized
            || allMetaData.DateTime
            || allMetaData.GPSDateStamp;

          let formattedDate: string | null = null;
          if (rawDate) {
            const parts = rawDate.split(' ');
            if (parts[0]) {
              formattedDate = parts[0].replace(/:/g, '-');
            }
          }

          // Last resort: file modification date (better than today's date)
          if (!formattedDate && file.lastModified) {
            formattedDate = new Date(file.lastModified).toISOString().split('T')[0];
          }

          resolve({
            instrument: allMetaData.Model || "Standard Optical Array",
            timestamp: formattedDate,
            focalLength: allMetaData.FocalLength ? `${allMetaData.FocalLength}` : "Standard",
            fNumber: allMetaData.FNumber ? `f/${allMetaData.FNumber}` : "f/--",
            iso: allMetaData.ISOSpeedRatings ? `ISO ${allMetaData.ISOSpeedRatings}` : "Auto",
            location: {
              lat: convertToDecimal(allMetaData.GPSLatitude, allMetaData.GPSLatitudeRef),
              lon: convertToDecimal(allMetaData.GPSLongitude, allMetaData.GPSLongitudeRef)
            }
          });
        });
      } catch (e) {
        clearTimeout(timeoutId);
        // Even on error, try file.lastModified
        if (file.lastModified) {
          defaults.timestamp = new Date(file.lastModified).toISOString().split('T')[0];
        }
        resolve(defaults);
      }
    });
  };

  const processImage = async (base64: string, file: File, initialTarget?: string, manualDate?: string) => {
    let target = initialTarget; // Mutable — pre-scan may discover target from watermark
    try {
      setStatus(prev => ({ ...prev, step: 'ingesting', message: 'Extracting Optical Telemetry...', progress: 5 }));
      const exif = await extractExif(file);

      // Log where the date came from for debugging date mismatch issues
      addLog(`[EXIF] Raw timestamp from file: "${exif.timestamp || 'NONE'}" (source: ${exif.timestamp ? (exif.timestamp.includes(':') ? 'EXIF date tag' : 'file.lastModified fallback') : 'no date found'})`, 'info');
      if (file.lastModified) {
        addLog(`[EXIF] file.lastModified = ${new Date(file.lastModified).toISOString().split('T')[0]}`, 'info');
      }

      // Override if manual date provided by user in staging area
      if (manualDate) {
         exif.timestamp = manualDate;
         addLog(`[USER OVERRIDE] Analysis date set to ${manualDate} — this OVERRIDES all other date sources.`, 'info');
      }

      // If no date was extracted from EXIF and user didn't provide one,
      // use file modification date as last resort (already attempted in extractExif).
      // If still null, we have NO date — log a critical warning.
      if (!exif.timestamp) {
        addLog(`[CRITICAL] No observation date found in image metadata! Comet and NEO lookups will be inaccurate. Please set the observation date manually using the date field in the upload form.`, 'critical');
        // Use file modification date or today only as absolute last resort
        exif.timestamp = new Date().toISOString().split('T')[0];
        addLog(`[FALLBACK] Using ${exif.timestamp} as observation date — THIS MAY BE WRONG.`, 'warning');
      }

      // ══════════════════════════════════════════════════════════════
      // STAGE 0: VISUAL PRE-SCAN — Gemini examines image for watermarks,
      //   timestamps, target names, instrument info burned into the image.
      //   Fills in gaps left by EXIF extraction.
      // ══════════════════════════════════════════════════════════════
      setStatus(prev => ({ ...prev, message: 'Visual pre-scan for image metadata...', progress: 8 }));
      const preScan = await preScangImage(base64, (msg) => addLog(msg, 'info'));

      // Fill in EXIF gaps with pre-scan findings
      if (preScan.date && !exif.timestamp) {
        exif.timestamp = preScan.date;
        addLog(`[PRE-SCAN] Date recovered from image watermark: ${preScan.date}`, 'success');
      }
      if (preScan.date && exif.timestamp && !manualDate) {
        // If EXIF date exists but differs from watermark date, trust the watermark
        // (EXIF may be file-modified date, watermark is observation date)
        // BUT: only if the years are different or dates are far apart.
        // Gemini OCR can misread digits (e.g., "2026" → "2024"), so log clearly.
        const exifDate = exif.timestamp.split('T')[0]; // date portion only
        const scanDate = preScan.date.split('T')[0];
        if (exifDate !== scanDate) {
          addLog(`[PRE-SCAN] Watermark date (${scanDate}) differs from EXIF/file date (${exifDate}) — using watermark date. If wrong, use the date override field.`, 'info');
          exif.timestamp = scanDate;
        }
      }
      // When user explicitly set a manual date, NEVER let pre-scan override it
      if (manualDate && preScan.date && preScan.date !== manualDate) {
        addLog(`[PRE-SCAN] Watermark OCR read "${preScan.date}" but user override is "${manualDate}" — keeping user override.`, 'info');
      }
      if (preScan.instrument && exif.instrument === 'Standard Optical Array') {
        exif.instrument = preScan.instrument;
      }
      if (preScan.target && !target) {
        target = preScan.target;
        addLog(`[PRE-SCAN] Target object identified from image: "${target}"`, 'success');
      }
      if (preScan.location && !exif.location?.lat) {
        exif.locationName = preScan.location;
        addLog(`[PRE-SCAN] Observer location from image: "${preScan.location}" — attempting geocode...`, 'info');

        // Geocode the location name to lat/lon using OpenStreetMap Nominatim (free, no API key)
        try {
          const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(preScan.location)}&format=json&limit=1`, {
            headers: { 'User-Agent': 'CelestialVisionAI/2.0 (astrophotography research tool)' }
          });
          if (geoRes.ok) {
            const geoData = await geoRes.json();
            if (geoData.length > 0) {
              const lat = parseFloat(geoData[0].lat);
              const lon = parseFloat(geoData[0].lon);
              if (!isNaN(lat) && !isNaN(lon)) {
                exif.location = { lat, lon };
                addLog(`✓ [GEOCODE] "${preScan.location}" → ${lat.toFixed(4)}°N, ${lon.toFixed(4)}°E — satellite ID and ephemeris will use this location`, 'success');
              }
            } else {
              addLog(`⚠ [GEOCODE] Could not geocode "${preScan.location}" — satellite identification will use geocentric (less accurate)`, 'warning');
            }
          }
        } catch {
          addLog(`⚠ [GEOCODE] Geocoding failed — satellite identification will use geocentric (less accurate)`, 'warning');
        }
      }
      if (preScan.time) {
        // Combine date + time for more precise ephemeris
        if (exif.timestamp && !exif.timestamp.includes('T')) {
          exif.timestamp = `${exif.timestamp}T${preScan.time}:00`;
          addLog(`[PRE-SCAN] Observation time refined: ${exif.timestamp}`, 'info');
        }
      }
      if (preScan.exposure) {
        exif.exposure = preScan.exposure;
      }

      // Final check — if still no date after pre-scan + EXIF + manual
      if (!exif.timestamp) {
        addLog(`[CRITICAL] No observation date found in EXIF or image. Please set date manually.`, 'critical');
        exif.timestamp = new Date().toISOString().split('T')[0];
        addLog(`[FALLBACK] Using ${exif.timestamp} — THIS MAY BE WRONG.`, 'warning');
      }

      addLog(`[SYSTEM] Telemetry acquired: ${exif.instrument} @ ${exif.timestamp}`, 'success');
      if (exif.location?.lat && exif.location?.lon) {
        addLog(`[SYSTEM] Observer location: ${exif.location.lat.toFixed(4)}°, ${exif.location.lon.toFixed(4)}°`, 'info');
      } else if (exif.locationName) {
        addLog(`[SYSTEM] Observer location (from image): ${exif.locationName}`, 'info');
      } else {
        addLog('[SYSTEM] No GPS coordinates — using geocentric ephemeris.', 'info');
      }

      // ══════════════════════════════════════════════════════════════
      // STAGE 1: PLATE SOLVE + NEO FETCH (parallel — both independent)
      //   Plate solving gives us the EXACT sky coordinates of the image.
      //   NEO fetch uses only the date and doesn't need coordinates.
      // ══════════════════════════════════════════════════════════════
      setStatus(prev => ({ ...prev, step: 'analyzing', message: 'Plate Solving + Streak Detection + NEO Scan...', progress: 15 }));

      // Get image dimensions for streak detection (need actual pixels, not 0x0)
      const imgDims = await new Promise<{width: number, height: number}>((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.width, height: img.height });
        img.onerror = () => resolve({ width: 1000, height: 1000 });
        img.src = base64;
      });

      const astrometryPromise = solveAstrometry(base64, (msg) => addLog(msg, 'info'));
      const nasaPromise = fetchNearEarthObjects(exif.timestamp, (msg) => addLog(msg, 'info'));
      // Dedicated streak detection — runs in parallel, separate Gemini call focused ONLY on linear features
      const streakPromise = detectStreaks(base64, imgDims.width, imgDims.height, (msg) => addLog(msg, 'info'));

      // User-targeted comet (only if user typed a specific name)
      const cometPromise = target ? fetchCometData(target, exif.timestamp, (msg) => addLog(msg, 'info')) : Promise.resolve(null);
      const horizonsPromise = target ? fetchHorizonsEphemeris(target, exif.timestamp, exif.location.lat, exif.location.lon, (msg) => addLog(msg, 'info')) : Promise.resolve(null);

      let [astrometryResult, neoResult, cometResult, horizonsResult, detectedStreaks] = await Promise.all([
          astrometryPromise,
          nasaPromise,
          cometPromise,
          horizonsPromise,
          streakPromise,
      ]);

      // ══════════════════════════════════════════════════════════════
      // PIPELINE DIAGNOSTICS — log every stage result for debugging
      // ══════════════════════════════════════════════════════════════
      addLog(`\n══════════ PIPELINE STAGE 1 RESULTS ══════════`, 'info');

      if (!astrometryResult) {
        addLog("⚠ [ASTROMETRY] FAILED — Plate solving failed or timed out. Satellite ID, NEO enrichment, and FOV checks will be SKIPPED.", 'warning');
      } else {
        addLog(`✓ [ASTROMETRY] WCS Solution: Quality=${astrometryResult.wcs_quality}%, Center=RA ${astrometryResult.center_ra} Dec ${astrometryResult.center_dec}, FOV=${astrometryResult.field_of_view}, ${(astrometryResult.annotations || []).length} catalog annotations`, 'success');
      }

      if (neoResult && neoResult.length > 0) {
        addLog(`✓ [NASA NeoWs] ${neoResult.length} near-Earth object(s) within 0.1 AU on ${exif.timestamp}`, 'success');
      } else {
        addLog(`· [NASA NeoWs] No near-Earth objects within 0.1 AU on this date`, 'info');
      }

      if (detectedStreaks && detectedStreaks.length > 0) {
        addLog(`✓ [STREAK DETECT] ${detectedStreaks.length} linear feature(s) detected in image`, 'success');
        detectedStreaks.forEach((s, i) => {
          addLog(`  Streak #${i + 1}: (${s.pixel_start_x},${s.pixel_start_y})→(${s.pixel_end_x},${s.pixel_end_y}), ${s.brightness}, ${s.description || 'no description'}`, 'info');
        });
      } else {
        addLog(`⚠ [STREAK DETECT] NO linear features detected — streak detection returned empty. If there IS a visible streak in the image, this is a detection failure. Satellite identification will still run via SGP4 but cannot be correlated to a specific trail.`, 'warning');
      }

      if (cometResult) {
        addLog(`✓ [COMET] Comet data loaded: ${cometResult.name || target}`, 'success');
      } else if (target) {
        addLog(`⚠ [COMET] User specified target "${target}" but COBS returned no data`, 'warning');
      } else {
        addLog(`· [COMET] No user-specified comet target`, 'info');
      }

      if (horizonsResult) {
        addLog(`✓ [HORIZONS] Ephemeris: RA=${horizonsResult.ra}, Dec=${horizonsResult.dec}, Mag=${horizonsResult.magnitude || '?'}`, 'success');
      } else if (target) {
        addLog(`⚠ [HORIZONS] No ephemeris data for "${target}"`, 'warning');
      }

      addLog(`· [TELEMETRY] Date=${exif.timestamp}, Location=${exif.location?.lat ? `${exif.location.lat.toFixed(4)},${exif.location.lon.toFixed(4)}` : 'NONE (geocentric)'}, Exposure=${exif.exposure || 'unknown'}, Image=${imgDims.width}x${imgDims.height}px`, 'info');
      addLog(`══════════════════════════════════════════════\n`, 'info');

      // ══════════════════════════════════════════════════════════════
      // STAGE 2: COMET SURVEY — uses plate-solved coordinates + EXIF date
      //   Now that we KNOW where the image is pointing, query COBS for
      //   all visible comets on the observation date, resolve their
      //   ephemeris, and check if any fall within the plate-solved FOV.
      //   If plate solving failed, still runs and passes bright comets
      //   to Gemini for visual confirmation.
      // ══════════════════════════════════════════════════════════════
      if (!target) {
        setStatus(prev => ({ ...prev, message: 'Scanning comet databases for this sky region...', progress: 40 }));
        try {
          addLog(`[COMET SURVEY] Querying COBS for comets visible on ${exif.timestamp}...`, 'info');
          const visibleComets = await getCometsByDate(exif.timestamp);

          if (visibleComets.length > 0) {
            addLog(`[COMET SURVEY] ${visibleComets.length} comets visible on ${exif.timestamp}: ${visibleComets.map(c => c.name).join(', ')}`, 'info');

            for (const comet of visibleComets.slice(0, 8)) {
              try {
                // Interstellar objects (1I, 2I, 3I) and short periodic designations
                // need raw COMMAND format, not DES= prefix, in JPL Horizons
                const needsRawCommand = /^\d+I$/i.test(comet.id) || /^\d+P$/i.test(comet.id);
                addLog(`[COMET SURVEY] Querying Horizons for ${comet.name} (${comet.id})${needsRawCommand ? ' [raw command]' : ''}...`, 'info');
                const eph = await fetchHorizonsEphemeris(
                  comet.id, exif.timestamp,
                  exif.location?.lat, exif.location?.lon,
                  (msg) => addLog(msg, 'info'),
                  needsRawCommand
                );
                if (!eph || !eph.ra || !eph.dec) {
                  addLog(`[COMET SURVEY] ${comet.name}: Horizons returned no ephemeris data`, 'warning');
                  continue;
                }

                const eRa = parseFloat(eph.ra);
                const eDec = parseFloat(eph.dec);
                if (isNaN(eRa) || isNaN(eDec)) continue;

                let inFov = false;

                if (astrometryResult) {
                  // PRECISE CHECK: plate-solved coordinates give exact FOV boundary
                  const cRa = parseFloat(astrometryResult.center_ra.replace(/[°'"]/g, ''));
                  const cDec = parseFloat(astrometryResult.center_dec.replace(/[°'"]/g, ''));
                  const fovMatch = astrometryResult.field_of_view.match(/([\d.]+)/);
                  const fovR = fovMatch ? parseFloat(fovMatch[1]) : 1;

                  if (!isNaN(cRa) && !isNaN(cDec)) {
                    const cosDec = Math.cos(cDec * Math.PI / 180);
                    const dRa = (eRa - cRa) * cosDec;
                    const dDec = eDec - cDec;
                    const angularSep = Math.sqrt(dRa * dRa + dDec * dDec);
                    inFov = angularSep <= fovR;

                    addLog(`[COMET SURVEY] ${comet.name}: RA=${eph.ra}, Dec=${eph.dec}, Mag=${eph.magnitude || '?'}, sep=${angularSep.toFixed(3)}° ${inFov ? '** IN FOV **' : `(outside, ${angularSep.toFixed(1)}° from center)`}`, inFov ? 'success' : 'info');
                  }
                } else {
                  // NO PLATE SOLVE: pass any bright comet (V < 14) to Gemini as candidate
                  const mag = parseFloat(eph.magnitude || '99');
                  inFov = mag < 14;
                  addLog(`[COMET SURVEY] ${comet.name}: RA=${eph.ra}, Dec=${eph.dec}, Mag=${eph.magnitude || '?'} — ${inFov ? 'BRIGHT CANDIDATE (no plate solve, Gemini will visually check)' : 'too faint'}`, inFov ? 'success' : 'info');
                }

                if (inFov) {
                  // Promote to full comet analysis
                  if (!cometResult) {
                    addLog(`[COMET SURVEY] Fetching COBS orbital data for ${comet.name}...`, 'info');
                    cometResult = await fetchCometData(comet.id, exif.timestamp, (msg) => addLog(msg, 'info')).catch(() => null);
                  }
                  if (!horizonsResult) {
                    horizonsResult = eph;
                  }
                  // If plate-solved and confirmed in FOV, we're done — this is definitive
                  if (astrometryResult) break;
                }

                await new Promise(r => setTimeout(r, 400)); // Rate limit Horizons
              } catch (cometErr: any) {
                addLog(`[COMET SURVEY] ${comet.name}: query failed — ${cometErr.message || 'unknown error'}`, 'warning');
              }
            }

            if (!cometResult) {
              // Even without ephemeris confirmation, pass the visible comet list
              // to Gemini so it can mention them as candidates when plate solve fails.
              // This prevents the case where 3I/ATLAS is visible but never mentioned.
              if (!astrometryResult && visibleComets.length > 0) {
                addLog(`[COMET SURVEY] No plate solve available. ${visibleComets.length} comets are visible on this date but cannot be FOV-checked: ${visibleComets.map(c => c.name).join(', ')}`, 'warning');
                // Store visible comets list for Gemini to reference
                (exif as any).visibleComets = visibleComets.map(c => c.name);
              } else {
                addLog('[COMET SURVEY] No comets fall within this field of view on the observation date.', 'info');
              }
            }
          } else {
            addLog(`[COMET SURVEY] No bright comets in database for ${exif.timestamp}.`, 'info');
          }
        } catch (err: any) {
          addLog(`[COMET SURVEY] Survey failed: ${err.message}`, 'warning');
        }
      }

      // ══════════════════════════════════════════════════════════════
      // STAGE 2b: SATELLITE IDENTIFICATION — SGP4 propagation of TLE catalog
      //   Uses plate-solved coordinates + EXIF date + observer location.
      //   Fetches active satellite TLEs from CelesTrak, propagates each
      //   to the observation time, checks if any crossed the FOV.
      // ══════════════════════════════════════════════════════════════
      let satelliteMatches: import('./services/satellites').SatelliteMatch[] = [];
      let broadCandidates: import('./services/satellites').BroadCandidate[] = [];
      let sgp4Reliable = true;
      let epochMismatchDays = 0;
      if (astrometryResult) {
        try {
          setStatus(prev => ({ ...prev, message: 'SGP4 satellite propagation — scanning TLE catalog...', progress: 48 }));
          const satResult = await identifySatellitesInField(
            astrometryResult,
            exif.timestamp,
            exif.location?.lat,
            exif.location?.lon,
            (msg) => addLog(msg, 'info'),
            exif.exposure
          );
          satelliteMatches = satResult.matches;
          broadCandidates = satResult.broadCandidates;
          sgp4Reliable = satResult.sgp4Reliable;
          epochMismatchDays = satResult.epochMismatchDays;
          const latDir = (exif.location?.lat ?? 0) >= 0 ? 'N' : 'S';
          const lonDir = (exif.location?.lon ?? 0) >= 0 ? 'E' : 'W';
          const obsLoc = exif.location?.lat ? `${Math.abs(exif.location.lat).toFixed(2)}°${latDir}, ${Math.abs(exif.location.lon).toFixed(2)}°${lonDir}` : 'GEOCENTRIC (0,0) — no observer location!';
          addLog(`[SAT ID] Observer location used: ${obsLoc}`, 'info');
          addLog(`[SAT ID] Observation time: ${exif.timestamp}`, 'info');

          if (satelliteMatches.length === 0) {
            const reasons: string[] = [];
            if (!exif.location?.lat) reasons.push('NO OBSERVER LOCATION — using equator (0,0) which gives wrong topocentric positions');
            if (!exif.timestamp.includes('T')) reasons.push('observation time is date-only (no hour/minute) — satellites move fast, time precision matters');
            addLog(`⚠ [SAT ID] SGP4 propagation found ZERO satellites crossing the FOV.${reasons.length > 0 ? ' ROOT CAUSE: ' + reasons.join('; ') : ' Will verify broad candidates via SatChecker...'}`, 'warning');
          }
        } catch (err: any) {
          addLog(`✗ [SAT ID] Satellite identification FAILED: ${err.message}`, 'warning');
        }
      } else {
        addLog(`⚠ [SAT ID] SKIPPED — no plate solve available. Satellite identification requires WCS coordinates.`, 'warning');
      }

      // ══════════════════════════════════════════════════════════════
      // SATCHECKER — PRIMARY or VERIFICATION mode
      //   PRIMARY:      When SGP4 has zero candidates (no TLE data), query
      //                 SatChecker directly for common bright satellites.
      //   VERIFICATION: When SGP4 found candidates, verify via SatChecker.
      // ══════════════════════════════════════════════════════════════
      let satCheckerUsedAsPrimary = false;

      // Run SatChecker PRIMARY when:
      // 1. SGP4 found zero candidates, OR
      // 2. SGP4 is unreliable (TLE epoch mismatch >7 days) — current TLEs
      //    can't accurately predict positions for old observations
      const needPrimarySearch = (satelliteMatches.length === 0 || !sgp4Reliable)
        && astrometryResult && exif.location?.lat && exif.location?.lon
        && detectedStreaks && detectedStreaks.length > 0;

      if (needPrimarySearch) {
        const reason = !sgp4Reliable
          ? `TLE epoch mismatch (${epochMismatchDays.toFixed(0)} days)`
          : 'SGP4 found no candidates';
        addLog(`\n══════════ SATCHECKER PRIMARY SEARCH ══════════`, 'info');
        addLog(`[SATCHECKER PRIMARY] Reason: ${reason}. Querying curated satellite list...`, 'info');
        try {
          setStatus(prev => ({ ...prev, message: 'SatChecker primary search — querying common satellites...', progress: 52 }));
          const obsDate = new Date(exif.timestamp.includes('T') ? exif.timestamp : exif.timestamp + 'T00:00:00Z');
          const centerRa = parseFloat(astrometryResult.center_ra.replace(/[°'"]/g, ''));
          const centerDec = parseFloat(astrometryResult.center_dec.replace(/[°'"]/g, ''));
          const fovMatch = astrometryResult.field_of_view.match(/([\d.]+)/);
          const fovRadius = fovMatch ? parseFloat(fovMatch[1]) : 1;
          const exposureSec = exif.exposure ? parseFloat(exif.exposure) || 60 : 60;

          const satCheckerResults = await findSatellitesViaSatChecker(
            obsDate,
            exif.location.lat, exif.location.lon,
            centerRa, centerDec, fovRadius, exposureSec,
            (msg) => addLog(msg, 'info')
          );

          // Convert SatChecker results to SatelliteMatch format
          for (const verified of satCheckerResults) {
            satelliteMatches.push({
              name: verified.name,
              noradId: verified.noradId,
              intlDesignator: '',
              ra: verified.ra,
              dec: verified.dec,
              altitude: verified.satAltitudeKm,
              velocity: 0,
              angularSep: verified.angularSep,
              illuminated: verified.illuminated,
              estMagnitude: 5, // Unknown — SatChecker doesn't provide magnitude
              satCheckerVerified: true,
              rangeKm: verified.rangeKm,
              dataSource: verified.dataSource,
            } as any);
          }

          if (satCheckerResults.length > 0) {
            satCheckerUsedAsPrimary = true;
            addLog(`[SATCHECKER PRIMARY] ✓ Found ${satCheckerResults.length} satellite(s) in FOV via direct SatChecker query`, 'success');
          } else {
            addLog(`[SATCHECKER PRIMARY] No common satellites found in FOV at this time`, 'info');
          }
        } catch (err: any) {
          addLog(`✗ [SATCHECKER PRIMARY] Search failed: ${err.message}`, 'warning');
        }
      }

      // Cross-match: correlate detected streaks with satellite transit paths
      if (satelliteMatches.length > 0 && detectedStreaks && detectedStreaks.length > 0) {
        addLog(`[SAT MATCH] Correlating ${detectedStreaks.length} streak(s) against ${satelliteMatches.length} satellite transit paths...`, 'info');
        satelliteMatches = matchStreaksToSatellites(
          satelliteMatches,
          detectedStreaks,
          (msg) => addLog(msg, 'info')
        );
        const bestMatch = satelliteMatches.find(s => (s.streakMatchScore || 0) > 0.3);
        if (bestMatch) {
          addLog(`[SAT ID] ✓ IDENTIFIED: ${bestMatch.name} (NORAD ${bestMatch.noradId}) — ${((bestMatch.streakMatchScore || 0) * 100).toFixed(0)}% geometric match, transit angle ${bestMatch.transitAngleDeg?.toFixed(1)}°, altitude ${bestMatch.altitude.toFixed(0)}km`, 'success');
        }
      }

      // SatChecker VERIFICATION mode: when SGP4 provided candidates, verify top ones
      if (!satCheckerUsedAsPrimary && satelliteMatches.length > 0 && astrometryResult && exif.location?.lat && exif.location?.lon) {
        addLog(`\n══════════ SATCHECKER VERIFICATION ══════════`, 'info');
        try {
          setStatus(prev => ({ ...prev, message: 'Cross-verifying satellites via IAU SatChecker...', progress: 52 }));
          const obsDate = new Date(exif.timestamp.includes('T') ? exif.timestamp : exif.timestamp + 'T00:00:00Z');
          const centerRa = parseFloat(astrometryResult.center_ra.replace(/[°'"]/g, ''));
          const centerDec = parseFloat(astrometryResult.center_dec.replace(/[°'"]/g, ''));
          const fovMatch = astrometryResult.field_of_view.match(/([\d.]+)/);
          const fovRadius = fovMatch ? parseFloat(fovMatch[1]) : 1;
          const exposureSec = exif.exposure ? parseFloat(exif.exposure) || 60 : 60;

          const satCheckerResults = await verifySatellitesWithSatChecker(
            satelliteMatches, obsDate,
            exif.location.lat, exif.location.lon,
            centerRa, centerDec, fovRadius, exposureSec,
            15, (msg) => addLog(msg, 'info')
          );

          // Enrich satellite matches with SatChecker data.
          // CRITICAL: Only mark as "verified" if SatChecker confirms the object
          // is actually IN the FOV. SatChecker returns positions for all queried
          // objects — many will be outside the FOV. Marking those as "verified"
          // would be a false positive (the COSMOS 886 DEB bug: SatChecker said
          // it was 70.62° away, but code still marked it "verified").
          for (const verified of satCheckerResults) {
            const match = satelliteMatches.find(s => s.noradId === verified.noradId);
            if (match) {
              // Update position to SatChecker's authoritative values
              match.ra = verified.ra;
              match.dec = verified.dec;
              match.angularSep = verified.angularSep;
              match.illuminated = verified.illuminated;
              match.altitude = verified.satAltitudeKm;
              (match as any).rangeKm = verified.rangeKm;
              (match as any).dataSource = verified.dataSource;

              // ONLY mark as verified if SatChecker confirms IN FOV
              if (verified.inFov) {
                (match as any).satCheckerVerified = true;
              } else {
                // SatChecker DISPROVED this SGP4 candidate — it's NOT in the FOV
                (match as any).satCheckerVerified = false;
                (match as any).satCheckerDisproved = true;
                addLog(`[SATCHECKER] ✗ DISPROVED: ${match.name} (NORAD ${match.noradId}) — SatChecker says ${verified.angularSep.toFixed(1)}° from FOV center (NOT in field)`, 'warning');
              }
            }
          }

          // Log the best verified in-FOV + illuminated satellite
          const bestVerified = satCheckerResults.find(s => s.inFov && s.illuminated);
          if (bestVerified) {
            addLog(`[SATCHECKER] ✓ CONFIRMED: ${bestVerified.name} (NORAD ${bestVerified.noradId}) — in FOV, sunlit, sep=${bestVerified.angularSep.toFixed(3)}°, range=${bestVerified.rangeKm.toFixed(0)}km [${bestVerified.dataSource}]`, 'success');
          }

          // ═══════════════════════════════════════════════════════════
          // BROAD CANDIDATE VERIFICATION — SGP4 positions for old debris
          // can be DEGREES off from reality. Objects that SGP4 placed at
          // 3-5° from center might actually be IN the FOV according to
          // SatChecker's authoritative TLEs.
          //
          // Send the top 30 Pass 1 broad candidates (nearby but not
          // necessarily FOV-crossing per SGP4) to SatChecker.
          // This is how we find the 11 objects that Project Pluto found
          // but our SGP4 missed.
          // ═══════════════════════════════════════════════════════════
          // Run broad verification when:
          // 1. All SGP4 FOV-crossers were disproved, OR
          // 2. SGP4 is unreliable due to TLE epoch mismatch (stale TLEs for old observation)
          const confirmedInFov = satelliteMatches.filter(s => (s as any).satCheckerVerified).length;
          const needBroadVerification = (confirmedInFov === 0 || !sgp4Reliable) && broadCandidates.length > 0;
          if (needBroadVerification) {
            addLog(`\n══════════ SATCHECKER BROAD VERIFICATION ══════════`, 'info');
            const reason = !sgp4Reliable
              ? `TLE epoch mismatch (${epochMismatchDays.toFixed(0)} days) — SGP4 positions unreliable`
              : 'All SGP4 FOV-crossers disproved';
            addLog(`[SATCHECKER] ${reason}. Verifying ${broadCandidates.length} broad candidates via SatChecker...`, 'info');

            const broadForVerification = broadCandidates.map(bc => ({
              noradId: bc.noradId,
              name: bc.name,
              streakMatchScore: 0,
              estMagnitude: 6,
            }));

            const broadResults = await verifySatellitesWithSatChecker(
              broadForVerification, obsDate,
              exif.location.lat, exif.location.lon,
              centerRa, centerDec, fovRadius, exposureSec,
              30, (msg) => addLog(msg, 'info')
            );

            // Add SatChecker-confirmed broad candidates to satelliteMatches
            for (const verified of broadResults) {
              if (verified.inFov) {
                satelliteMatches.push({
                  name: verified.name,
                  noradId: verified.noradId,
                  intlDesignator: '',
                  ra: verified.ra,
                  dec: verified.dec,
                  altitude: verified.satAltitudeKm,
                  velocity: 0,
                  angularSep: verified.angularSep,
                  illuminated: verified.illuminated,
                  estMagnitude: 5,
                  satCheckerVerified: true,
                  rangeKm: verified.rangeKm,
                  dataSource: verified.dataSource,
                } as any);
                addLog(`[SATCHECKER BROAD] ✓ FOUND: ${verified.name} (NORAD ${verified.noradId}) — IN FOV, sep=${verified.angularSep.toFixed(3)}°, ${verified.illuminated ? 'sunlit' : 'shadow'}`, 'success');
              }
            }

            const broadInFov = broadResults.filter(r => r.inFov).length;
            if (broadInFov > 0) {
              addLog(`[SATCHECKER BROAD] Found ${broadInFov} additional satellite(s) in FOV that SGP4 missed!`, 'success');
            } else {
              addLog(`[SATCHECKER BROAD] No additional satellites found in FOV from broad candidates`, 'info');
            }
          }
        } catch (err: any) {
          addLog(`✗ [SATCHECKER] SatChecker verification FAILED: ${err.message}`, 'warning');
        }
      } else if (!satCheckerUsedAsPrimary && satelliteMatches.length === 0) {
        // Log WHY SatChecker was skipped entirely
        const reasons: string[] = [];
        if (!astrometryResult) reasons.push('no plate solve');
        if (!exif.location?.lat || !exif.location?.lon) reasons.push('no observer GPS coordinates');
        if (!detectedStreaks || detectedStreaks.length === 0) reasons.push('no detected streaks');
        if (reasons.length > 0) {
          addLog(`⚠ [SATCHECKER] SKIPPED — ${reasons.join(', ')}. SatChecker requires plate solve + observer location.`, 'warning');
        }
      }

      // ══════════════════════════════════════════════════════════════
      // PROJECT PLUTO — AUTHORITATIVE satellite identification
      //   Uses Bill Gray's sat_code with HISTORICAL TLEs from the
      //   observation epoch. This is the gold standard — same tool
      //   used by professional asteroid surveyors.
      //   Only available when we have plate solve + observer location.
      // ══════════════════════════════════════════════════════════════
      let plutoResults: PlutoSatellite[] = [];
      if (astrometryResult && exif.location?.lat && exif.location?.lon) {
        try {
          setStatus(prev => ({ ...prev, message: 'Querying Project Pluto (Bill Gray sat_code)...', progress: 55 }));
          addLog(`\n══════════ PROJECT PLUTO (AUTHORITATIVE) ══════════`, 'info');
          const obsDate = new Date(exif.timestamp.includes('T') ? exif.timestamp : exif.timestamp + 'T00:00:00Z');
          const centerRa = parseFloat(astrometryResult.center_ra.replace(/[°'"]/g, ''));
          const centerDec = parseFloat(astrometryResult.center_dec.replace(/[°'"]/g, ''));
          const fovMatch = astrometryResult.field_of_view.match(/([\d.]+)/);
          const fovRadius = fovMatch ? parseFloat(fovMatch[1]) : 1;

          plutoResults = await queryProjectPluto(
            obsDate, exif.location.lat, exif.location.lon,
            centerRa, centerDec, 5, // 5° search radius like Bill Gray's default
            (msg) => addLog(msg, 'info')
          );

          // Convert Pluto results to SatelliteMatch format and ADD to satelliteMatches.
          // These are AUTHORITATIVE — they override SGP4/SatChecker results.
          //
          // FOV CHECK: Project Pluto reports the satellite position at a single
          // instant (observation midpoint). But during a long exposure, fast-moving
          // satellites traverse degrees of sky. A satellite whose midpoint position
          // is 3.5° from center may have CROSSED THROUGH the 1.22° FOV during
          // the exposure. We must account for this:
          //
          //   travelDeg = motionArcminPerMin × exposureMin / 60
          //   couldCrossFov = angularSep <= fovRadius + travelDeg/2
          //
          // Example: FREGAT R/B at 3.52° from center, moving 12'/min, 24min exposure:
          //   travel = 12 × 24 / 60 = 4.8°, halfTravel = 2.4°
          //   couldCross = 3.52 <= 1.22 + 2.4 = 3.62° → YES
          // Parse exposure to minutes — exif.exposure can be "24min", "120s", "300x30s", etc.
          let exposureMin = 1;
          if (exif.exposure) {
            const expStr = exif.exposure.toLowerCase();
            const minMatch = expStr.match(/([\d.]+)\s*min/);
            const secMatch = expStr.match(/([\d.]+)\s*s/);
            const stackMatch = expStr.match(/([\d]+)\s*x\s*([\d.]+)\s*s/);
            if (minMatch) exposureMin = parseFloat(minMatch[1]);
            else if (stackMatch) exposureMin = (parseInt(stackMatch[1]) * parseFloat(stackMatch[2])) / 60;
            else if (secMatch) exposureMin = parseFloat(secMatch[1]) / 60;
            else exposureMin = parseFloat(exif.exposure) / 60 || 1;
          }

          const plutoInFov = plutoResults.filter(p => {
            const travelDeg = (p.motionArcminPerMin * exposureMin) / 60;
            const maxSep = fovRadius + travelDeg / 2;
            const couldCross = p.angularSepFromCenter <= maxSep;
            if (couldCross && p.angularSepFromCenter > fovRadius) {
              addLog(`[PROJECT PLUTO] ${p.name}: midpoint is ${p.angularSepFromCenter.toFixed(2)}° from center, but moves ${travelDeg.toFixed(1)}° during ${exposureMin}min exposure — COULD CROSS FOV (threshold: ${maxSep.toFixed(2)}°)`, 'info');
            }
            return couldCross;
          });

          if (plutoInFov.length > 0) {
            addLog(`[PROJECT PLUTO] ${plutoInFov.length} satellite(s) confirmed IN or CROSSING FOV:`, 'success');
            for (const ps of plutoInFov) {
              addLog(`[PROJECT PLUTO]   ✓ ${ps.name} (NORAD ${ps.noradId}): sep=${ps.angularSepFromCenter.toFixed(3)}°, ${ps.motionArcminPerMin.toFixed(1)}'/min, PA=${ps.positionAngle.toFixed(1)}°${ps.inShadow ? ' (SHADOW)' : ' (SUNLIT)'}`, 'success');

              // Check if this satellite is already in our matches
              const existing = satelliteMatches.find(s => s.noradId === ps.noradId);
              if (existing) {
                // Update with authoritative Pluto position
                existing.ra = ps.ra;
                existing.dec = ps.dec;
                existing.angularSep = ps.angularSepFromCenter;
                existing.illuminated = !ps.inShadow;
                (existing as any).satCheckerVerified = false; // Override
                (existing as any).satCheckerDisproved = false;
                (existing as any).plutoVerified = true;
                (existing as any).plutoMotion = ps.motionArcminPerMin;
                (existing as any).plutoPA = ps.positionAngle;
              } else {
                // Add new authoritative match
                satelliteMatches.push({
                  name: ps.name,
                  noradId: ps.noradId,
                  intlDesignator: ps.cosparId,
                  ra: ps.ra,
                  dec: ps.dec,
                  altitude: 0, // Pluto doesn't provide altitude
                  velocity: 0,
                  angularSep: ps.angularSepFromCenter,
                  illuminated: !ps.inShadow,
                  estMagnitude: 6,
                  plutoVerified: true,
                  plutoMotion: ps.motionArcminPerMin,
                  plutoPA: ps.positionAngle,
                  dataSource: 'Project Pluto (Bill Gray sat_code)',
                } as any);
              }
            }
          }
        } catch (err: any) {
          addLog(`⚠ [PROJECT PLUTO] Query failed: ${err.message}. Falling back to SGP4/SatChecker results.`, 'warning');
        }
      }

      // ══════════════════════════════════════════════════════════════
      // STAGE 3: NEO ENRICHMENT — resolve ephemeris positions, check FOV
      // ══════════════════════════════════════════════════════════════
      if (astrometryResult && neoResult && neoResult.length > 0) {
        setStatus(prev => ({ ...prev, message: 'Resolving NEO ephemeris positions...', progress: 50 }));
        neoResult = await enrichNeosWithEphemeris(
          neoResult,
          exif.timestamp,
          astrometryResult,
          exif.location?.lat,
          exif.location?.lon,
          (msg) => addLog(msg, 'info')
        );
      }

      // STAGE 2: Analysis (Vision or Meta)
      setStatus(prev => ({ ...prev, step: 'analyzing', message: astrometryResult ? 'Formatting Astrometry.net Data...' : 'Performing Visual Identification...', progress: 60 }));
      
      // Filter out SatChecker-disproved satellites BEFORE passing to Gemini.
      // Gemini narrates whatever data we give it — if we pass disproved satellites,
      // it will report them as confirmed findings. Only pass verified or unverified
      // (but not disproved) candidates.
      const confirmedSatellites = satelliteMatches.filter(s => !(s as any).satCheckerDisproved);

      const analysis = await analyzeCelestialImageStream(
          base64,
          exif,
          astrometryResult,
          neoResult,
          cometResult,
          target || "",
          horizonsResult,
          (thought) => {
            if (thought.trim()) addLog(thought, 'info');
          },
          confirmedSatellites,
          detectedStreaks
      );

      if (!analysis) throw new Error("Analysis engine failed.");

      setStatus(prev => ({ ...prev, step: 'synthesis', message: 'Finalizing results...', progress: 85 }));

      analysis.exif = exif;
      analysis.neos = neoResult;
      analysis.comet = cometResult;
      analysis.horizons = horizonsResult;
      // Only pass satellites that were NOT disproved by SatChecker to downstream consumers (Gemini, dashboard).
      // Disproved satellites (SatChecker confirmed they are NOT in the FOV) must be excluded
      // to prevent Gemini from narrating false identifications.
      analysis.satellites = satelliteMatches.filter(s => !(s as any).satCheckerDisproved);

      // ══════════════════════════════════════════════════════════════
      // DETERMINISTIC STREAK + SATELLITE INJECTION
      // Create identification entries directly from pipeline data.
      // Do NOT rely on Gemini to detect or identify streaks.
      // ══════════════════════════════════════════════════════════════
      addLog(`\n══════════ DETERMINISTIC INJECTION ══════════`, 'info');
      addLog(`· Detected streaks: ${detectedStreaks?.length || 0}`, 'info');
      addLog(`· Satellite candidates: ${satelliteMatches.length}`, 'info');
      addLog(`· Gemini identifications: ${analysis.identifications?.length || 0}`, 'info');

      if (!detectedStreaks || detectedStreaks.length === 0) {
        addLog(`⚠ [INJECT] No streaks detected by feature extraction — satellite trail injection will NOT fire. If you see a streak in the image, the streak detector failed to find it.`, 'warning');
        // Even without detected streaks, if we have illuminated satellites, log them as context
        const illuminated = satelliteMatches.filter(s => s.illuminated);
        if (illuminated.length > 0) {
          addLog(`· [INJECT] ${illuminated.length} illuminated satellite(s) crossed the FOV but no streak was detected to match against. Top: ${illuminated.slice(0, 3).map(s => s.name).join(', ')}`, 'info');
        }
      }

      if (detectedStreaks && detectedStreaks.length > 0) {
        for (let si = 0; si < detectedStreaks.length; si++) {
          const streak = detectedStreaks[si];
          const midX = (streak.pixel_start_x + streak.pixel_end_x) / 2;
          const midY = (streak.pixel_start_y + streak.pixel_end_y) / 2;
          const length = Math.sqrt(
            (streak.pixel_end_x - streak.pixel_start_x) ** 2 +
            (streak.pixel_end_y - streak.pixel_start_y) ** 2
          );
          const angle = Math.atan2(
            streak.pixel_end_y - streak.pixel_start_y,
            streak.pixel_end_x - streak.pixel_start_x
          ) * (180 / Math.PI);

          // ═══════════════════════════════════════════════════════════
          // MATCH THIS SPECIFIC STREAK to satellite candidates.
          // Rank by: (1) SatChecker verified, (2) streak geometry match
          // for THIS streak index, (3) illumination, (4) brightness.
          //
          // CONFIDENCE CALIBRATION:
          //   - Project Pluto verified (authoritative): 0.95
          //   - SatChecker verified + strong streak match: 0.90
          //   - SatChecker verified (no streak match data): 0.80
          //   - SGP4-only + strong streak match (>0.5): 0.55
          //   - SGP4-only (no streak match): 0.35
          //   - No satellite candidate: 0.3 (unresolved streak)
          // ═══════════════════════════════════════════════════════════

          // Find the best satellite match FOR THIS SPECIFIC STREAK
          const streakCandidates = satelliteMatches
            .filter(s => {
              // EXCLUDE satellites that SatChecker explicitly disproved
              // (unless Pluto overrode the disproval)
              if ((s as any).satCheckerDisproved && !(s as any).plutoVerified) return false;
              // Include: Pluto-verified, SatChecker-verified, or SGP4 transit matches
              return (s as any).plutoVerified || (s.transitPath && s.transitPath.length > 0) || (s as any).satCheckerVerified;
            })
            .map(s => {
              // Score THIS streak against THIS satellite
              const isPluto = !!(s as any).plutoVerified;
              const isVerified = !!(s as any).satCheckerVerified;
              const matchesThisStreak = s.bestStreakIdx === si;
              const streakScore = matchesThisStreak ? (s.streakMatchScore || 0) : 0;

              // Composite ranking score
              let rank = 0;
              if (isPluto) rank += 10000; // Project Pluto = authoritative
              if (isVerified) rank += 1000;
              if (s.illuminated) rank += 100;
              rank += streakScore * 50;
              rank += Math.max(0, 10 - s.estMagnitude);

              return { sat: s, rank, streakScore, isVerified, isPluto };
            })
            .sort((a, b) => b.rank - a.rank);

          const bestCandidate = streakCandidates.length > 0 ? streakCandidates[0] : null;
          const bestSat = bestCandidate?.sat || null;

          // Log top candidates for transparency
          if (streakCandidates.length > 0) {
            addLog(`[SAT INJECT] Streak #${si + 1} candidates (${streakCandidates.length} total):`, 'info');
            streakCandidates.slice(0, 5).forEach((c, i) => {
              const tag = c.isPluto ? '[PLUTO ✓✓]' : c.isVerified ? '[SATCHECKER ✓]' : '[SGP4 only]';
              const illum = c.sat.illuminated ? 'sunlit' : 'shadow';
              addLog(`[SAT INJECT]   ${i + 1}. ${c.sat.name} (NORAD ${c.sat.noradId}): ${tag} ${illum}, streak score=${(c.streakScore * 100).toFixed(0)}%, rank=${c.rank.toFixed(0)}`, 'info');
            });
          }

          // Calibrate confidence based on verification level
          let confidence: number;
          let verificationStatus: string;
          const isPlutoVerified = bestCandidate?.isPluto || false;
          if (isPlutoVerified) {
            confidence = 0.95;
            verificationStatus = 'wcs_confirmed';
          } else if (bestCandidate?.isVerified && bestCandidate.streakScore > 0.3) {
            confidence = 0.90;
            verificationStatus = 'wcs_confirmed';
          } else if (bestCandidate?.isVerified) {
            confidence = 0.80;
            verificationStatus = 'wcs_confirmed';
          } else if (bestSat && bestCandidate && bestCandidate.streakScore > 0.5) {
            confidence = 0.55;
            verificationStatus = 'candidate';
          } else if (bestSat) {
            confidence = 0.35;
            verificationStatus = 'candidate';
          } else {
            confidence = 0.3;
            verificationStatus = 'candidate';
          }

          const isVerified = isPlutoVerified || bestCandidate?.isVerified || false;
          const verifiedTag = isPlutoVerified ? ' [Project Pluto — Authoritative]'
            : (bestCandidate?.isVerified ? ' [IAU SatChecker Verified]' : ' [SGP4 estimate — unverified]');
          const satName = bestSat ? `${bestSat.name} (NORAD ${bestSat.noradId})` : 'Unidentified Satellite Trail';
          const objType = (bestSat && isVerified) ? 'satellite_trail' : 'streak';

          const evidence: string[] = [
            `Linear feature detected: ${length.toFixed(0)}px at ${angle.toFixed(1)}° position angle`,
            `Pixel coordinates: (${streak.pixel_start_x},${streak.pixel_start_y})→(${streak.pixel_end_x},${streak.pixel_end_y})`,
          ];
          if (bestSat) {
            const source = isPlutoVerified
              ? `Project Pluto (Bill Gray sat_code) using historical TLEs — AUTHORITATIVE`
              : (bestCandidate?.isVerified ? 'IAU SatChecker' : 'SGP4 propagation (may be inaccurate for old debris TLEs)');
            evidence.push(
              `Identified: ${bestSat.name} via ${source}${verifiedTag}`,
              bestSat.altitude > 0 ? `Satellite altitude: ${bestSat.altitude.toFixed(0)}km${bestSat.velocity ? `, velocity: ${bestSat.velocity.toFixed(1)}km/s` : ''}` : '',
              (bestSat as any).plutoMotion ? `Angular motion: ${(bestSat as any).plutoMotion.toFixed(1)}'/min, PA=${(bestSat as any).plutoPA.toFixed(1)}°` : '',
              bestSat.transitAngleDeg !== undefined ? `Transit angle: ${bestSat.transitAngleDeg.toFixed(1)}°` : '',
              bestSat.illuminated ? 'Satellite confirmed sunlit at observation time' : 'In Earth shadow at observation time',
            );
            if (!isVerified) {
              evidence.push('⚠ SGP4-only identification — confidence is limited. Debris TLEs degrade quickly and may produce incorrect positions.');
            }
            if (streakCandidates.length > 1) {
              evidence.push(`${streakCandidates.length} other satellite candidates in field: ${streakCandidates.slice(1, 4).map(c => c.sat.name).join(', ')}${streakCandidates.length > 4 ? '...' : ''}`);
            }
          }

          analysis.identifications = analysis.identifications || [];
          analysis.identifications.push({
            object_type: objType as any,
            primary_name: satName,
            ra: bestSat ? bestSat.ra.toFixed(4) + '°' : 'Unknown',
            dec: bestSat ? bestSat.dec.toFixed(4) + '°' : 'Unknown',
            confidence,
            evidence: evidence.filter(e => e),
            recommended_followup: isVerified
              ? 'Satellite trail confirmed via IAU SatChecker.'
              : 'SGP4-only match — verify with heavens-above.com or projectpluto.com/sat_img.htm for authoritative identification.',
            pixel_coords: { x: midX, y: midY },
            streak_info: {
              length_pixels: length,
              position_angle_deg: angle,
              catalog_match: bestSat ? `${bestSat.name} (NORAD ${bestSat.noradId})` : undefined,
            },
            verification_status: verificationStatus,
          } as any);

          const statusEmoji = isVerified ? '✓' : '?';
          addLog(`${statusEmoji} [SAT INJECT] ${isVerified ? 'VERIFIED' : 'CANDIDATE'}: ${satName} — ${length.toFixed(0)}px streak at ${angle.toFixed(1)}° (confidence: ${(confidence * 100).toFixed(0)}%)`, isVerified ? 'success' : 'info');
        }
      }

      // STAGE 6: RESOLVE UNKNOWNS — exhaust every database for unidentified objects
      setStatus(prev => ({ ...prev, message: 'Resolving unknown objects...', progress: 90 }));
      // Filter out disproved satellites before resolver — otherwise it re-matches
      // objects that SatChecker/Pluto already proved are NOT in the FOV
      const resolverSatellites = satelliteMatches.filter(s => !(s as any).satCheckerDisproved);
      analysis.identifications = await resolveUnknownObjects(
        analysis, exif, astrometryResult, neoResult,
        resolverSatellites, detectedStreaks,
        (msg) => addLog(msg, 'info')
      );

      // ══════════════════════════════════════════════════════════════
      // FINAL PIPELINE SUMMARY
      // ══════════════════════════════════════════════════════════════
      addLog(`\n══════════ PIPELINE COMPLETE ══════════`, 'info');
      const totalIds = analysis.identifications?.length || 0;
      const satIds = (analysis.identifications || []).filter(id => (id.object_type || '').toLowerCase().includes('satellite'));
      const streakIdsF = (analysis.identifications || []).filter(id => ['streak', 'space_debris'].includes((id.object_type || '').toLowerCase()));
      const resolvedIds = (analysis.identifications || []).filter(id => id.resolution_audit?.resolved);
      const unresolvedIds = (analysis.identifications || []).filter(id => id.resolution_audit && !id.resolution_audit.resolved);

      addLog(`· Total identifications: ${totalIds}`, 'info');
      addLog(`· Satellite trails identified: ${satIds.length}${satIds.length > 0 ? ' — ' + satIds.map(s => s.primary_name).join(', ') : ''}`, satIds.length > 0 ? 'success' : 'info');
      addLog(`· Unresolved streaks/debris: ${streakIdsF.length}`, streakIdsF.length > 0 ? 'warning' : 'info');
      addLog(`· Resolver: ${resolvedIds.length} resolved, ${unresolvedIds.length} unresolved`, 'info');
      addLog(`· Satellites in FOV (SGP4): ${satelliteMatches.length}`, 'info');
      addLog(`· NEOs checked: ${neoResult?.length || 0}, in-field: ${neoResult?.filter((n: any) => n.in_field).length || 0}`, 'info');
      addLog(`══════════════════════════════════════════════\n`, 'info');

      setResults(analysis);
      setStatus(prev => ({ ...prev, step: 'completed', message: 'Identification finalized.', progress: 100 }));

    } catch (error: any) {
      console.error(error);
      const msg = error instanceof Error ? error.message : "System Failure";
      addLog(`[CRITICAL] ${msg}`, 'critical');
      setStatus(prev => ({ ...prev, step: 'error', message: msg, progress: 0 }));
    }
  };

  const handleRetry = () => {
    if (image && rawFile) {
      setStatus({ step: 'idle', message: '', progress: 0, logs: [] });
      processImage(image, rawFile, targetComet);
    }
  };

  const reset = () => {
    setImage(null);
    setRawFile(null);
    setResults(null);
    setTargetComet("");
    setStatus({ step: 'idle', message: '', progress: 0, logs: [] });
  };

  return (
    <div className="min-h-screen flex flex-col bg-black">
      <Header onReset={reset} />
      <main className="flex-grow">
        {!hasKey && (
          <div className="max-w-2xl mx-auto mt-20 text-center border border-white/10 p-12 bg-black">
            <h2 className="text-2xl hud-title mb-6">Setup Required</h2>
            <p className="text-white/30 mb-8 leading-relaxed text-xs tracking-wider uppercase">
              This application utilizes Astrometry.net for high-precision plate solving.
              <br/>
              <span className="text-xs opacity-40 mt-2 block">(Gemini API is used for data formatting only)</span>
            </p>
            <button
              onClick={handleSelectKey}
              className="hud-btn py-4 px-10 mx-auto"
            >
              <i className="fa-solid fa-key text-xs"></i>
              Authenticate with API Key
            </button>
          </div>
        )}

        {hasKey && !image && <ImageUploader onUpload={handleImageUpload} />}
        {hasKey && image && status.step !== 'completed' && status.step !== 'error' && (
          <ProcessingOverlay state={status} image={image} />
        )}
        {status.step === 'error' && (
          <div className="max-w-2xl mx-auto border border-white/15 p-12 text-center bg-black">
            <h2 className="text-2xl hud-title mb-4">!! Identification Failed</h2>
            <p className="text-white/30 mb-8 leading-relaxed text-xs tracking-wider">{status.message}</p>
            <div className="flex gap-4 justify-center">
              <button onClick={handleRetry} className="hud-btn px-8 py-3">Retry</button>
              <button onClick={reset} className="hud-btn px-8 py-3 opacity-50">New Upload</button>
            </div>
          </div>
        )}
        {results && status.step === 'completed' && (
          <ResultsDashboard results={results} image={image} exif={results.exif} />
        )}
      </main>
      <footer className="py-3 border-t border-white/5 text-center">
        <p className="text-white/8 text-[9px] uppercase tracking-[0.4em]">
          Astrometry.net // NASA NeoWs // COBS // JPL Horizons // Gemini 3 Pro
        </p>
      </footer>
    </div>
  );
};

export default App;
