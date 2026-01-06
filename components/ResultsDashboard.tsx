
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { IdentificationResult, ObjectType } from '../types';
import { askAstronomer } from '../services/gemini';

interface ResultsDashboardProps {
  results: IdentificationResult;
  image: string;
  exif?: any;
}

interface ChatMessage {
  role: 'user' | 'model';
  text: string;
}

// Sub-component for safe image loading
const ReferenceImage = ({ url, name }: { url: string, name: string }) => {
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Reset state if URL changes
  useEffect(() => {
    setError(false);
    setLoaded(false);
  }, [url]);

  if (error || !url) return null;

  return (
    <div className="relative mt-4 rounded-xl overflow-hidden border border-slate-700 bg-black aspect-video group/image shadow-lg">
        {/* Loader */}
        {!loaded && !error && (
            <div className="absolute inset-0 flex items-center justify-center bg-slate-900">
                 <div className="w-4 h-4 border-2 border-slate-600 border-t-indigo-500 rounded-full animate-spin"></div>
            </div>
        )}
        
        <img 
            src={url} 
            alt={name} 
            className={`w-full h-full object-cover transition-all duration-700 group-hover/image:scale-110 ${loaded ? 'opacity-100' : 'opacity-0'}`}
            onLoad={() => setLoaded(true)}
            onError={() => setError(true)}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-transparent opacity-0 group-hover/image:opacity-100 transition-opacity duration-300 flex items-end p-4">
            <span className="text-[10px] text-white font-mono uppercase tracking-widest flex items-center gap-2">
                <i className="fa-regular fa-image text-indigo-400"></i>
                External Reference
            </span>
        </div>
    </div>
  );
};

