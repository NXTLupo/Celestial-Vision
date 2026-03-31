
import React, { useRef, useState, useEffect } from 'react';
import { getCometsByDate } from '../services/cobs';
import { preScangImage, ImagePreScan } from '../services/gemini';
import { PerspectiveGrid, Waveform } from './HudVisuals';

declare const EXIF: any;

interface ImageUploaderProps {
  onUpload: (file: File, targetComet?: string, manualDate?: string) => void;
}

export const ImageUploader: React.FC<ImageUploaderProps> = ({ onUpload }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [stagedFile, setStagedFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [targetComet, setTargetComet] = useState("");
  const [detectedDate, setDetectedDate] = useState<string>("");
  const [cometSuggestions, setCometSuggestions] = useState<{id: string, name: string}[]>([]);
  const [isLoadingComets, setIsLoadingComets] = useState(false);
  const [isCheckingExif, setIsCheckingExif] = useState(false);

  const fetchSuggestions = async (dateStr: string) => {
    setIsLoadingComets(true);
    setCometSuggestions([]);
    const suggestions = await getCometsByDate(dateStr);
    setCometSuggestions(suggestions);
    setIsLoadingComets(false);
  };

  useEffect(() => {
    if (detectedDate && detectedDate.length === 10) fetchSuggestions(detectedDate);
  }, [detectedDate]);

  // Gemini visual pre-scan — reads watermarks, timestamps, target names from image
  const runPreScan = async (base64: string) => {
    setIsScanning(true);
    try {
      const result = await preScangImage(base64);
      setPreScanResult(result);

      // Auto-fill fields from pre-scan results (only if not already set by EXIF)
      if (result.date && (!detectedDate || dateSource === 'file' || dateSource === 'none')) {
        setDetectedDate(result.date);
        setDateSource('scan');
      }
      if (result.target && !targetComet) {
        setTargetComet(result.target);
      }
    } catch {
      // Pre-scan failure is non-critical
    } finally {
      setIsScanning(false);
    }
  };

  const [dateSource, setDateSource] = useState<'exif' | 'file' | 'scan' | 'none'>('none');
  const [preScanResult, setPreScanResult] = useState<ImagePreScan | null>(null);
  const [isScanning, setIsScanning] = useState(false);

  const handleFileSelection = (file: File) => {
    setStagedFile(file);
    setPreScanResult(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      const base64 = e.target?.result as string;
      setFilePreview(base64);
      // Launch Gemini pre-scan in parallel with EXIF extraction
      runPreScan(base64);
    };
    reader.readAsDataURL(file);
    setIsCheckingExif(true);
    setDateSource('none');

    const timeoutId = setTimeout(() => {
      // Timeout fallback — use file modification date, NOT today
      if (file.lastModified) {
        setDetectedDate(new Date(file.lastModified).toISOString().split('T')[0]);
        setDateSource('file');
      } else {
        setDetectedDate('');
        setDateSource('none');
      }
      setIsCheckingExif(false);
    }, 3000);

    try {
      EXIF.getData(file, function(this: any) {
        clearTimeout(timeoutId);
        const allMetaData = EXIF.getAllTags(this);
        // Try multiple EXIF date tags
        const rawDate = allMetaData?.DateTimeOriginal
          || allMetaData?.DateTimeDigitized
          || allMetaData?.DateTime
          || allMetaData?.GPSDateStamp;

        if (rawDate) {
          const parts = rawDate.split(' ');
          if (parts[0]) {
            setDetectedDate(parts[0].replace(/:/g, '-'));
            setDateSource('exif');
            setIsCheckingExif(false);
            return;
          }
        }

        // No EXIF date — use file modification date (NOT today)
        if (file.lastModified) {
          setDetectedDate(new Date(file.lastModified).toISOString().split('T')[0]);
          setDateSource('file');
        } else {
          setDetectedDate('');
          setDateSource('none');
        }
        setIsCheckingExif(false);
      });
    } catch (e) {
      clearTimeout(timeoutId);
      if (file.lastModified) {
        setDetectedDate(new Date(file.lastModified).toISOString().split('T')[0]);
        setDateSource('file');
      } else {
        setDetectedDate('');
        setDateSource('none');
      }
      setIsCheckingExif(false);
    }
  };

  const handleDateChange = (date: string) => setDetectedDate(date);
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => { const file = e.target.files?.[0]; if (file) handleFileSelection(file); };
  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };
  const onDragLeave = () => setIsDragging(false);
  const onDrop = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(false); const file = e.dataTransfer.files?.[0]; if (file) handleFileSelection(file); };
  const handleConfirmUpload = () => { if (stagedFile) onUpload(stagedFile, targetComet, detectedDate); };
  const handleCancel = () => { setStagedFile(null); setFilePreview(null); setTargetComet(""); setDetectedDate(""); setCometSuggestions([]); };

  // ── STAGING VIEW ──
  if (stagedFile) {
    return (
      <div className="max-w-4xl mx-auto mt-8 px-4">
        <div className="bg-black p-10 relative hud-frame">
          {/* Corner marks */}
          <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-white/30"></div>
          <div className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-white/30"></div>
          <div className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-white/30"></div>
          <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-white/30"></div>
          <div className="absolute top-2 right-8 text-[9px] text-white/10 tracking-[0.3em]">0xF4A2::STAGE</div>

          <div className="text-center mb-10">
            <h2 className="text-2xl hud-title mb-3">Initialize Analysis</h2>
            <p className="text-white/25 text-xs tracking-[0.2em] uppercase">Review telemetry parameters before engaging AI model</p>
          </div>

          <div className="flex gap-10 mb-8">
            <div className="w-1/3 aspect-square overflow-hidden border border-white/10 bg-black relative">
              {filePreview && <img src={filePreview} alt="Preview" className="w-full h-full object-cover" />}
              <div className="absolute top-2 left-2 text-[11px] text-white/15 tracking-[0.3em]">IMG::STAGED</div>
              {isScanning && (
                <div className="absolute bottom-0 left-0 right-0 bg-black/80 px-3 py-2 flex items-center gap-2">
                  <div className="w-3 h-3 border border-white/30 border-t-white/70 animate-spin"></div>
                  <span className="text-[11px] text-white/40 tracking-[0.2em] uppercase">Scanning image for metadata...</span>
                </div>
              )}
            </div>
            <div className="w-2/3 flex flex-col justify-center space-y-6">

              {/* Pre-scan results banner */}
              {preScanResult && !isScanning && (preScanResult.date || preScanResult.target || preScanResult.instrument || preScanResult.location) && (
                <div className="border border-white/15 bg-white/[0.02] p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <i className="fa-solid fa-eye text-white/30 text-[11px]"></i>
                    <span className="text-[11px] text-white/40 tracking-[0.2em] uppercase font-bold">Image Pre-Scan Results</span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[12px]">
                    {preScanResult.target && (
                      <div><span className="text-white/25">Target:</span> <span className="text-white/70 font-bold">{preScanResult.target}</span></div>
                    )}
                    {preScanResult.date && (
                      <div><span className="text-white/25">Date:</span> <span className="text-white/70">{preScanResult.date}</span></div>
                    )}
                    {preScanResult.time && (
                      <div><span className="text-white/25">Time:</span> <span className="text-white/70">{preScanResult.time}</span></div>
                    )}
                    {preScanResult.instrument && (
                      <div><span className="text-white/25">Instrument:</span> <span className="text-white/70">{preScanResult.instrument}</span></div>
                    )}
                    {preScanResult.location && (
                      <div><span className="text-white/25">Location:</span> <span className="text-white/70">{preScanResult.location}</span></div>
                    )}
                    {preScanResult.exposure && (
                      <div><span className="text-white/25">Exposure:</span> <span className="text-white/70">{preScanResult.exposure}</span></div>
                    )}
                  </div>
                </div>
              )}
              {isScanning && (
                <div className="border border-white/10 p-4 flex items-center gap-3">
                  <div className="w-4 h-4 border border-white/20 border-t-white/60 animate-spin"></div>
                  <span className="text-[12px] text-white/30 tracking-[0.2em] uppercase">Gemini scanning image for watermarks, timestamps, target names...</span>
                </div>
              )}

              <div>
                <label className="hud-label block mb-3">
                  Observation Date
                  {dateSource === 'exif' && <span className="text-white/20 ml-2 font-normal">(from image EXIF)</span>}
                  {dateSource === 'scan' && <span className="text-white/30 ml-2 font-normal">(from image watermark)</span>}
                  {dateSource === 'file' && <span className="text-white/40 ml-2 font-normal">!! from file date — verify this</span>}
                  {dateSource === 'none' && !isCheckingExif && !isScanning && <span className="text-white/60 ml-2 font-normal">!! NO DATE FOUND — you must set this</span>}
                </label>
                <input type="date" value={detectedDate} onChange={(e) => { handleDateChange(e.target.value); setDateSource('exif'); }} disabled={isCheckingExif}
                  className={`w-full px-5 py-4 bg-black border focus:border-white/40 text-white placeholder-white/15 outline-none transition-all appearance-none cursor-pointer text-sm tracking-wider ${
                    dateSource === 'none' && !isCheckingExif && !isScanning ? 'border-white/50 animate-pulse' :
                    dateSource === 'file' ? 'border-white/30' :
                    'border-white/15'
                  }`}
                  style={{ colorScheme: 'dark' }}
                />
                {dateSource !== 'exif' && dateSource !== 'scan' && !isCheckingExif && !isScanning && (
                  <p className="text-[11px] text-white/30 mt-2 tracking-wider leading-relaxed">
                    <i className="fa-solid fa-triangle-exclamation mr-1"></i>
                    Accurate date is critical for comet detection, NEO identification, and satellite trail matching.
                  </p>
                )}
              </div>
              <div>
                <label className="hud-label block mb-3">
                  Target Object
                  {targetComet && preScanResult?.target && targetComet === preScanResult.target
                    ? <span className="text-white/30 ml-2 font-normal">(detected from image)</span>
                    : <span className="text-white/15 ml-2 font-normal">(Optional)</span>
                  }
                </label>
                <input list="comet-suggestions" type="text" value={targetComet} onChange={(e) => setTargetComet(e.target.value)}
                  placeholder={isLoadingComets ? "FILTERING DATABASE..." : "SELECT OR TYPE OBJECT NAME..."}
                  className="w-full px-5 py-4 bg-black border border-white/15 focus:border-white/40 text-white placeholder-white/10 outline-none transition-all text-sm tracking-wider"
                />
                <datalist id="comet-suggestions">
                  {cometSuggestions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </datalist>
              </div>
            </div>
          </div>

          <div className="flex gap-4">
            <button onClick={handleCancel} className="hud-btn flex-1 py-4 text-sm opacity-40 hover:opacity-100">Cancel</button>
            <button
              onClick={handleConfirmUpload}
              disabled={!detectedDate}
              className="hud-btn flex-[2] py-4 text-sm border-white/40 hover:border-white disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:border-white/10"
            >
              <i className="fa-solid fa-play text-[10px]"></i>
              {!detectedDate ? 'Set Observation Date to Continue' : 'Initiate Analysis'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── DROPZONE ──
  return (
    <div className="max-w-5xl mx-auto mt-8 px-4">
      {/* Perspective grid background */}
      <div className="fixed inset-0 pointer-events-none z-0 opacity-40">
        <PerspectiveGrid opacity={0.08} />
      </div>

      <div className="text-center mb-12 relative z-10">
        <h2 className="text-3xl hud-title mb-4">Identify the Heavens</h2>
        <p className="text-white/25 text-xs tracking-[0.2em] uppercase max-w-2xl mx-auto leading-loose">
          Upload any photo of the night sky. The engine will plate-solve, detect sources, and cross-match against cataloged objects.
        </p>
      </div>

      <div
        onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`relative bg-black p-20 flex flex-col items-center justify-center transition-all duration-300 cursor-pointer group z-10 hud-frame hud-ticks-x
          ${isDragging ? 'hud-hatch-strong' : ''}
        `}
      >
        {/* Corner targeting marks */}
        <div className="absolute top-3 left-3 w-8 h-8 border-t-2 border-l-2 border-white/20"></div>
        <div className="absolute top-3 right-3 w-8 h-8 border-t-2 border-r-2 border-white/20"></div>
        <div className="absolute bottom-3 left-3 w-8 h-8 border-b-2 border-l-2 border-white/20"></div>
        <div className="absolute bottom-3 right-3 w-8 h-8 border-b-2 border-r-2 border-white/20"></div>

        {/* Scanning waveform at top */}
        <div className="absolute top-0 left-0 right-0 h-12 pointer-events-none">
          <Waveform type="scanning" className="opacity-10 h-full" />
        </div>

        <div className="w-20 h-20 border border-white/15 flex items-center justify-center mb-8 group-hover:border-white/30 transition-colors">
          <i className="fa-solid fa-cloud-arrow-up text-white/30 text-3xl group-hover:text-white/60 transition-colors"></i>
        </div>

        <p className="text-xl font-bold tracking-[0.3em] uppercase mb-3">Drop Sky Photo Here</p>
        <p className="text-white/20 text-xs tracking-[0.2em] uppercase">or click to browse filesystem</p>
        <p className="text-white/8 text-[11px] mt-10 tracking-[0.3em] uppercase">Supports RAW // JPEG // PNG // Up to 50MB</p>

        <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" accept="image/*" />
      </div>

      <div className="mt-0 grid grid-cols-1 md:grid-cols-3 gap-px bg-white/5 relative z-10">
        <FeatureCard icon="fa-bullseye" title="Plate Solving" desc="WCS mapping for precise sky coordinates." code="MOD::01" />
        <FeatureCard icon="fa-meteor" title="Comet Tracking" desc="JPL Horizons & COBS Telemetry integration." code="MOD::02" />
        <FeatureCard icon="fa-bolt" title="Streak Detection" desc="Spot satellites, meteors, and transients." code="MOD::03" />
      </div>
    </div>
  );
};

const FeatureCard = ({ icon, title, desc, code }: { icon: string; title: string; desc: string; code: string }) => (
  <div className="bg-black p-8 group hover:bg-white/[0.02] transition-colors">
    <div className="flex items-center justify-between mb-4">
      <div className="w-10 h-10 border border-white/10 flex items-center justify-center group-hover:border-white/25 transition-colors">
        <i className={`fa-solid ${icon} text-white/30 group-hover:text-white/60 transition-colors`}></i>
      </div>
      <span className="text-[9px] text-white/8 tracking-[0.3em]">{code}</span>
    </div>
    <h3 className="text-sm font-bold tracking-[0.2em] uppercase mb-2">{title}</h3>
    <p className="text-white/20 text-xs leading-relaxed tracking-wider">{desc}</p>
  </div>
);
