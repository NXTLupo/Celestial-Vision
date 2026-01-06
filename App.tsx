
import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { ImageUploader } from './components/ImageUploader';
import { ResultsDashboard } from './components/ResultsDashboard';
import { ProcessingOverlay } from './components/ProcessingOverlay';
import { IdentificationResult, ProcessingState, ThoughtLog } from './types';
import { analyzeCelestialImageStream, generateScientificIllustration } from './services/gemini';
import { solveAstrometry } from './services/astrometry';
import { fetchNearEarthObjects } from './services/nasa';
import { fetchCometData } from './services/cobs';
import { fetchHorizonsEphemeris } from './services/horizons';

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
        timestamp: new Date().toISOString().split('T')[0],
        focalLength: "Unknown",
        fNumber: "f/--",
        iso: "Auto",
        location: { lat: null, lon: null }
      };

      const timeoutId = setTimeout(() => resolve(defaults), 1500);

      try {
        EXIF.getData(file, function(this: any) {
          clearTimeout(timeoutId);
          const allMetaData = EXIF.getAllTags(this);
          
          if (!allMetaData) {
            resolve(defaults);
            return;
          }

          const convertToDecimal = (gpsArr: any, ref: string) => {
            if (!gpsArr || !gpsArr[0]) return null;
            let decimal = gpsArr[0] + gpsArr[1]/60 + gpsArr[2]/3600;
            if (ref === 'S' || ref === 'W') decimal *= -1;
            return decimal; // Return number, not string
          };

          const rawDate = allMetaData.DateTimeOriginal;
          let formattedDate = defaults.timestamp;
          if (rawDate) {
              // Convert "YYYY:MM:DD HH:MM:SS" to "YYYY-MM-DD"
              const parts = rawDate.split(' ');
              if (parts[0]) {
                  formattedDate = parts[0].replace(/:/g, '-');
              }
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
        resolve(defaults);
      }
    });
  };

  const processImage = async (base64: string, file: File, target?: string, manualDate?: string) => {
    try {
      setStatus(prev => ({ ...prev, step: 'ingesting', message: 'Extracting Optical Telemetry...', progress: 5 }));
      const exif = await extractExif(file);
      
      // Override if manual date provided by user in staging area
      if (manualDate) {
         exif.timestamp = manualDate;
         addLog(`[USER OVERRIDE] Analysis date set to ${manualDate}`, 'info');
      }

      addLog(`[SYSTEM] Telemetry acquired: ${exif.instrument} @ ${exif.timestamp}`, 'success');

      // PARALLEL EXECUTION: Astrometry, NASA NEO, COBS, and HORIZONS
      setStatus(prev => ({ ...prev, step: 'analyzing', message: 'Executing Multi-Agency Analysis...', progress: 15 }));
      
      const astrometryPromise = solveAstrometry(base64, (msg) => addLog(msg, 'info'));
      const nasaPromise = fetchNearEarthObjects(exif.timestamp, (msg) => addLog(msg, 'info'));
      
      // Target Tracking: Attempt both COBS (Visuals) and Horizons (Ephemeris)
      const cometPromise = target ? fetchCometData(target, exif.timestamp, (msg) => addLog(msg, 'info')) : Promise.resolve(null);
      const horizonsPromise = target ? fetchHorizonsEphemeris(target, exif.timestamp, exif.location.lat, exif.location.lon, (msg) => addLog(msg, 'info')) : Promise.resolve(null);

      const [astrometryResult, neoResult, cometResult, horizonsResult] = await Promise.all([
          astrometryPromise, 
          nasaPromise, 
          cometPromise, 
          horizonsPromise
      ]);
      
      if (!astrometryResult) {
        addLog("Plate solving failed or timed out. Switching to Visual Analysis mode.", 'warning');
      } else {
        addLog(`[ASTROMETRY] WCS Solution found. Quality: ${astrometryResult.wcs_quality}%`, 'success');
      }

      // STAGE 2: Analysis (Vision or Meta)
      setStatus(prev => ({ ...prev, step: 'analyzing', message: astrometryResult ? 'Formatting Astrometry.net Data...' : 'Performing Visual Identification...', progress: 60 }));
      
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
          }
      );

      if (!analysis) throw new Error("Analysis engine failed.");

      // STAGE 3: Generate Nano Banana Pro Illustration
      setStatus(prev => ({ ...prev, step: 'synthesis', message: 'Generating Vector Annotation Map...', progress: 85 }));
      const vectorMap = await generateScientificIllustration(base64, analysis, (thought) => addLog(thought, 'info'));
      
      if (vectorMap) {
        analysis.generated_annotation_image = vectorMap;
        addLog("[NANO BANANA] Vector Illustration Generated Successfully.", 'success');
      }

      analysis.exif = exif;
      analysis.neos = neoResult;
      analysis.comet = cometResult;
      analysis.horizons = horizonsResult; // Attach Horizons data
      
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
    <div className="min-h-screen flex flex-col bg-[#020408]">
      <Header onReset={reset} />
      <main className="flex-grow container mx-auto px-4 py-8 max-w-7xl">
        {!hasKey && (
          <div className="max-w-2xl mx-auto mt-20 text-center bg-slate-900/50 border border-indigo-500/30 p-12 rounded-[2.5rem] shadow-2xl backdrop-blur-xl">
            <h2 className="text-3xl font-bold text-white mb-6">Setup Required</h2>
            <p className="text-slate-400 mb-8 leading-relaxed">
              This application utilizes <span className="text-indigo-400 font-bold">Astrometry.net</span> for high-precision plate solving.
              <br/>
              <span className="text-xs opacity-60 mt-2 block">(Gemini API is used for data formatting only)</span>
            </p>
            <button 
              onClick={handleSelectKey}
              className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-4 px-10 rounded-2xl shadow-xl shadow-indigo-500/20 transition-all flex items-center gap-3 mx-auto"
            >
              <i className="fa-solid fa-key"></i>
              Authenticate with API Key
            </button>
          </div>
        )}

        {hasKey && !image && <ImageUploader onUpload={handleImageUpload} />}
        {hasKey && image && status.step !== 'completed' && status.step !== 'error' && (
          <ProcessingOverlay state={status} image={image} />
        )}
        {status.step === 'error' && (
          <div className="max-w-2xl mx-auto bg-red-950/20 border border-red-500/30 p-12 rounded-[2.5rem] text-center shadow-2xl">
            <h2 className="text-2xl font-bold text-red-400 mb-4">Identification Failed</h2>
            <p className="text-red-300/80 mb-8 leading-relaxed">{status.message}</p>
            <div className="flex gap-4 justify-center">
              <button onClick={handleRetry} className="bg-indigo-600 text-white px-8 py-3 rounded-xl font-bold">Retry</button>
              <button onClick={reset} className="bg-slate-800 text-white px-8 py-3 rounded-xl font-bold">New Upload</button>
            </div>
          </div>
        )}
        {results && status.step === 'completed' && (
          <ResultsDashboard results={results} image={image} exif={results.exif} />
        )}
      </main>
      <footer className="py-8 border-t border-slate-900 text-center">
        <p className="text-slate-600 text-[10px] uppercase tracking-widest font-bold">
          Powered by Astrometry.net • NASA NeoWs • COBS • JPL Horizons • Gemini 3 Pro
        </p>
      </footer>
    </div>
  );
};

export default App;
