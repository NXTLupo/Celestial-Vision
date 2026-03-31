
import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { IdentificationResult, ObjectType } from '../types';
import { askAstronomer } from '../services/gemini';
import { InstagramPublisher } from './InstagramPublisher';
import { PerspectiveGrid, StackedReticle, DataCalloutLine, Waveform, WireframeGlobe, AiThinkingAnimation, ImageLightbox } from './HudVisuals';
import { ArchivalPlates, CrossAnalysisReport } from './ArchivalPlates';
import { catalogIdsMatch } from '../utils/catalogMatch';

interface ResultsDashboardProps {
  results: IdentificationResult;
  image: string;
  exif?: any;
}

interface ChatMessage {
  role: 'user' | 'model' | 'system';
  text: string;
  images?: { url: string; label: string }[];
  anomalies?: CrossAnalysisReport['analysis']['anomalies'];
}

/** Renders markdown-lite text: **bold**, *italic*, bullet lists, paragraphs */
const FormattedText: React.FC<{ text: string }> = ({ text }) => {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let listBuffer: string[] = [];

  const flushList = () => {
    if (listBuffer.length === 0) return;
    elements.push(
      <ul key={`list-${elements.length}`} className="space-y-1.5 my-2 ml-1">
        {listBuffer.map((item, i) => (
          <li key={i} className="flex gap-2 items-start">
            <span className="text-white/25 mt-0.5 shrink-0">—</span>
            <span dangerouslySetInnerHTML={{ __html: inlineFormat(item) }} />
          </li>
        ))}
      </ul>
    );
    listBuffer = [];
  };

  const inlineFormat = (s: string): string => {
    return s
      .replace(/\*\*(.+?)\*\*/g, '<strong class="text-white/80 font-semibold">$1</strong>')
      .replace(/\*(.+?)\*/g, '<em class="text-white/40">$1</em>')
      .replace(/`(.+?)`/g, '<code class="text-[0.85em] bg-white/5 px-1 py-0.5 border border-white/10 font-mono">$1</code>');
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('- ') || line.startsWith('• ') || line.startsWith('* ')) {
      listBuffer.push(line.replace(/^[-•*]\s+/, ''));
    } else {
      flushList();
      if (line === '') {
        elements.push(<div key={`br-${i}`} className="h-2" />);
      } else {
        elements.push(
          <p key={`p-${i}`} dangerouslySetInnerHTML={{ __html: inlineFormat(line) }} />
        );
      }
    }
  }
  flushList();
  return <>{elements}</>;
};

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
    <div className="relative mt-4  overflow-hidden border border-white/10 bg-black aspect-video group/image ">
        {/* Loader */}
        {!loaded && !error && (
            <div className="absolute inset-0 flex items-center justify-center bg-black">
                 <div className="w-4 h-4 border-2 border-white/10 border-t-white  animate-spin"></div>
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
            <span className="text-[12px] text-white font-mono uppercase tracking-widest flex items-center gap-2">
                <i className="fa-regular fa-image text-white/50"></i>
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

  // Instagram Publisher State
  const [showInstagram, setShowInstagram] = useState(false);

  // Universal Image Lightbox State
  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt: string; invert?: boolean } | null>(null);

  // Archival cross-analysis reports (for Instagram)
  const [archivalReports, setArchivalReports] = useState<CrossAnalysisReport[]>([]);

  // Cross-analysis callback — injects archival findings into chat
  const handleCrossAnalysis = useCallback((report: CrossAnalysisReport) => {
    const year = report.plate.date_orig?.substring(0, 4) || '?';
    const baseline = report.plate.date_orig
      ? new Date().getFullYear() - parseInt(year)
      : 0;
    const anomalyCount = report.analysis.anomalies?.length || 0;

    const headerText = `**Cross-Epoch Analysis: Plate ${report.plate.plate_num || report.plate.plate_id}** (${year}, ${report.plate.telescope || 'Unknown telescope'})\nBaseline: ~${baseline} years\n\n${report.analysis.summary}`;

    const detailLines: string[] = [];
    if (report.analysis.plate_assessment) {
      detailLines.push(`*Plate Assessment:* ${report.analysis.plate_assessment}`);
    }
    if (anomalyCount > 0) {
      detailLines.push('');
      detailLines.push(`**${anomalyCount} anomal${anomalyCount !== 1 ? 'ies' : 'y'} detected:**`);
      report.analysis.anomalies.forEach((a, i) => {
        detailLines.push(`- **[${a.significance.toUpperCase()}] ${a.type.replace(/_/g, ' ').toUpperCase()}** — ${a.description}`);
        if (a.possible_explanations?.length) {
          detailLines.push(`  Possible: ${a.possible_explanations.join(', ')}`);
        }
      });
    } else {
      detailLines.push('\nNo significant anomalies detected between the two epochs. The field appears consistent across the time baseline.');
    }

    const fullText = headerText + '\n\n' + detailLines.join('\n');

    const images: ChatMessage['images'] = [
      { url: report.platePreviewUrl, label: `Archival Plate ${report.plate.plate_num || report.plate.plate_id} (${year})` }
    ];

    setChatHistory(prev => [...prev, {
      role: 'system' as const,
      text: fullText,
      images,
      anomalies: report.analysis.anomalies,
    }]);

    // Track for Instagram publisher
    setArchivalReports(prev => [...prev, report]);
  }, []);

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
      setImgSrc(originalUrl);
      setRetryCount(1);
    } else if (retryCount === 1) {
      setImgSrc(fullUrl);
      setRetryCount(2);
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
      // Build context string from system messages (archival analysis) to include in prompt
      const systemContext = chatHistory
        .filter(m => m.role === 'system')
        .map(m => m.text)
        .join('\n---\n');

      const contextPrefix = systemContext
        ? `[The following archival cross-analysis has been performed on this image. Use this context to inform your answer:\n${systemContext}\n]\n\n`
        : '';

      // Only pass user/model messages as chat history to Gemini
      const geminiHistory = chatHistory
        .filter(m => m.role === 'user' || m.role === 'model')
        .map(m => ({ role: m.role as 'user' | 'model', text: m.text }));

      const response = await askAstronomer(contextPrefix + userMsg, image, results, geminiHistory);
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

  const MIN_DISPLAY_CONFIDENCE = 0.3;

  const filteredIdentifications = useMemo(() => {
    return (results.identifications || []).filter(item => {
      if (!item.primary_name) return false;
      if ((item.confidence ?? 1) < MIN_DISPLAY_CONFIDENCE) return false;
      const n = item.primary_name.toLowerCase();
      return !n.includes('field star') &&
             !n.includes('unidentified') &&
             !n.includes('background') &&
             !n.includes('unknown');
    });
  }, [results.identifications]);

  // Helper to match an annotation name (from Astrometry) to a catalog item (from Gemini)
  // Uses proper catalog ID parsing — no more substring false positives
  const findCatalogIndexForAnnotation = (names: string[]): number => {
    if (!names || names.length === 0) return -1;

    return filteredIdentifications.findIndex(item => {
        const catalogName = item.primary_name || "";
        return names.some(n => catalogIdsMatch(n, catalogName));
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
    if (t.includes('satellite') || t.includes('debris') || t.includes('streak')) {
      return 'bg-white/20 text-white/90 border-white/40'; // Highlighted for streaks/debris
    }
    return 'bg-white/10 text-white/70 border-white/20';
  };

  // Calculate Aspect Ratio for Perfect Alignment
  const imgW = results.plate_solve.image_width || 1;
  const imgH = results.plate_solve.image_height || 1;
  const aspectRatio = imgW / imgH;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-px pb-12 animate-in fade-in duration-1000 bg-white/5">
      
      {/* 1. Header Metrics */}
      <div className="xl:col-span-12 bg-black">
        <div className="hud-frame hud-hatch p-6 flex flex-wrap gap-8 items-center justify-between relative">
          <div className="flex items-center gap-6">
            <div className="w-10 h-10 border border-white/20 flex items-center justify-center">
              {isFallback ? (
                <i className="fa-solid fa-eye text-white/40"></i>
              ) : (
                <i className="fa-solid fa-compass-drafting text-white/40"></i>
              )}
            </div>
            <div>
              <h2 className="text-xs font-bold tracking-[0.25em] uppercase">
                {isFallback ? 'Visual Analysis Only' : `WCS Solution // ${results.plate_solve.constellation || 'Cataloged Field'}`}
              </h2>
              <div className="flex items-center gap-3 mt-1">
                 {isFallback ? (
                   <span className="text-white/25 text-[10px] uppercase tracking-[0.2em]">!! Plate Solve Failed // AI Estimated</span>
                 ) : (
                   <p className="text-white/20 text-[10px] uppercase tracking-[0.2em]">
                     Job #{results.plate_solve.job_id} // a: {results.plate_solve.center_ra} // d: {results.plate_solve.center_dec}
                   </p>
                 )}
              </div>
            </div>
          </div>
          <div className="flex gap-6">
            <div className="text-right">
              <span className="text-[10px] text-white/30 tracking-[0.2em] uppercase block mb-1">Astrometric Quality</span>
              <div className="text-base font-bold tracking-widest">
                {(results.plate_solve.wcs_quality).toFixed(2)}%
              </div>
            </div>
            <div className="w-px h-10 bg-white/10"></div>
            <div className="text-right">
              <span className="hud-label block mb-1">Pixel Scale</span>
              <div className="text-lg font-bold text-white tracking-widest">{results.plate_solve.plate_scale}</div>
            </div>
          </div>
        </div>
      </div>

      {/* 1.5 Hero Waveform — full-width scanning telemetry */}
      <div className="xl:col-span-12 bg-black border-y border-white/5 hud-ticks-x">
        <Waveform type="scanning" className="h-14 opacity-20" />
      </div>

      {/* 2. MAIN CONTENT ROW: Comparator (left) + Plot/Catalog (right) — matched height */}
      <div className="xl:col-span-12">
       <div className="grid grid-cols-1 xl:grid-cols-[1fr_300px] gap-px bg-white/5" style={{height: '70vh'}}>

        {/* 2a. Interactive Comparator */}
        <div className="relative overflow-hidden h-full group select-none flex items-center justify-center bg-black">

          {/* Corner targeting marks */}
          <div className="absolute top-3 left-3 w-6 h-6 border-t border-l border-white/15 z-20 pointer-events-none"></div>
          <div className="absolute top-3 right-3 w-6 h-6 border-t border-r border-white/15 z-20 pointer-events-none"></div>
          <div className="absolute bottom-3 left-3 w-6 h-6 border-b border-l border-white/15 z-20 pointer-events-none"></div>
          <div className="absolute bottom-3 right-3 w-6 h-6 border-b border-r border-white/15 z-20 pointer-events-none"></div>

          <div className="absolute top-5 left-5 z-20 flex flex-wrap gap-2 pointer-events-none">
            <div className="bg-black/70 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.2em] text-white border border-white/10 flex items-center gap-2">
              <i className="fa-regular fa-image text-white/50"></i> Optical
            </div>
            {imgSrc && !imageError && (
                <div className="bg-white/90 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.2em] text-black border border-white/10 flex items-center gap-2">
                    <i className="fa-solid fa-bullseye text-[10px]"></i> Astrometry Plot
                </div>
            )}
          </div>

          {/* 
              CONSTRAINED ASPECT RATIO CONTAINER 
          */}
          {imgSrc && !imageError ? (
             <div 
               ref={sliderRef}
               className="relative cursor-col-resize touch-none "
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
                {/* 0. Perspective grid underlay */}
                <div className="absolute inset-0 pointer-events-none z-0">
                  <PerspectiveGrid opacity={0.03} />
                </div>

                {/* 1. Background: Original Image */}
                <img src={image} className="absolute inset-0 w-full h-full object-cover select-none" alt="Original" />

                {/* 1.5 NEO In-Field Markers — overlay on the photo side */}
                {results.neos?.filter(n => n.in_field && n.pixel_x != null && n.pixel_y != null).map((neo, idx) => {
                  const left = ((neo.pixel_x!) / imgW) * 100;
                  const top = ((neo.pixel_y!) / imgH) * 100;
                  if (left < 0 || left > 100 || top < 0 || top > 100) return null;
                  return (
                    <div
                      key={`neo-${idx}`}
                      className="absolute z-20 pointer-events-none transform -translate-x-1/2 -translate-y-1/2"
                      style={{ left: `${left}%`, top: `${top}%` }}
                    >
                      {/* Pulsing ring */}
                      <div className="absolute inset-0 w-10 h-10 -ml-5 -mt-5 border border-white/60 animate-ping" style={{ animationDuration: '2s' }}></div>
                      {/* Inner targeting diamond */}
                      <div className="absolute w-6 h-6 -ml-3 -mt-3 border border-white/80 rotate-45"></div>
                      {/* Center dot */}
                      <div className="absolute w-1.5 h-1.5 -ml-[3px] -mt-[3px] bg-white"></div>
                      {/* Label */}
                      <div className="absolute top-4 left-4 whitespace-nowrap bg-black/90 border border-white/40 px-2 py-1">
                        <span className="text-[11px] font-bold tracking-[0.15em] uppercase text-white">
                          {neo.fullname}
                        </span>
                        <span className="text-[9px] text-white/40 tracking-wider block">
                          {neo.magnitude_v ? `V=${neo.magnitude_v}` : ''} {parseFloat(neo.dist) < 0.01 ? `${(parseFloat(neo.dist) * 389.17).toFixed(1)} LD` : `${parseFloat(neo.dist).toFixed(4)} AU`}
                        </span>
                      </div>
                    </div>
                  );
                })}

                {/* 2. Foreground: Astrometry.net Plate-Solved Plot (Clipped) */}
                <div
                  className="absolute inset-0 overflow-hidden bg-black"
                  style={{ clipPath: `inset(0 ${100 - sliderPosition}% 0 0)` }}
                >
                    <img
                        src={imgSrc}
                        className="absolute inset-0 w-full h-full object-cover select-none"
                        alt="Astrometry Plot"
                        referrerPolicy="no-referrer"
                    />
                </div>

                {/* 4. Slider Handle */}
                <div 
                  className="absolute top-0 bottom-0 w-px bg-white cursor-col-resize z-30 shadow-[0_0_8px_rgba(255,255,255,0.3)]"
                  style={{ left: `${sliderPosition}%` }}
                >
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-6 h-6 bg-black border border-white/50 flex items-center justify-center transition-transform hover:scale-110 active:scale-95 rotate-45">
                    <i className="fa-solid fa-arrows-left-right text-white text-[10px] -rotate-45"></i>
                  </div>
                </div>
             </div>
          ) : (
            <div className="w-full h-full flex items-center justify-center cursor-zoom-in" onClick={() => setLightboxImage({ src: image, alt: 'Original Observation' })}>
               <img src={image} alt="Scientific Observation" className="max-w-full max-h-full object-contain" />
            </div>
          )}
        </div>

        {/* 2b. Catalog Registry — second column */}
            <div className="h-full overflow-y-auto scroll-smooth bg-black hud-ticks-y">
              <div className="sticky top-0 z-10 hud-header-bar">
                <i className="fa-solid fa-list-check"></i>
                Catalog Registry
              </div>

              {filteredIdentifications.length === 0 ? (
                <div className="text-center py-20 bg-black border border-dashed border-white/5">
                   <p className="text-white/15 text-[11px] tracking-[0.2em] uppercase">No objects cataloged</p>
                </div>
              ) : filteredIdentifications.map((item, idx) => (
                <div
                  key={idx}
                  ref={(el) => { itemRefs.current[idx] = el; }}
                  onClick={() => setSelectedId(selectedId === idx ? null : idx)}
                  onMouseEnter={() => setHoveredId(idx)}
                  onMouseLeave={() => setHoveredId(null)}
                  className={`bg-black border-b border-white/5 p-4 cursor-pointer transition-all duration-300 group relative overflow-hidden
                    ${(selectedId === idx || hoveredId === idx)
                       ? 'border-white/20 hud-hatch-strong'
                       : 'hover:bg-white/[0.02]'}
                  `}
                >
                  <div className="flex justify-between items-start mb-2 relative z-10">
                    <div className="flex items-center gap-1.5">
                      <div className={`px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.2em] border ${getBadgeColor(item.object_type)}`}>
                        {item.object_type}
                      </div>
                      <div className={`px-1.5 py-0.5 text-[8px] font-bold tracking-[0.15em] border ${
                        (item.confidence ?? 1) >= 0.8 ? 'border-green-500/30 text-green-400/60' :
                        (item.confidence ?? 1) >= 0.5 ? 'border-yellow-500/30 text-yellow-400/60' :
                        'border-red-500/30 text-red-400/60'
                      }`}>
                        {((item.confidence ?? 1) * 100).toFixed(0)}%
                      </div>
                      {item.verification_status === 'wcs_confirmed' && (
                        <span className="text-[7px] text-white/20 tracking-[0.2em] uppercase">WCS</span>
                      )}
                    </div>
                    <button
                        onClick={(e) => { e.stopPropagation(); setSelectedId(idx); }}
                        className="text-white/15 hover:text-white/50 transition-colors"
                    >
                        <i className="fa-solid fa-crosshairs text-[12px]"></i>
                    </button>
                  </div>
                  <h4 className="text-xs font-bold tracking-[0.15em] uppercase mb-1">{item.primary_name}</h4>
                  <p className="text-[10px] text-white/20 tracking-[0.15em]">{item.ra} // {item.dec}</p>
                  {item.resolution_audit && (
                    <div className={`mt-1.5 px-1.5 py-0.5 text-[8px] tracking-[0.1em] uppercase border ${
                      item.resolution_audit.resolved
                        ? 'border-green-500/20 text-green-400/50'
                        : 'border-red-500/20 text-red-400/40'
                    }`}>
                      {item.resolution_audit.resolved
                        ? `Resolved from: ${item.resolution_audit.original_type}`
                        : `Unresolved — ${item.resolution_audit.databases_checked.length} databases checked`}
                    </div>
                  )}
                </div>
              ))}

              <div className="flex items-center justify-center py-6 border-t border-white/5">
                <WireframeGlobe size={60} />
              </div>
            </div>
          </div>

          {/* Analysis text — full width below plot+catalog grid */}
          <div className="bg-black border-t border-white/5 p-5">
            <div className="hud-header-bar mb-3">
              <i className="fa-solid fa-brain"></i>
              Gemini 3 Pro Analysis
            </div>
            <p className="opacity-50 leading-relaxed text-xs tracking-wider">{results.summary}</p>
            {results.sources && results.sources.length > 0 && (
              <div className="flex flex-wrap gap-3 mt-3 pt-3 border-t border-white/5">
                {results.sources.map((source, i) => (
                  <a key={i} href={source.uri} target="_blank" rel="noopener noreferrer"
                    className="text-[10px] text-white/25 hover:text-white/60 tracking-wider border border-white/5 hover:border-white/15 px-2 py-1 transition-all">
                    {source.title}
                  </a>
                ))}
              </div>
            )}
          </div>

       </div>

        {/* Historical Archive Search — APPLAUSE */}
        {!isFallback && (
          <div className="xl:col-span-12">
            <ArchivalPlates
              centerRa={results.plate_solve.center_ra}
              centerDec={results.plate_solve.center_dec}
              fieldOfView={results.plate_solve.field_of_view}
              userImage={image}
              results={results}
              onCrossAnalysis={handleCrossAnalysis}
            />
          </div>
        )}

        {/* Horizons / Comet Telemetry Card */}
        {(results.horizons || results.comet) && (
          <div className="xl:col-span-12 bg-black hud-frame hud-ticks-x relative overflow-hidden">
             <div className="hud-header-bar">
                <i className="fa-solid fa-meteor"></i>
                Precision Target Telemetry
                {results.horizons && (
                    <span className="ml-auto text-[10px] text-white/40 tracking-[0.2em]">[HORIZONS LOCKED]</span>
                )}
             </div>
             <div className="p-6">

             <div className="grid grid-cols-1 md:grid-cols-2 gap-6 relative z-10">
                <div>
                   <h4 className="text-2xl font-bold text-white mb-1 tracking-tight">
                        {results.horizons?.id || results.comet?.object.fullname}
                   </h4>
                   <p className="text-xs text-white/30 font-mono mb-4">
                        {results.horizons ? 'Ephemeris Tracking Active' : `${results.comet?.object.type} Type Comet`}
                   </p>
                   
                   <div className="flex gap-4">
                     <div className="bg-white/5 border border-white/10 p-3  flex-1">
                        <span className="text-[11px] text-white/30 uppercase font-bold block mb-1">Magnitude</span>
                        <span className="text-xl text-white/50 font-mono font-bold">
                            {results.horizons?.magnitude || results.comet?.recent_observations?.[0]?.magnitude || 'N/A'}
                        </span>
                     </div>
                     <div className="bg-white/5 border border-white/10 p-3  flex-1">
                        <span className="text-[11px] text-white/30 uppercase font-bold block mb-1">
                            {results.horizons ? 'Distance (Earth)' : 'Perihelion (q)'}
                        </span>
                        <span className="text-xl text-white font-mono font-bold">
                            {results.horizons?.distance_au || results.comet?.orbit.q} AU
                        </span>
                     </div>
                   </div>
                </div>

                <div className="space-y-2 text-[12px] font-mono text-white/30 bg-white/5 p-4  border border-white/10">
                    {results.horizons ? (
                        <>
                            <div className="flex justify-between border-b border-white/10 pb-2 mb-2">
                                <span>Predicted RA (ICRF)</span>
                                <span className="text-white">{results.horizons.ra}</span>
                            </div>
                            <div className="flex justify-between border-b border-white/10 pb-2 mb-2">
                                <span>Predicted Dec (ICRF)</span>
                                <span className="text-white">{results.horizons.dec}</span>
                            </div>
                            <div className="flex justify-between border-b border-white/10 pb-2 mb-2">
                                <span>Velocity (Relative)</span>
                                <span className="text-white">{results.horizons.velocity_kms} km/s</span>
                            </div>
                            <div className="flex justify-between">
                                <span>Timestamp (UT)</span>
                                <span className="text-white/50">{results.horizons.timestamp}</span>
                            </div>
                        </>
                    ) : (
                        // Fallback to COBS orbit data
                        <>
                            <div className="flex justify-between border-b border-white/10 pb-2 mb-2">
                                <span>Inclination (i)</span>
                                <span className="text-white">{results.comet?.orbit.i}°</span>
                            </div>
                            <div className="flex justify-between border-b border-white/10 pb-2 mb-2">
                                <span>Period (per)</span>
                                <span className="text-white">{results.comet?.orbit.per} Years</span>
                            </div>
                            <div className="flex justify-between border-b border-white/10 pb-2 mb-2">
                                <span>Eccentricity (e)</span>
                                <span className="text-white">{results.comet?.orbit.e}</span>
                            </div>
                            <div className="flex justify-between">
                                <span>Perihelion Date</span>
                                <span className="text-white/50">{results.comet?.orbit.tp_cd.split(' ')[0]}</span>
                            </div>
                        </>
                    )}
                </div>
             </div>
             </div>
          </div>
        )}

        {/* Satellite Identification — SGP4/TLE Catalog Matches */}
        {results.satellites && results.satellites.length > 0 && (() => {
          const matched = results.satellites.filter(s => (s.streakMatchScore || 0) > 0.3);
          const others = results.satellites.filter(s => (s.streakMatchScore || 0) <= 0.3);
          return (
          <div className="xl:col-span-12 bg-black hud-frame relative overflow-hidden">
            <div className="hud-header-bar">
              <i className="fa-solid fa-satellite"></i>
              Satellite Identification // SGP4 + CelesTrak TLE
              <span className="ml-auto flex items-center gap-3">
                {matched.length > 0 && (
                  <span className="text-[10px] tracking-[0.2em] border border-white/50 px-2 py-0.5 bg-white/10">
                    {matched.length} STREAK MATCH{matched.length !== 1 ? 'ES' : ''}
                  </span>
                )}
                <span className="text-[11px] tracking-[0.2em] border border-white/30 px-2 py-0.5">
                  {results.satellites.length} IN FIELD
                </span>
              </span>
            </div>
            <div className="p-5">
              {/* Streak-matched satellites — prominent */}
              {matched.length > 0 && (
                <div className="mb-6">
                  <p className="text-white/50 text-xs mb-3 tracking-[0.15em] uppercase">
                    Streak-Matched — transit path aligned with detected streak
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {matched.map((sat, idx) => (
                      <div key={`match-${idx}`} className="bg-black border border-white/40 p-4 relative">
                        <div className="absolute top-0 right-0 bg-white text-black text-[9px] font-bold tracking-[0.15em] uppercase px-2 py-0.5">
                          {((sat.streakMatchScore || 0) * 100).toFixed(0)}% MATCH
                        </div>
                        <div className="flex justify-between items-start mb-2 pr-16">
                          <span className="text-sm font-bold tracking-[0.1em] uppercase">{sat.name}</span>
                        </div>
                        <div className="text-[11px] text-white/40 font-mono mb-3">NORAD #{sat.noradId}</div>
                        <div className="grid grid-cols-4 gap-2 text-[11px] font-mono text-white/40">
                          <div>
                            <span className="block text-white/25 uppercase text-[10px]">Altitude</span>
                            <span className="text-white/70">{sat.altitude.toFixed(0)} km</span>
                          </div>
                          <div>
                            <span className="block text-white/25 uppercase text-[10px]">Mag</span>
                            <span className="text-white/70">~{sat.estMagnitude?.toFixed(1) ?? '?'}</span>
                          </div>
                          <div>
                            <span className="block text-white/25 uppercase text-[10px]">Angle</span>
                            <span className="text-white/70">{sat.transitAngleDeg?.toFixed(1) ?? '?'}°</span>
                          </div>
                          <div>
                            <span className="block text-white/25 uppercase text-[10px]">Velocity</span>
                            <span className="text-white/70">{sat.velocity.toFixed(1)} km/s</span>
                          </div>
                        </div>
                        <div className="mt-2 text-[10px] text-white/20 tracking-wider">
                          RA {sat.ra.toFixed(4)}° // Dec {sat.dec.toFixed(4)}°
                          {(sat as any).satCheckerVerified && (
                            <span className="ml-2 text-green-400/60 border border-green-500/20 px-1.5 py-0.5 text-[8px] uppercase tracking-[0.15em]">IAU SatChecker Verified</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Other satellites in field — de-emphasized */}
              {others.length > 0 && (
                <div>
                  <p className="text-white/20 text-xs mb-3 tracking-[0.15em] uppercase">
                    {matched.length > 0 ? 'Other illuminated' : 'Illuminated'} satellites in field — no streak correlation
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-white/5">
                    {others.slice(0, 9).map((sat, idx) => (
                      <div key={`other-${idx}`} className="bg-black p-3">
                        <div className="flex justify-between items-start mb-1">
                          <span className="text-[11px] text-white/30 font-mono truncate max-w-[70%]">{sat.name}</span>
                          <span className="text-[10px] text-white/15 font-mono">#{sat.noradId}</span>
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-[10px] font-mono text-white/15">
                          <div>{sat.altitude.toFixed(0)} km</div>
                          <div>mag ~{sat.estMagnitude?.toFixed(1)}</div>
                          <div>{sat.velocity.toFixed(1)} km/s</div>
                        </div>
                      </div>
                    ))}
                  </div>
                  {others.length > 9 && (
                    <p className="text-[10px] text-white/10 mt-2 tracking-wider">
                      + {others.length - 9} more satellites in field
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
          );
        })()}

        {/* Solar System Radar (NASA JPL Data) — Ephemeris-Resolved */}
        <div className="xl:col-span-12 bg-black hud-frame relative overflow-hidden">
          <div className="hud-header-bar">
            <i className="fa-solid fa-satellite"></i>
            Solar System Radar
            <span className="ml-auto flex items-center gap-3">
              {results.neos && results.neos.some(n => n.in_field) && (
                <span className="text-[10px] tracking-[0.2em] border border-white/40 px-2 py-0.5 animate-pulse">
                  {results.neos.filter(n => n.in_field).length} IN FIELD
                </span>
              )}
              <span className="text-[10px] text-white/25 tracking-[0.2em]">NASA NeoWs + JPL Horizons</span>
            </span>
          </div>
          <div className="p-5">

          {(() => {
            const inField = results.neos?.filter(n => n.in_field) || [];
            const outField = results.neos?.filter(n => !n.in_field) || [];

            if (!results.neos || results.neos.length === 0) {
              return (
                <div className="text-center py-6 bg-white/5 border border-white/10 border-dashed">
                  <p className="text-white/30 text-xs uppercase tracking-widest">Sector Clear — No Close Approaches</p>
                </div>
              );
            }

            return (
              <>
                {/* IN-FIELD NEOs — prominent alert cards */}
                {inField.length > 0 && (
                  <div className="mb-6">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="w-2 h-2 bg-white animate-pulse"></div>
                      <span className="text-xs font-bold tracking-[0.2em] uppercase">
                        {inField.length} Near-Earth Object{inField.length !== 1 ? 's' : ''} Detected In Your Image
                      </span>
                    </div>
                    <p className="text-white/30 text-[12px] mb-4 tracking-wider leading-relaxed max-w-2xl">
                      These asteroids have been confirmed via JPL Horizons ephemeris to be within your plate-solved field of view at the time of observation. Their positions are marked on the image above.
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {inField.map((neo, idx) => (
                        <div key={`in-${idx}`} className="bg-black border border-white/30 p-4 hud-hatch-strong relative overflow-hidden">
                          <div className="flex justify-between items-start mb-3">
                            <div>
                              <span className="text-sm font-bold tracking-[0.1em] uppercase block">{neo.fullname}</span>
                              <span className="text-[11px] text-white/30 tracking-wider">
                                RA {neo.ra}° // Dec {neo.dec}°
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] tracking-[0.2em] border border-white/50 px-2 py-0.5 font-bold">IN FIELD</span>
                            </div>
                          </div>
                          <div className="grid grid-cols-4 gap-3 text-[11px] font-mono">
                            <div>
                              <span className="block text-white/25 uppercase text-[10px] mb-0.5">Distance</span>
                              <span className="text-white font-bold">{(parseFloat(neo.dist) * 389.17).toFixed(1)} LD</span>
                            </div>
                            <div>
                              <span className="block text-white/25 uppercase text-[10px] mb-0.5">Velocity</span>
                              <span className="text-white font-bold">{parseFloat(neo.v_rel).toFixed(1)} km/s</span>
                            </div>
                            <div>
                              <span className="block text-white/25 uppercase text-[10px] mb-0.5">V Mag</span>
                              <span className="text-white font-bold">{neo.magnitude_v || neo.h}</span>
                            </div>
                            <div>
                              <span className="block text-white/25 uppercase text-[10px] mb-0.5">H Mag</span>
                              <span className="text-white/50">{neo.h}</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* OUT-OF-FIELD NEOs — compact, de-emphasized */}
                {outField.length > 0 && (
                  <div>
                    <p className="text-[11px] text-white/15 tracking-[0.2em] uppercase mb-2">
                      {inField.length > 0 ? 'Other' : ''} Near-Earth Objects within 0.1 AU — outside field of view
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-white/5">
                      {outField.map((neo, idx) => (
                        <div key={`out-${idx}`} className="bg-black p-3">
                          <div className="flex justify-between items-start mb-1.5">
                            <span className="text-[11px] text-white/25 font-mono truncate max-w-[70%]">{neo.fullname}</span>
                            <span className="text-[10px] text-white/15 px-1">{neo.h} H</span>
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-[10px] text-white/15 font-mono">
                            <div>
                              <span className="block uppercase text-[9px]">Distance</span>
                              <span className="text-white/30">{(parseFloat(neo.dist) * 389.17).toFixed(1)} LD</span>
                            </div>
                            <div>
                              <span className="block uppercase text-[9px]">Velocity</span>
                              <span className="text-white/30">{parseFloat(neo.v_rel).toFixed(1)} km/s</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            );
          })()}
          </div>
        </div>

        {/* ASK THE ASTRONOMER — full width, redesigned */}
        <div className="xl:col-span-12">
        <div className="bg-black overflow-hidden flex flex-col hud-frame">
            <div className="hud-header-bar">
                <i className="fa-solid fa-comments"></i>
                Ask the Astronomer
                <span className="ml-auto flex items-center gap-4">
                  <span className="text-[9px] text-white/15 tracking-[0.2em]">GEMINI_3_PRO</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowInstagram(true); }}
                    className="hud-btn py-1 px-4 text-[11px] gap-2"
                  >
                    <i className="fa-brands fa-instagram"></i>
                    Share to Instagram
                  </button>
                </span>
            </div>

            <div className="p-6 min-h-[400px] max-h-[700px] overflow-y-auto space-y-6 bg-black/30">
                {chatHistory.length === 0 && (
                    <div className="text-center py-16">
                         <div className="w-12 h-12 border border-white/10 flex items-center justify-center mx-auto mb-5">
                           <i className="fa-solid fa-satellite-dish text-lg text-white/10"></i>
                         </div>
                         <p className="text-white/25 text-sm tracking-widest uppercase mb-2">Ask the Astronomer</p>
                         <p className="text-white/10 text-xs tracking-wider max-w-md mx-auto leading-relaxed">
                           Ask about any object in the field — distance, composition, history, or observing tips.
                           {!isFallback && ' Archival cross-analysis results will appear here automatically.'}
                         </p>
                    </div>
                )}

                {chatHistory.map((msg, idx) => (
                  <div key={idx} className="animate-in fade-in duration-500">
                    {/* SYSTEM messages — archival analysis with inline images */}
                    {msg.role === 'system' && (
                      <div className="border border-white/10 bg-black">
                        <div className="flex items-center gap-2 px-4 py-2 border-b border-white/5 bg-white/[0.02]">
                          <i className="fa-solid fa-clock-rotate-left text-[11px] text-white/30"></i>
                          <span className="text-[11px] text-white/30 tracking-[0.2em] uppercase font-bold">Archival Cross-Analysis</span>
                          {msg.anomalies && msg.anomalies.length > 0 && (
                            <span className="text-[10px] tracking-[0.2em] border border-white/20 px-2 py-0.5 ml-auto">
                              {msg.anomalies.length} DETECTION{msg.anomalies.length !== 1 ? 'S' : ''}
                            </span>
                          )}
                        </div>

                        {/* Inline plate images */}
                        {msg.images && msg.images.length > 0 && (
                          <div className="px-4 pt-4 flex gap-3 flex-wrap">
                            {msg.images.map((img, iIdx) => (
                              <button
                                key={iIdx}
                                onClick={() => setLightboxImage({ src: img.url, alt: img.label, invert: true })}
                                className="relative border border-white/10 bg-black overflow-hidden group cursor-zoom-in hover:border-white/25 transition-colors"
                                style={{ width: '220px' }}
                              >
                                <img
                                  src={img.url}
                                  alt={img.label}
                                  className="w-full h-auto object-contain group-hover:opacity-80 transition-opacity"
                                  style={{ filter: 'invert(1)', maxHeight: '180px' }}
                                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                                />
                                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                  <i className="fa-solid fa-expand text-white/50 text-lg"></i>
                                </div>
                                <div className="px-2 py-1.5 border-t border-white/5">
                                  <span className="text-[10px] text-white/25 tracking-wider">{img.label}</span>
                                </div>
                              </button>
                            ))}
                          </div>
                        )}

                        <div className="p-4 text-sm text-white/45 leading-relaxed tracking-wide">
                          <FormattedText text={msg.text} />
                        </div>
                      </div>
                    )}

                    {/* USER messages */}
                    {msg.role === 'user' && (
                      <div className="flex justify-end">
                        <div className="max-w-[75%] bg-white/5 border border-white/15 px-5 py-4">
                          <p className="text-sm text-white/70 leading-relaxed tracking-wide">{msg.text}</p>
                        </div>
                      </div>
                    )}

                    {/* MODEL (astronomer) messages */}
                    {msg.role === 'model' && (
                      <div className="flex justify-start">
                        <div className="max-w-[85%] border border-white/10 bg-black">
                          <div className="flex items-center gap-2 px-4 py-2 border-b border-white/5">
                            <i className="fa-solid fa-user-astronaut text-[11px] text-white/25"></i>
                            <span className="text-[10px] text-white/20 tracking-[0.2em] uppercase">Astronomer</span>
                          </div>
                          <div className="p-5 text-sm text-white/50 leading-relaxed tracking-wide">
                            <FormattedText text={msg.text} />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                {isChatting && (
                     <div className="flex justify-start w-full">
                        <div className="border border-white/10 bg-black w-full max-w-[85%] overflow-hidden">
                          <div className="flex items-center gap-2 px-4 py-2 border-b border-white/5">
                            <div className="w-1.5 h-1.5 bg-white/30 animate-pulse"></div>
                            <span className="text-[11px] text-white/25 tracking-[0.2em] uppercase">Neural Processing</span>
                          </div>
                          <div className="h-20 relative">
                            <AiThinkingAnimation />
                          </div>
                          <div className="px-4 py-2 border-t border-white/5 flex items-center gap-3">
                            <div className="flex gap-1">
                              <div className="w-1 h-3 bg-white/10 animate-pulse"></div>
                              <div className="w-1 h-4 bg-white/15 animate-pulse" style={{ animationDelay: '100ms' }}></div>
                              <div className="w-1 h-2 bg-white/10 animate-pulse" style={{ animationDelay: '200ms' }}></div>
                              <div className="w-1 h-5 bg-white/20 animate-pulse" style={{ animationDelay: '300ms' }}></div>
                              <div className="w-1 h-3 bg-white/10 animate-pulse" style={{ animationDelay: '400ms' }}></div>
                            </div>
                            <span className="text-[10px] text-white/15 tracking-[0.2em] uppercase">Synthesizing response from multi-agency data...</span>
                          </div>
                        </div>
                     </div>
                )}
                <div ref={chatEndRef} />
            </div>

            <form onSubmit={handleChatSubmit} className="p-4 border-t border-white/10 flex gap-3">
                <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Ask about any object, anomaly, or observation..."
                    className="flex-grow bg-black border border-white/15 px-5 py-3.5 text-white text-sm tracking-wider placeholder-white/15 focus:outline-none focus:border-white/40 transition-colors"
                />
                <button
                    type="submit"
                    disabled={!chatInput.trim() || isChatting}
                    className="hud-btn px-6 py-3.5 disabled:opacity-30"
                >
                    <i className="fa-solid fa-paper-plane text-xs"></i>
                </button>
            </form>
        </div>
      </div>

        {/* Lightbox Modal */}
        {lightboxOpen && (
          <div className="fixed inset-0 z-[100] bg-black/95 flex items-center justify-center p-4 animate-in fade-in duration-300 ">
            <button 
              onClick={() => setLightboxOpen(false)}
              className="absolute top-6 right-6 text-white/50 hover:text-white text-4xl transition-colors z-[110]"
            >
              <i className="fa-solid fa-xmark"></i>
            </button>
            <div className="w-full h-full max-w-7xl max-h-[90vh] flex flex-col items-center justify-center relative bg-white/5  overflow-hidden">
              
              {/* Zoom Controls Overlay */}
              <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-white/5  px-2 py-1.5 border border-white/10 z-[110] flex gap-2  ">
                 <button 
                   onClick={() => setViewMode('fit')}
                   className={`px-4 py-2  text-xs font-bold transition-all ${viewMode === 'fit' ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white'}`}
                 >
                   <i className="fa-solid fa-compress mr-2"></i>Fit to Screen
                 </button>
                 <button 
                   onClick={() => setViewMode('original')}
                   className={`px-4 py-2  text-xs font-bold transition-all ${viewMode === 'original' ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white'}`}
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
                        transition-all duration-300
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
                  className="absolute top-6 left-6 bg-white/5 hover:bg-black text-white px-4 py-2  text-xs font-bold transition-all flex items-center gap-2 border border-white/10 z-[110]"
                >
                  <i className="fa-solid fa-external-link-alt"></i>
                  Open Original Source
              </a>
            </div>
          </div>
        )}

      {/* Instagram Publisher Modal */}
      {showInstagram && (
        <InstagramPublisher
          results={results}
          image={image}
          vectorMap={results.generated_annotation_image}
          archivalReports={archivalReports}
          onClose={() => setShowInstagram(false)}
        />
      )}

      {/* Universal Image Lightbox */}
      {lightboxImage && (
        <ImageLightbox
          src={lightboxImage.src}
          alt={lightboxImage.alt}
          invert={lightboxImage.invert}
          onClose={() => setLightboxImage(null)}
        />
      )}
    </div>
  );
};