export const ResultsDashboard: React.FC<ResultsDashboardProps> = ({ results, image, exif }) => {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [hoveredId, setHoveredId] = useState<number | null>(null); // New hover state
  const [imageError, setImageError] = useState(false);
  const [imgSrc, setImgSrc] = useState<string | undefined>(results.plate_solve.annotated_image_url);
  const [retryCount, setRetryCount] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  
  // Lightbox View State
  const [viewMode, setViewMode] = useState<'fit' | 'original'>('fit');

  // Comparator State
  const [sliderPosition, setSliderPosition] = useState(50);
  const [isDraggingSlider, setIsDraggingSlider] = useState(false);
  const sliderRef = useRef<HTMLDivElement>(null);
  const [showLabels, setShowLabels] = useState(true);

  // References for Auto-Scroll
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Chat State
  const [chatInput, setChatInput] = useState("");
  const [isChatting, setIsChatting] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Reset state when results change
  useEffect(() => {
    setImgSrc(results.plate_solve.annotated_image_url);
    setRetryCount(0);
    setImageError(false);
    setLightboxOpen(false);
    setViewMode('fit');
    setChatHistory([]);
    setSliderPosition(50);
    setSelectedId(null);
    setHoveredId(null);
  }, [results.plate_solve.annotated_image_url]);

  // Auto-scroll effect
  useEffect(() => {
    if (selectedId !== null && itemRefs.current[selectedId]) {
      itemRefs.current[selectedId]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [selectedId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory, isChatting]);

  const handleImageError = () => {
    if (!results.plate_solve.annotated_image_url) {
        setImageError(true);
        return;
    }

    const originalUrl = results.plate_solve.annotated_image_url;
    const fullUrl = originalUrl.replace('annotated_display', 'annotated_full');

    if (retryCount === 0) {
      setImgSrc(`https://corsproxy.io/?${encodeURIComponent(originalUrl)}`);
      setRetryCount(1);
    } else if (retryCount === 1) {
      setImgSrc(fullUrl);
      setRetryCount(2);
    } else if (retryCount === 2) {
      setImgSrc(`https://corsproxy.io/?${encodeURIComponent(fullUrl)}`);
      setRetryCount(3);
    } else {
      setImageError(true);
    }
  };

  const handleChatSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || isChatting) return;

    const userMsg = chatInput;
    setChatInput("");
    setIsChatting(true);
    setChatHistory(prev => [...prev, { role: 'user', text: userMsg }]);

    try {
      const response = await askAstronomer(userMsg, image, results, chatHistory);
      setChatHistory(prev => [...prev, { role: 'model', text: response }]);
    } catch (error) {
      setChatHistory(prev => [...prev, { role: 'model', text: "I apologize, but I encountered an error analyzing that request." }]);
    } finally {
      setIsChatting(false);
    }
  };

  const handleSliderMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (sliderRef.current) {
      const rect = sliderRef.current.getBoundingClientRect();
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
      setSliderPosition((x / rect.width) * 100);
    }
  };

  const isFallback = results.plate_solve.wcs_quality === 0;

  const filteredIdentifications = useMemo(() => {
    return (results.identifications || []).filter(item => {
      if (!item.primary_name) return false;
      const n = item.primary_name.toLowerCase();
      return !n.includes('field star') && 
             !n.includes('unidentified') && 
             !n.includes('background') && 
             !n.includes('unknown');
    });
  }, [results.identifications]);

  // Helper to match an annotation name (from Astrometry) to a catalog item (from Gemini)
  const findCatalogIndexForAnnotation = (names: string[]): number => {
    if (!names || names.length === 0) return -1;
    
    return filteredIdentifications.findIndex(item => {
        const catalogName = item.primary_name?.toLowerCase() || "";
        // Check if any of the annotation names are contained in the catalog name OR vice versa
        return names.some(n => {
            const lowerN = n.toLowerCase();
            return catalogName.includes(lowerN) || lowerN.includes(catalogName);
        });
    });
  };

  const handleLabelClick = (e: React.MouseEvent, names: string[]) => {
    e.stopPropagation(); // Prevent slider drag start
    const idx = findCatalogIndexForAnnotation(names);
    if (idx !== -1) {
        setSelectedId(idx === selectedId ? null : idx);
    }
  };

  const getBadgeColor = (type: string) => {
    const t = type.toLowerCase();
    if (t.includes('star')) return 'bg-yellow-400/20 text-yellow-400 border-yellow-400/30';
    if (t.includes('galaxy')) return 'bg-purple-400/20 text-purple-400 border-purple-400/30';
    if (t.includes('nebula')) return 'bg-pink-400/20 text-pink-400 border-pink-400/30';
    if (t.includes('comet')) return 'bg-cyan-400/20 text-cyan-400 border-cyan-400/30';
    return 'bg-indigo-400/20 text-indigo-400 border-indigo-400/30';
  };

  // Calculate Aspect Ratio for Perfect Alignment
  const imgW = results.plate_solve.image_width || 1;
  const imgH = results.plate_solve.image_height || 1;
  const aspectRatio = imgW / imgH;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 pb-12 animate-in fade-in duration-1000">
      
      {/* 1. Header Metrics */}
      <div className="xl:col-span-12">
        <div className={`
           border rounded-[2.5rem] p-8 flex flex-wrap gap-8 items-center justify-between shadow-2xl relative overflow-hidden transition-colors duration-500
           ${isFallback ? 'bg-[#1a0f0f] border-red-900/30' : 'bg-[#0b0f1a] border-slate-800'}
        `}>
          <div className={`absolute top-0 right-0 w-64 h-64 blur-[100px] pointer-events-none ${isFallback ? 'bg-red-500/5' : 'bg-indigo-500/5'}`}></div>
          <div className="flex items-center gap-6 relative z-10">
            <div className={`
              w-16 h-16 rounded-2xl flex items-center justify-center border shadow-inner
              ${isFallback ? 'bg-red-900/20 border-red-500/30' : 'bg-indigo-600/20 border-indigo-500/30'}
            `}>
              {isFallback ? (
                <i className="fa-solid fa-eye text-red-400 text-2xl"></i>
              ) : (
                <i className="fa-solid fa-compass-drafting text-indigo-400 text-2xl"></i>
              )}
            </div>
            <div>
              <h2 className="text-2xl font-bold text-white tracking-tight">
                {isFallback ? 'VISUAL ANALYSIS ONLY' : `WCS SOLUTION: ${results.plate_solve.constellation || 'Cataloged Field'}`}
              </h2>
              <div className="flex items-center gap-3 mt-1">
                 {isFallback ? (
                   <span className="text-red-400 text-xs font-mono uppercase tracking-[0.2em] font-bold">Plate Solve Failed • AI Estimated</span>
                 ) : (
                   <>
                     <p className="text-slate-400 text-xs font-mono uppercase tracking-[0.2em] opacity-70">
                       Job #{results.plate_solve.job_id}
                     </p>
                     <span className="text-slate-600">|</span>
                     <p className="text-slate-400 text-xs font-mono uppercase tracking-[0.2em] opacity-70">
                       α: {results.plate_solve.center_ra} • δ: {results.plate_solve.center_dec}
                     </p>
                   </>
                 )}
              </div>
            </div>
          </div>
          <div className="flex gap-8 relative z-10">
            <div className="text-right">
              <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest block mb-1">Astrometric Quality</span>
              <div className={`text-2xl font-mono font-bold tracking-tighter ${isFallback ? 'text-red-400' : 'text-emerald-400'}`}>
                {(results.plate_solve.wcs_quality).toFixed(2)}%
              </div>
            </div>
            <div className="w-px h-12 bg-slate-800"></div>
            <div className="text-right">
              <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest block mb-1">Pixel Scale</span>
              <div className="text-2xl font-mono text-white font-bold tracking-tighter">{results.plate_solve.plate_scale}</div>
            </div>
          </div>
        </div>
      </div>

      {/* 2. Interactive Comparator (Nano Banana Pro) */}
      <div className="xl:col-span-12">
        <div className="relative rounded-[2rem] overflow-hidden border border-slate-800 shadow-2xl h-[70vh] group select-none flex items-center justify-center bg-black">
          
          <div className="absolute top-6 left-6 z-20 flex flex-wrap gap-2 pointer-events-none">
            <div className="bg-black/60 px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-widest text-white backdrop-blur-md border border-white/10 shadow-lg flex items-center gap-2">
              <i className="fa-regular fa-image text-indigo-400"></i> Optical
            </div>
            {results.generated_annotation_image && (
                <div className="flex gap-2">
                    <div className="bg-white/90 px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-widest text-black backdrop-blur-md border border-white/10 shadow-lg flex items-center gap-2">
                        <i className="fa-solid fa-bezier-curve"></i> Vector Map
                    </div>
                    {/* Toggle Labels Button */}
                    <button 
                        onClick={(e) => { e.stopPropagation(); setShowLabels(!showLabels); }}
                        className={`
                            pointer-events-auto px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-widest backdrop-blur-md border border-white/10 shadow-lg flex items-center gap-2 transition-all
                            ${showLabels ? 'bg-indigo-600 text-white hover:bg-indigo-500' : 'bg-slate-800/80 text-slate-400 hover:bg-slate-700'}
                        `}
                    >
                        <i className={`fa-solid ${showLabels ? 'fa-tag' : 'fa-tag text-slate-500'}`}></i>
                        {showLabels ? 'Labels On' : 'Labels Off'}
                    </button>
                </div>
            )}
          </div>

          {/* 
              CONSTRAINED ASPECT RATIO CONTAINER 
          */}
          {results.generated_annotation_image ? (
             <div 
               ref={sliderRef}
               className="relative cursor-col-resize touch-none shadow-2xl"
               style={{ 
                   aspectRatio: aspectRatio,
                   // Fit within the 70vh container while maintaining aspect ratio
                   height: aspectRatio > (sliderRef.current?.parentElement?.clientWidth || 1000) / (sliderRef.current?.parentElement?.clientHeight || 800) ? 'auto' : '100%',
                   width: aspectRatio > (sliderRef.current?.parentElement?.clientWidth || 1000) / (sliderRef.current?.parentElement?.clientHeight || 800) ? '100%' : 'auto',
                   maxWidth: '100%',
                   maxHeight: '100%'
               }}
               onMouseMove={(e) => isDraggingSlider && handleSliderMove(e)}
               onTouchMove={(e) => isDraggingSlider && handleSliderMove(e)}
               onMouseDown={() => setIsDraggingSlider(true)}
               onTouchStart={() => setIsDraggingSlider(true)}
               onMouseUp={() => setIsDraggingSlider(false)}
               onTouchEnd={() => setIsDraggingSlider(false)}
               onMouseLeave={() => setIsDraggingSlider(false)}
             >
                {/* 1. Background: Original Image */}
                <img src={image} className="absolute inset-0 w-full h-full object-cover select-none" alt="Original" />

                {/* 2. Foreground: Generated Vector Map (Clipped) */}
                <div 
                  className="absolute inset-0 overflow-hidden bg-white"
                  style={{ clipPath: `inset(0 ${100 - sliderPosition}% 0 0)` }}
                >
                    <img 
                        src={results.generated_annotation_image} 
                        className="absolute inset-0 w-full h-full object-cover invert select-none" 
                        alt="Vector Map" 
                    />
                    
                    {/* 3. Overlays (Inside clipped area so they hide with the slider) */}
                    {showLabels && results.plate_solve.annotations?.map((anno, idx) => {
                           // Normalize coordinates to percentage
                           const left = (anno.pixelx / imgW) * 100;
                           const top = (anno.pixely / imgH) * 100;
                           
                           // Match against selected sidebar ID
                           const relatedCatalogIdx = findCatalogIndexForAnnotation(anno.names);
                           
                           // State Checks
                           const isSelected = relatedCatalogIdx !== -1 && relatedCatalogIdx === selectedId;
                           const isHovered = relatedCatalogIdx !== -1 && relatedCatalogIdx === hoveredId;
                           const isInteractive = relatedCatalogIdx !== -1;
                           const isActive = isSelected || isHovered;

                           if(left < 0 || left > 100 || top < 0 || top > 100) return null;

                           return (
                             <div 
                               key={idx}
                               onClick={(e) => isInteractive && handleLabelClick(e, anno.names)}
                               onMouseEnter={() => isInteractive && setHoveredId(relatedCatalogIdx)}
                               onMouseLeave={() => isInteractive && setHoveredId(null)}
                               className={`
                                 absolute transform -translate-x-1/2 -translate-y-1/2 transition-all duration-300 group/label z-10
                                 ${isInteractive ? 'cursor-pointer hover:z-50' : 'pointer-events-none opacity-50'}
                                 ${isSelected ? 'z-50' : ''}
                               `}
                               style={{ left: `${left}%`, top: `${top}%` }}
                             >
                               {/* Reticle / Marker */}
                               <div className="relative flex items-center justify-center">
                                    {isActive && (
                                        <div className="absolute w-8 h-8 border border-indigo-400 rounded-full animate-ping opacity-75"></div>
                                    )}
                                    {isActive && (
                                        <div className="absolute w-12 h-12 border border-white/30 rounded-full animate-spin-slow"></div>
                                    )}
                                    <div className={`
                                        rounded-full border transition-all duration-300 shadow-sm relative z-10
                                        ${isActive 
                                            ? 'w-4 h-4 bg-indigo-600 border-white shadow-[0_0_15px_rgba(99,102,241,1)] scale-110' 
                                            : 'w-2 h-2 bg-white/20 border-black/50 group-hover/label:bg-indigo-400 group-hover/label:border-indigo-600'}
                                    `}></div>
                               </div>
                               
                               {/* Label Text */}
                               <div className={`
                                 mt-2 px-2 py-1 rounded-md shadow-sm text-center transition-all duration-300 whitespace-nowrap backdrop-blur-md
                                 absolute left-1/2 -translate-x-1/2
                                 ${isActive 
                                    ? 'bg-indigo-600/90 text-white font-bold text-[11px] border border-white/20 shadow-xl translate-y-1' 
                                    : 'bg-white/80 text-black font-mono font-semibold text-[9px] border border-black/10 group-hover/label:bg-indigo-50 group-hover/label:text-indigo-700'}
                               `}>
                                  {anno.names[0]}
                               </div>
                             </div>
                           );
                    })}
                </div>

                {/* 4. Slider Handle */}
                <div 
                  className="absolute top-0 bottom-0 w-1 bg-white cursor-col-resize z-30 shadow-[0_0_20px_rgba(0,0,0,0.5)]"
                  style={{ left: `${sliderPosition}%` }}
                >
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 bg-white rounded-full flex items-center justify-center shadow-lg transition-transform hover:scale-110 active:scale-95">
                    <i className="fa-solid fa-arrows-left-right text-black text-xs"></i>
                  </div>
                </div>
             </div>
          ) : (
            <div className="w-full h-full flex items-center justify-center">
               <img src={image} alt="Scientific Observation" className="max-w-full max-h-full object-contain" />
            </div>
          )}
        </div>
      </div>

      {/* 3. Left Column: Annotated Plot & Analysis */}
      <div className="xl:col-span-8 space-y-6">
        
        {/* Astrometry Plot & Analysis */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Plot Container */}
            <div className="bg-black border border-slate-800 rounded-[2rem] overflow-hidden relative group shadow-2xl aspect-square md:aspect-auto">
                <div className={`
                absolute top-4 left-4 px-3 py-1.5 rounded-xl text-[10px] font-bold uppercase tracking-widest text-white backdrop-blur-md border z-10 shadow-lg
                ${isFallback ? 'bg-red-900/80 border-red-500/30' : 'bg-indigo-600/90 border-indigo-400/30'}
                `}>
                <i className={`fa-solid ${isFallback ? 'fa-ban' : 'fa-bullseye'} mr-2`}></i>
                {isFallback ? 'Plot Unavailable' : 'Astrometry Plot'}
                </div>
                
                {results.plate_solve.annotated_image_url && !imageError && (
                <button 
                    onClick={() => { setLightboxOpen(true); setViewMode('fit'); }}
                    className="absolute top-4 right-4 bg-black/60 hover:bg-black/80 text-white p-2 rounded-lg backdrop-blur-md border border-white/10 z-20 transition-all cursor-pointer"
                    title="Enlarge Plot"
                >
                    <i className="fa-solid fa-expand"></i>
                </button>
                )}

                <div className="w-full h-full min-h-[300px] bg-slate-900 flex items-center justify-center relative">
                    {imgSrc && !imageError ? (
                    <img 
                        src={imgSrc} 
                        alt="Astrometry.net Plot" 
                        className="w-full h-full object-contain cursor-pointer hover:scale-[1.02] transition-transform duration-300"
                        onError={handleImageError}
                        onClick={() => { setLightboxOpen(true); setViewMode('fit'); }}
                        referrerPolicy="no-referrer"
                    />
                    ) : (
                    <div className="flex flex-col items-center justify-center text-slate-500 p-8 text-center w-full h-full">
                        <i className={`fa-solid ${isFallback ? 'fa-eye-slash' : 'fa-images'} text-4xl mb-4 opacity-50 ${isFallback ? 'text-red-500' : 'text-slate-400'}`}></i>
                        {isFallback ? (
                            <p className="text-xs uppercase tracking-widest mb-2 text-red-400">Plate Solve Failed</p>
                        ) : (
                            <div className="text-center">
                                <p className="text-xs uppercase tracking-widest mb-2 text-slate-400">Preview Blocked</p>
                                <a 
                                    href={results.plate_solve.annotated_image_url?.replace('annotated_display', 'annotated_full')}
                                    target="_blank" 
                                    rel="noopener noreferrer"
                                    className="bg-slate-800 hover:bg-slate-700 text-indigo-400 border border-slate-700 px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 mx-auto"
                                >
                                    <i className="fa-solid fa-external-link-alt"></i>
                                    View Externally
                                </a>
                            </div>
                        )}
                    </div>
                    )}
                </div>
            </div>

            {/* Analysis Text */}
            <div className="flex flex-col gap-6">
                <div className="bg-[#0b0f1a] border border-slate-800 rounded-[2rem] p-8 flex-grow">
                    <h3 className="text-indigo-400 font-bold text-sm uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
                    <i className="fa-solid fa-brain"></i>
                    Gemini 3 Pro Analysis
                    </h3>
                    <p className="text-slate-300 leading-relaxed font-light text-sm">
                    {results.summary}
                    </p>
                </div>

                {/* Grounding Sources */}
                {results.sources && results.sources.length > 0 && (
                    <div className="bg-[#0b0f1a] border border-slate-800 rounded-[2rem] p-6">
                        <h3 className="text-white font-bold text-xs uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
                        <i className="fa-brands fa-google text-slate-400"></i>
                        Scientific Grounding Sources
                        </h3>
                        <div className="grid grid-cols-1 gap-2">
                        {results.sources.map((source, i) => (
                            <a 
                            key={i} 
                            href={source.uri} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="flex items-center gap-3 p-3 bg-slate-900/60 hover:bg-slate-800 border border-slate-800 rounded-xl transition-all group"
                            >
                            <div className="w-6 h-6 rounded-lg bg-indigo-900/30 flex items-center justify-center text-indigo-400 border border-indigo-500/20 group-hover:border-indigo-400/50">
                                <i className="fa-solid fa-link text-[10px]"></i>
                            </div>
                            <div className="overflow-hidden">
                                <div className="text-slate-200 text-[10px] font-bold truncate group-hover:text-white">{source.title}</div>
                            </div>
                            </a>
                        ))}
                        </div>
                    </div>
                )}
            </div>
        </div>

        {/* Horizons / Comet Telemetry Card */}
        {(results.horizons || results.comet) && (
          <div className="bg-[#0b0f1a] border border-indigo-500/30 rounded-[2rem] p-6 shadow-xl relative overflow-hidden group animate-pulse-slow">
             <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-cyan-400 to-transparent opacity-50"></div>
             <div className="absolute -right-10 -bottom-10 w-40 h-40 bg-cyan-500/10 blur-[60px] pointer-events-none"></div>
             
             <div className="flex items-center justify-between mb-4 relative z-10">
                <h3 className="text-white font-bold text-sm uppercase tracking-[0.2em] flex items-center gap-2">
                  <i className="fa-solid fa-meteor text-cyan-400"></i>
                  Precision Target Telemetry
                </h3>
                {results.horizons && (
                    <span className="text-[9px] text-emerald-300 font-mono border border-emerald-500/30 bg-emerald-900/20 rounded-full px-2 py-0.5 animate-pulse">JPL HORIZONS LOCKED</span>
                )}
             </div>

             <div className="grid grid-cols-1 md:grid-cols-2 gap-6 relative z-10">
                <div>
                   <h4 className="text-2xl font-bold text-white mb-1 tracking-tight">
                        {results.horizons?.id || results.comet?.object.fullname}
                   </h4>
                   <p className="text-xs text-slate-400 font-mono mb-4">
                        {results.horizons ? 'Ephemeris Tracking Active' : `${results.comet?.object.type} Type Comet`}
                   </p>
                   
                   <div className="flex gap-4">
                     <div className="bg-slate-900/60 border border-slate-800 p-3 rounded-xl flex-1">
                        <span className="text-[9px] text-slate-500 uppercase font-bold block mb-1">Magnitude</span>
                        <span className="text-xl text-cyan-400 font-mono font-bold">
                            {results.horizons?.magnitude || results.comet?.recent_observations?.[0]?.magnitude || 'N/A'}
                        </span>
                     </div>
                     <div className="bg-slate-900/60 border border-slate-800 p-3 rounded-xl flex-1">
                        <span className="text-[9px] text-slate-500 uppercase font-bold block mb-1">
                            {results.horizons ? 'Distance (Earth)' : 'Perihelion (q)'}
                        </span>
                        <span className="text-xl text-white font-mono font-bold">
                            {results.horizons?.distance_au || results.comet?.orbit.q} AU
                        </span>
                     </div>
                   </div>
                </div>

                <div className="space-y-2 text-[10px] font-mono text-slate-400 bg-slate-950/50 p-4 rounded-xl border border-slate-800">
                    {results.horizons ? (
                        <>
                            <div className="flex justify-between border-b border-slate-800 pb-2 mb-2">
                                <span>Predicted RA (ICRF)</span>
                                <span className="text-white">{results.horizons.ra}</span>
                            </div>
                            <div className="flex justify-between border-b border-slate-800 pb-2 mb-2">
                                <span>Predicted Dec (ICRF)</span>
                                <span className="text-white">{results.horizons.dec}</span>
                            </div>
                            <div className="flex justify-between border-b border-slate-800 pb-2 mb-2">
                                <span>Velocity (Relative)</span>
                                <span className="text-white">{results.horizons.velocity_kms} km/s</span>
                            </div>
                            <div className="flex justify-between">
                                <span>Timestamp (UT)</span>
                                <span className="text-indigo-300">{results.horizons.timestamp}</span>
                            </div>
                        </>
                    ) : (
                        // Fallback to COBS orbit data
                        <>
                            <div className="flex justify-between border-b border-slate-800 pb-2 mb-2">
                                <span>Inclination (i)</span>
                                <span className="text-white">{results.comet?.orbit.i}°</span>
                            </div>
                            <div className="flex justify-between border-b border-slate-800 pb-2 mb-2">
                                <span>Period (per)</span>
                                <span className="text-white">{results.comet?.orbit.per} Years</span>
                            </div>
                            <div className="flex justify-between border-b border-slate-800 pb-2 mb-2">
                                <span>Eccentricity (e)</span>
                                <span className="text-white">{results.comet?.orbit.e}</span>
                            </div>
                            <div className="flex justify-between">
                                <span>Perihelion Date</span>
                                <span className="text-indigo-300">{results.comet?.orbit.tp_cd.split(' ')[0]}</span>
                            </div>
                        </>
                    )}
                </div>
             </div>
          </div>
        )}

        {/* Solar System Radar (NASA JPL Data) */}
        <div className="bg-[#0b0f1a] border border-slate-800 rounded-[2rem] p-6 shadow-xl relative overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/5 blur-[50px] pointer-events-none"></div>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-white font-bold text-sm uppercase tracking-[0.2em] flex items-center gap-2 z-10">
              <i className="fa-solid fa-satellite text-indigo-400"></i>
              Solar System Radar
            </h3>
            <span className="text-[9px] text-slate-500 font-mono border border-slate-800 rounded-full px-2 py-0.5">NASA NeoWs</span>
          </div>

          <p className="text-slate-400 text-xs mb-4 max-w-2xl leading-relaxed">
            Real-time telemetry of Near-Earth Objects (Asteroids/Comets) within <span className="text-white font-bold">0.1 AU</span> of Earth at the time of observation. These are potential candidates for unidentified streaks.
          </p>

          {!results.neos || results.neos.length === 0 ? (
            <div className="text-center py-6 bg-slate-900/40 border border-slate-800 rounded-xl border-dashed">
              <p className="text-slate-500 text-xs uppercase tracking-widest">Sector Clear • No Close Approaches</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {results.neos.map((neo, idx) => (
                <div key={idx} className="bg-slate-900/60 border border-slate-800 p-3 rounded-xl hover:border-indigo-500/30 transition-colors group">
                  <div className="flex justify-between items-start mb-2">
                    <span className="text-[10px] text-indigo-300 font-bold font-mono truncate max-w-[70%]">{neo.fullname}</span>
                    <span className="text-[9px] text-slate-500 bg-slate-950 px-1.5 py-0.5 rounded uppercase">{neo.h} H</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[9px] text-slate-400 font-mono">
                    <div>
                      <span className="block text-slate-600 uppercase text-[8px]">Distance</span>
                      <span className="text-white">{(parseFloat(neo.dist) * 389.17).toFixed(1)} LD</span>
                    </div>
                    <div>
                      <span className="block text-slate-600 uppercase text-[8px]">Velocity</span>
                      <span className="text-white">{parseFloat(neo.v_rel).toFixed(1)} km/s</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* CHAT INTERFACE */}
        <div className="bg-[#0b0f1a] border border-slate-800 rounded-[2.5rem] overflow-hidden flex flex-col shadow-2xl mt-8">
            <div className="px-8 py-4 bg-slate-900/50 border-b border-slate-800 flex items-center justify-between">
                <h3 className="text-white font-bold text-sm uppercase tracking-[0.2em] flex items-center gap-2">
                    <i className="fa-solid fa-comments text-indigo-400"></i>
                    Ask the Astronomer
                </h3>
                <span className="text-[10px] text-slate-500 font-mono">Gemini 3 Pro Active</span>
            </div>
            
            <div className="p-8 min-h-[300px] max-h-[500px] overflow-y-auto custom-scrollbar bg-black/20 space-y-6">
                {chatHistory.length === 0 && (
                    <div className="text-center py-12 opacity-50">
                         <i className="fa-solid fa-hand-sparkles text-4xl text-slate-700 mb-4"></i>
                         <p className="text-slate-500 text-sm">Have a question about this image?<br/>Ask about distance, composition, or history.</p>
                    </div>
                )}
                {chatHistory.map((msg, idx) => (
                    <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`
                            max-w-[80%] p-4 rounded-2xl text-sm leading-relaxed
                            ${msg.role === 'user' 
                                ? 'bg-indigo-600/20 text-indigo-100 border border-indigo-500/30 rounded-tr-sm' 
                                : 'bg-slate-800/50 text-slate-300 border border-slate-700 rounded-tl-sm'}
                        `}>
                            {msg.text}
                        </div>
                    </div>
                ))}
                {isChatting && (
                     <div className="flex justify-start">
                        <div className="bg-slate-800/50 px-4 py-3 rounded-2xl rounded-tl-sm flex gap-2 items-center">
                            <div className="w-2 h-2 bg-indigo-500 rounded-full animate-bounce"></div>
                            <div className="w-2 h-2 bg-indigo-500 rounded-full animate-bounce delay-75"></div>
                            <div className="w-2 h-2 bg-indigo-500 rounded-full animate-bounce delay-150"></div>
                        </div>
                     </div>
                )}
                <div ref={chatEndRef} />
            </div>

            <form onSubmit={handleChatSubmit} className="p-4 bg-slate-900/80 border-t border-slate-800 flex gap-4">
                <input 
                    type="text" 
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Ask a follow-up question..."
                    className="flex-grow bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
                />
                <button 
                    type="submit" 
                    disabled={!chatInput.trim() || isChatting}
                    className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-3 rounded-xl font-bold transition-all shadow-lg shadow-indigo-500/20"
                >
                    <i className="fa-solid fa-paper-plane"></i>
                </button>
            </form>
        </div>

      </div>

      {/* 4. Right Column: Catalog Registry */}
      <div className="xl:col-span-4 space-y-4 max-h-[1100px] overflow-y-auto pr-3 custom-scrollbar scroll-smooth">
        <div className="sticky top-0 z-10 bg-[#020408]/90 backdrop-blur-md pb-4 pt-2 mb-2">
          <h3 className="text-white font-bold text-sm uppercase tracking-[0.2em] flex items-center gap-2">
            <i className="fa-solid fa-list-check text-indigo-400"></i>
            Catalog Registry
          </h3>
        </div>
        
        {filteredIdentifications.length === 0 ? (
          <div className="text-center py-20 bg-slate-900/20 border border-dashed border-slate-800 rounded-3xl">
             <i className="fa-solid fa-ghost text-slate-800 text-4xl mb-4"></i>
             <p className="text-slate-600 font-mono text-xs uppercase tracking-widest">No major objects listed in catalog</p>
          </div>
        ) : filteredIdentifications.map((item, idx) => (
          <div 
            key={idx}
            ref={(el) => { itemRefs.current[idx] = el; }}
            onClick={() => setSelectedId(selectedId === idx ? null : idx)}
            onMouseEnter={() => setHoveredId(idx)}
            onMouseLeave={() => setHoveredId(null)}
            className={`bg-[#0b0f1a] border p-6 rounded-[2rem] cursor-pointer transition-all duration-300 group relative overflow-hidden
              ${(selectedId === idx || hoveredId === idx) 
                 ? 'border-indigo-500/60 ring-2 ring-indigo-500/20 shadow-2xl bg-[#0e1424] scale-[1.02]' 
                 : 'border-slate-800 hover:border-slate-700 shadow-lg'}
            `}
          >
            {/* Background catalog ID decoration */}
            <div className="absolute -bottom-4 -right-4 text-[60px] font-black text-white/5 italic pointer-events-none select-none">
              {item.catalog_id?.split(' ')[0] || 'STAR'}
            </div>

            <div className="flex justify-between items-start mb-4 relative z-10">
              <div className={`px-3 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest border ${getBadgeColor(item.object_type)}`}>
                {item.object_type}
              </div>
              <button 
                  onClick={(e) => { e.stopPropagation(); setSelectedId(idx); }}
                  className="text-slate-500 hover:text-indigo-400 transition-colors"
                  title="Locate in Image"
              >
                  <i className="fa-solid fa-crosshairs"></i>
              </button>
            </div>
            
            <h4 className="text-lg font-bold text-white mb-1 group-hover:text-indigo-400 transition-colors tracking-tight">{item.primary_name}</h4>
            <p className="text-[10px] text-slate-500 font-mono tracking-wider opacity-80">{item.ra} • {item.dec}</p>
            
            {(selectedId === idx || hoveredId === idx) && (
              <div className="mt-6 space-y-4 animate-in fade-in slide-in-from-top-4 duration-300 border-t border-slate-800 pt-6">
                
                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 bg-slate-900/60 border border-slate-800 rounded-xl">
                    <span className="text-[8px] text-slate-500 font-bold uppercase block mb-1">Catalog</span>
                    <span className="text-[10px] text-indigo-300 font-mono font-bold">{item.best_catalog || 'N/A'}</span>
                  </div>
                  <div className="p-3 bg-slate-900/60 border border-slate-800 rounded-xl">
                    <span className="text-[8px] text-slate-500 font-bold uppercase block mb-1">Separation</span>
                    <span className="text-[10px] text-indigo-300 font-mono font-bold">{item.separation_arcsec?.toFixed(2)}″</span>
                  </div>
                </div>

                {/* Reference Photo */}
                {item.reference_image_url && (
                    <ReferenceImage url={item.reference_image_url} name={item.primary_name || "Reference Object"} />
                )}

                <div className="p-4 bg-indigo-500/10 rounded-2xl border border-indigo-500/20 group/action hover:bg-indigo-500/20 transition-all mt-3">
                   <span className="text-[9px] text-indigo-400 font-black uppercase tracking-widest block mb-2">Expert Recommendation</span>
                   <p className="text-[11px] text-slate-300 leading-relaxed font-medium italic">"{item.recommended_followup}"</p>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      
        {/* Lightbox Modal */}
        {lightboxOpen && (
          <div className="fixed inset-0 z-[100] bg-black/95 flex items-center justify-center p-4 animate-in fade-in duration-300 backdrop-blur-sm">
            <button 
              onClick={() => setLightboxOpen(false)}
              className="absolute top-6 right-6 text-white/50 hover:text-white text-4xl transition-colors z-[110]"
            >
              <i className="fa-solid fa-xmark"></i>
            </button>
            <div className="w-full h-full max-w-7xl max-h-[90vh] flex flex-col items-center justify-center relative bg-slate-900/20 rounded-xl overflow-hidden">
              
              {/* Zoom Controls Overlay */}
              <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-slate-900/90 rounded-full px-2 py-1.5 border border-slate-700 z-[110] flex gap-2 shadow-xl backdrop-blur-md">
                 <button 
                   onClick={() => setViewMode('fit')}
                   className={`px-4 py-2 rounded-full text-xs font-bold transition-all ${viewMode === 'fit' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`}
                 >
                   <i className="fa-solid fa-compress mr-2"></i>Fit to Screen
                 </button>
                 <button 
                   onClick={() => setViewMode('original')}
                   className={`px-4 py-2 rounded-full text-xs font-bold transition-all ${viewMode === 'original' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`}
                 >
                   <i className="fa-solid fa-magnifying-glass-plus mr-2"></i>Full Size (Scroll)
                 </button>
              </div>

              {/* Image Container with Scrolling for Original Mode */}
              <div className={`
                w-full h-full flex 
                ${viewMode === 'fit' ? 'items-center justify-center' : 'items-start justify-start overflow-auto custom-scrollbar bg-black'}
              `}>
                  <img 
                    src={imgSrc} 
                    className={`
                      ${viewMode === 'fit' ? 'max-w-full max-h-full object-contain' : 'max-w-none cursor-grab active:cursor-grabbing'}
                      rounded-lg shadow-2xl transition-all duration-300
                    `}
                    alt="Full Plot"
                    referrerPolicy="no-referrer"
                    onError={handleImageError} 
                  />
              </div>

               <a 
                  href={results.plate_solve.annotated_image_url?.replace('annotated_display', 'annotated_full')}
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="absolute top-6 left-6 bg-slate-900/80 hover:bg-black text-white px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 border border-white/10 z-[110]"
                >
                  <i className="fa-solid fa-external-link-alt"></i>
                  Open Original Source
              </a>
            </div>
          </div>
        )}

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: rgba(0,0,0,0.1); }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 20px; border: 1px solid rgba(255,255,255,0.05); }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #334155; }
        .animate-pulse-slow { animation: pulse 4s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
        .animate-spin-slow { animation: spin 8s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
};
