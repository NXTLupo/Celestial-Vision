
import React, { useRef, useState, useEffect } from 'react';
import { getCometsByDate } from '../services/cobs';

declare const EXIF: any;

interface ImageUploaderProps {
  onUpload: (file: File, targetComet?: string, manualDate?: string) => void;
}

export const ImageUploader: React.FC<ImageUploaderProps> = ({ onUpload }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  
  // Staging State
  const [stagedFile, setStagedFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  
  // Selection State
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

  // Re-fetch suggestions whenever detectedDate changes (and is valid)
  useEffect(() => {
    if (detectedDate && detectedDate.length === 10) {
        fetchSuggestions(detectedDate);
    }
  }, [detectedDate]);

  const handleFileSelection = (file: File) => {
    setStagedFile(file);
    
    const reader = new FileReader();
    reader.onload = (e) => setFilePreview(e.target?.result as string);
    reader.readAsDataURL(file);

    // Extract EXIF Date immediately
    setIsCheckingExif(true);
    
    // Simulate EXIF read (lightweight version of what's in App.tsx)
    const timeoutId = setTimeout(() => {
       // Fallback if EXIF lib fails or is slow
       if (isCheckingExif) {
          const d = new Date().toISOString().split('T')[0];
          setDetectedDate(d);
          setIsCheckingExif(false);
       }
    }, 1000);

    try {
        EXIF.getData(file, function(this: any) {
            clearTimeout(timeoutId);
            const allMetaData = EXIF.getAllTags(this);
            const rawDate = allMetaData?.DateTimeOriginal;
            
            let finalDate = new Date().toISOString().split('T')[0]; // Default today

            if (rawDate) {
                // EXIF format is usually "YYYY:MM:DD HH:MM:SS"
                const parts = rawDate.split(' ');
                if (parts[0]) {
                    finalDate = parts[0].replace(/:/g, '-');
                }
            }
            
            setDetectedDate(finalDate);
            setIsCheckingExif(false);
        });
    } catch (e) {
        clearTimeout(timeoutId);
        const d = new Date().toISOString().split('T')[0];
        setDetectedDate(d);
        setIsCheckingExif(false);
    }
  };

  const handleDateChange = (date: string) => {
      setDetectedDate(date);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileSelection(file);
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const onDragLeave = () => setIsDragging(false);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileSelection(file);
  };

  const handleConfirmUpload = () => {
      if (stagedFile) {
          onUpload(stagedFile, targetComet, detectedDate);
      }
  };

  const handleCancel = () => {
      setStagedFile(null);
      setFilePreview(null);
      setTargetComet("");
      setDetectedDate("");
      setCometSuggestions([]);
  };

  // RENDER: PRE-ANALYSIS / TARGET SELECTION VIEW
  if (stagedFile) {
      return (
        <div className="max-w-2xl mx-auto mt-12 bg-slate-900/60 border border-slate-700 p-8 rounded-[2.5rem] shadow-2xl animate-in fade-in zoom-in-95 duration-300">
            <div className="text-center mb-8">
                <h2 className="text-2xl font-bold text-white mb-2">Initialize Analysis</h2>
                <p className="text-slate-400 text-sm">Review telemetry details before engaging AI model.</p>
            </div>

            <div className="flex gap-8 mb-8">
                {/* Thumbnail */}
                <div className="w-1/3 aspect-square rounded-2xl overflow-hidden border border-slate-700 bg-black relative shadow-lg">
                    {filePreview && (
                        <img src={filePreview} alt="Preview" className="w-full h-full object-cover" />
                    )}
                </div>

                {/* Details Form */}
                <div className="w-2/3 flex flex-col justify-center space-y-6">
                    <div>
                        <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block mb-2">Observation Date</label>
                        <div className="relative">
                           <i className="fa-regular fa-calendar absolute left-4 top-1/2 -translate-y-1/2 text-indigo-400 z-10 pointer-events-none"></i>
                           <input 
                                type="date"
                                value={detectedDate}
                                onChange={(e) => handleDateChange(e.target.value)}
                                disabled={isCheckingExif}
                                className="w-full pl-10 pr-4 py-3 bg-slate-800 border border-indigo-500/30 focus:border-indigo-500 rounded-xl text-white placeholder-slate-500 outline-none transition-all appearance-none cursor-pointer font-mono text-sm"
                                style={{ colorScheme: 'dark' }}
                           />
                           {isCheckingExif && (
                               <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 animate-pulse">Reading...</span>
                           )}
                        </div>
                    </div>

                    <div>
                        <label className="text-[10px] uppercase tracking-widest text-indigo-400 font-bold block mb-2">Target Comet (Optional)</label>
                        <div className="relative">
                            <i className="fa-solid fa-meteor absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 z-10"></i>
                            <input 
                                list="comet-suggestions"
                                type="text"
                                value={targetComet}
                                onChange={(e) => setTargetComet(e.target.value)}
                                placeholder={isLoadingComets ? "Filtering database..." : "Select or type object name..."}
                                className="w-full pl-10 pr-4 py-3 bg-slate-800 border border-indigo-500/30 focus:border-indigo-500 rounded-xl text-white placeholder-slate-500 outline-none transition-all"
                            />
                            <datalist id="comet-suggestions">
                                {cometSuggestions.map(s => (
                                    <option key={s.id} value={s.id}>{s.name}</option>
                                ))}
                            </datalist>
                            {isLoadingComets && (
                                <div className="absolute right-4 top-1/2 -translate-y-1/2">
                                    <div className="w-4 h-4 border-2 border-slate-500 border-t-indigo-500 rounded-full animate-spin"></div>
                                </div>
                            )}
                        </div>
                        {cometSuggestions.length > 0 && !isLoadingComets && (
                            <p className="text-[10px] text-slate-500 mt-2 ml-1">
                                <i className="fa-solid fa-circle-info mr-1"></i>
                                {detectedDate ? `Active bright comets around ${detectedDate}` : 'Most active comets'}
                            </p>
                        )}
                        {!isLoadingComets && cometSuggestions.length === 0 && detectedDate && (
                            <p className="text-[10px] text-slate-600 mt-2 ml-1 italic">
                                No major historical comets found active in this window.
                            </p>
                        )}
                    </div>
                </div>
            </div>

            <div className="flex gap-4">
                <button 
                    onClick={handleCancel}
                    className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold py-4 rounded-xl transition-all"
                >
                    Cancel
                </button>
                <button 
                    onClick={handleConfirmUpload}
                    className="flex-[2] bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-4 rounded-xl shadow-xl shadow-indigo-500/20 transition-all flex items-center justify-center gap-2"
                >
                    <i className="fa-solid fa-rocket"></i>
                    Launch Analysis
                </button>
            </div>
        </div>
      );
  }

  // RENDER: DROPZONE
  return (
    <div className="max-w-2xl mx-auto mt-12">
      <div className="text-center mb-10">
        <h2 className="text-3xl font-bold text-white mb-3">Identify the Heavens</h2>
        <p className="text-slate-400 max-w-lg mx-auto">
          Upload any photo of the night sky. Our engine will plate-solve, detect sources, and cross-match against millions of cataloged objects.
        </p>
      </div>

      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`
          relative border-2 border-dashed rounded-[2.5rem] p-16 flex flex-col items-center justify-center transition-all duration-300 cursor-pointer group
          ${isDragging 
            ? 'border-indigo-500 bg-indigo-500/10 scale-[1.02]' 
            : 'border-slate-700 bg-slate-900/40 hover:bg-slate-800/60 hover:border-slate-600'
          }
        `}
      >
        <div className="w-24 h-24 bg-slate-800 rounded-3xl flex items-center justify-center mb-6 shadow-xl group-hover:scale-110 transition-transform duration-300 border border-slate-700 group-hover:border-indigo-500/30">
          <i className="fa-solid fa-cloud-arrow-up text-indigo-400 text-4xl"></i>
        </div>
        
        <p className="text-2xl font-bold text-white mb-2">Drop your sky photo here</p>
        <p className="text-slate-500 text-sm mb-0">or click to browse filesystem</p>
        <p className="text-slate-600 text-[10px] mt-8 uppercase tracking-widest font-bold">Supports RAW, JPEG, PNG • Up to 50MB</p>

        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          className="hidden"
          accept="image/*"
        />
      </div>

      <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-6">
        <FeatureCard 
          icon="fa-bullseye" 
          title="Plate Solving" 
          desc="WCS mapping for precise sky coordinates." 
        />
        <FeatureCard 
          icon="fa-meteor" 
          title="Comet Tracking" 
          desc="JPL Horizons & COBS Telemetry integration." 
        />
        <FeatureCard 
          icon="fa-bolt" 
          title="Streak Detection" 
          desc="Spot satellites, meteors, and transients." 
        />
      </div>
    </div>
  );
};

const FeatureCard = ({ icon, title, desc }: { icon: string; title: string; desc: string }) => (
  <div className="bg-slate-900/50 border border-slate-800 p-5 rounded-2xl hover:border-slate-700 transition-colors">
    <div className="w-10 h-10 bg-slate-800 rounded-lg flex items-center justify-center mb-3">
      <i className={`fa-solid ${icon} text-indigo-400`}></i>
    </div>
    <h3 className="text-white font-semibold mb-1">{title}</h3>
    <p className="text-slate-400 text-sm leading-relaxed">{desc}</p>
  </div>
);
