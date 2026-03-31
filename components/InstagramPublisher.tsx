
import React, { useState, useEffect, useRef } from 'react';
import { IdentificationResult } from '../types';
import { generateInstagramCaption } from '../services/gemini';
import { CrossAnalysisReport } from './ArchivalPlates';

interface InstagramPublisherProps {
  results: IdentificationResult;
  image: string;
  vectorMap?: string;
  archivalReports?: CrossAnalysisReport[];
  chatHistory?: { role: string; text: string }[];
  onClose: () => void;
}

type PublishState = 'idle' | 'publishing' | 'success' | 'error';

const compositeLabelsOntoVectorMap = (
  vectorMapSrc: string,
  annotations: any[],
  imgW: number,
  imgH: number
): Promise<string> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      ctx.globalCompositeOperation = 'difference';
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'source-over';
      const scaleX = canvas.width / (imgW || canvas.width);
      const scaleY = canvas.height / (imgH || canvas.height);
      const fontSize = Math.max(12, Math.round(canvas.width / 80));
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      for (const anno of annotations) {
        if (!anno.names || anno.names.length === 0) continue;
        const x = anno.pixelx * scaleX;
        const y = anno.pixely * scaleY;
        if (x < 0 || x > canvas.width || y < 0 || y > canvas.height) continue;
        const label = anno.names[0];
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.font = `bold ${fontSize}px "Inter", "Helvetica Neue", sans-serif`;
        const textMetrics = ctx.measureText(label);
        const textW = textMetrics.width + 12;
        const textH = fontSize + 8;
        const labelX = x - textW / 2;
        const labelY = y - 10 - textH;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.beginPath();
        ctx.roundRect(labelX, labelY, textW, textH, 4);
        ctx.fill();
        ctx.fillStyle = '#000000';
        ctx.fillText(label, x, y - 12);
      }
      resolve(canvas.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = () => resolve(vectorMapSrc);
    img.src = vectorMapSrc;
  });
};

export const InstagramPublisher: React.FC<InstagramPublisherProps> = ({
  results,
  image,
  vectorMap,
  archivalReports,
  chatHistory,
  onClose,
}) => {
  const [caption, setCaption] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [labeledVectorMap, setLabeledVectorMap] = useState<string | null>(null);
  const [selectedImageIdx, setSelectedImageIdx] = useState(0);
  const [publishState, setPublishState] = useState<PublishState>('idle');
  const [publishError, setPublishError] = useState('');
  const [igEmail, setIgEmail] = useState(() => localStorage.getItem('ig_email') || '');
  const [igPassword, setIgPassword] = useState(() => localStorage.getItem('ig_password') || '');
  const [showCredentials, setShowCredentials] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showSummary, setShowSummary] = useState(true);
  const captionRef = useRef<HTMLTextAreaElement>(null);

  // Build labeled vector map on mount
  useEffect(() => {
    if (vectorMap && results.plate_solve.annotations?.length) {
      compositeLabelsOntoVectorMap(
        vectorMap,
        results.plate_solve.annotations,
        results.plate_solve.image_width || 0,
        results.plate_solve.image_height || 0
      ).then(setLabeledVectorMap);
    }
  }, [vectorMap, results]);

  // Build complete image list including archival plates
  const availableImages: { label: string; src: string; type: 'photo' | 'vector' | 'plot' | 'archival' }[] = [
    { label: 'Original Photo', src: image, type: 'photo' },
    ...((labeledVectorMap || vectorMap) ? [{ label: 'Vector Map', src: labeledVectorMap || vectorMap!, type: 'vector' as const }] : []),
    ...(results.plate_solve.annotated_image_url ? [{ label: 'Astrometry Plot', src: results.plate_solve.annotated_image_url, type: 'plot' as const }] : []),
    ...(archivalReports || []).map(r => ({
      label: `Archival ${r.plate.plate_num || r.plate.plate_id} (${r.plate.date_orig?.substring(0, 4) || '?'})`,
      src: r.platePreviewUrl,
      type: 'archival' as const,
    })),
  ];

  // Build smart observation summary
  const buildSummary = () => {
    const lines: string[] = [];
    const ps = results.plate_solve;
    const ids = results.identifications || [];
    const isFallback = ps.wcs_quality === 0;

    // Header
    lines.push('=== CELESTIAL VISION AI — OBSERVATION SUMMARY ===');
    lines.push('');

    // Plate solve
    if (!isFallback) {
      lines.push(`FIELD: ${ps.constellation || 'Deep Sky'}`);
      lines.push(`CENTER: RA ${ps.center_ra} / Dec ${ps.center_dec}`);
      lines.push(`FOV: ${ps.field_of_view} // Scale: ${ps.plate_scale}`);
      lines.push(`WCS Quality: ${ps.wcs_quality.toFixed(1)}%`);
    } else {
      lines.push('MODE: Visual Analysis Only (plate solve failed)');
    }
    lines.push('');

    // Identified objects
    if (ids.length > 0) {
      lines.push(`OBJECTS IDENTIFIED (${ids.length}):`);
      ids.forEach(id => {
        const streak = id.streak_info ? ` [${id.streak_info.orbit_regime || 'streak'}]` : '';
        lines.push(`  • ${id.primary_name} (${id.object_type})${streak}`);
      });
      lines.push('');
    }

    // NEOs in field
    const inFieldNeos = (results.neos || []).filter(n => n.in_field);
    if (inFieldNeos.length > 0) {
      lines.push(`NEOs IN FIELD (${inFieldNeos.length}):`);
      inFieldNeos.forEach(n => {
        lines.push(`  • ${n.fullname}: ${(parseFloat(n.dist) * 389.17).toFixed(1)} LD, V=${n.magnitude_v || '?'}`);
      });
      lines.push('');
    }

    // Archival cross-analysis
    if (archivalReports && archivalReports.length > 0) {
      const totalAnomalies = archivalReports.reduce((s, r) => s + (r.analysis.anomalies?.length || 0), 0);
      lines.push(`ARCHIVAL CROSS-ANALYSIS (${archivalReports.length} plates, ${totalAnomalies} anomalies):`);
      archivalReports.forEach(r => {
        const year = r.plate.date_orig?.substring(0, 4) || '?';
        const count = r.analysis.anomalies?.length || 0;
        lines.push(`  • Plate ${r.plate.plate_num || r.plate.plate_id} (${year}): ${count > 0 ? `${count} detection(s)` : 'Clear'}`);
        r.analysis.anomalies?.forEach(a => {
          lines.push(`    — [${a.significance.toUpperCase()}] ${a.type.replace(/_/g, ' ')}: ${a.description.substring(0, 80)}`);
        });
      });
      lines.push('');
    }

    // Gemini summary
    if (results.summary) {
      lines.push('AI ANALYSIS:');
      lines.push(results.summary);
    }

    return lines.join('\n');
  };

  useEffect(() => { handleGenerateCaption(); }, []);

  const handleGenerateCaption = async () => {
    setIsGenerating(true);
    try {
      const generated = await generateInstagramCaption(image, results, archivalReports);
      setCaption(generated);
    } catch {
      setCaption('Failed to generate caption. You can write your own below.');
    } finally {
      setIsGenerating(false);
    }
  };

  const handlePublish = async () => {
    if (!igEmail || !igPassword) { setShowCredentials(true); return; }
    localStorage.setItem('ig_email', igEmail);
    localStorage.setItem('ig_password', igPassword);
    setPublishState('publishing');
    setPublishError('');
    try {
      const allImages = availableImages.filter(i => i.type !== 'archival').map(i => i.src);
      const res = await fetch('/api/instagram/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: igEmail, password: igPassword, caption, images: allImages }),
      });
      const data = await res.json();
      if (data.succeeded) setPublishState('success');
      else { setPublishState('error'); setPublishError(data.message || data.error || 'Unknown error'); }
    } catch (err: any) {
      setPublishState('error');
      setPublishError(err.message || 'Network error');
    }
  };

  const handleCopyCaption = async () => {
    try { await navigator.clipboard.writeText(caption); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = caption;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopySummary = async () => {
    try { await navigator.clipboard.writeText(buildSummary()); } catch {}
  };

  const handleDownloadAll = () => {
    // Download all images
    availableImages.forEach((img, idx) => {
      // For proxy URLs (archival plates), fetch and convert to data URL
      if (img.src.startsWith('/api/')) {
        fetch(img.src)
          .then(r => r.blob())
          .then(blob => {
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `celestialvision_${img.label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.png`;
            link.click();
            URL.revokeObjectURL(url);
          })
          .catch(() => {}); // Skip failed downloads
      } else {
        const link = document.createElement('a');
        link.href = img.src;
        link.download = `celestialvision_${img.label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.jpg`;
        link.click();
      }
    });

    // Also download the summary as text
    const summary = buildSummary();
    const blob = new Blob([summary], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'celestialvision_observation_summary.txt';
    link.click();
    URL.revokeObjectURL(url);
  };

  const charCount = caption.length;
  const isOverLimit = charCount > 2200;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/90 backdrop-blur-sm p-4">
      <div className="bg-black border border-white/15 w-full max-w-6xl max-h-[92vh] overflow-hidden flex flex-col">

        {/* Header */}
        <div className="px-6 py-3 border-b border-white/10 flex items-center justify-between shrink-0">
          <h2 className="text-[12px] font-bold tracking-[0.2em] uppercase flex items-center gap-3">
            <i className="fa-brands fa-instagram text-white/40"></i>
            Instagram Publisher
            <span className="text-white/15">// {availableImages.length} images</span>
          </h2>
          <button onClick={onClose} className="text-white/30 hover:text-white transition-colors w-8 h-8 flex items-center justify-center">
            <i className="fa-solid fa-xmark text-xs"></i>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-6">

            {/* Left: Preview + Image carousel */}
            <div className="space-y-4">
              {/* Instagram preview */}
              <div className="bg-black border border-white/10 overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3 border-b border-white/5">
                  <div className="w-7 h-7 border border-white/20 flex items-center justify-center">
                    <i className="fa-solid fa-crosshairs text-white/40 text-[11px]"></i>
                  </div>
                  <div>
                    <div className="text-white text-[12px] font-bold tracking-widest uppercase">celestialvision.ai</div>
                    <div className="text-white/20 text-[10px] tracking-widest">Celestial Vision AI</div>
                  </div>
                </div>

                <div className="relative aspect-square bg-black">
                  {availableImages.length > 1 && (
                    <div className="absolute top-3 right-3 bg-black/60 text-white text-[12px] font-bold px-2.5 py-1 z-10">
                      {selectedImageIdx + 1}/{availableImages.length}
                    </div>
                  )}
                  <img
                    src={availableImages[selectedImageIdx]?.src}
                    alt="Post preview"
                    className="w-full h-full object-cover"
                    style={availableImages[selectedImageIdx]?.type === 'archival' ? { filter: 'invert(1)' } : undefined}
                    onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.3'; }}
                  />
                  {availableImages.length > 1 && (
                    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1.5">
                      {availableImages.map((_, idx) => (
                        <button key={idx} onClick={() => setSelectedImageIdx(idx)}
                          className={`w-1.5 h-1.5 transition-all ${idx === selectedImageIdx ? 'bg-white w-3' : 'bg-white/40 hover:bg-white/70'}`}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {/* Caption preview */}
                <div className="px-4 py-3">
                  <div className="text-xs text-white/30 leading-relaxed max-h-24 overflow-y-auto">
                    <span className="font-bold text-white mr-1">celestialvision.ai</span>
                    {caption ? caption.split('\n').slice(0, 3).join(' ') + '...' : <span className="text-white/15 italic">Generating...</span>}
                  </div>
                </div>
              </div>

              {/* Image selector — scrollable thumbnails */}
              <div className="flex gap-2 overflow-x-auto pb-1">
                {availableImages.map((img, idx) => (
                  <button key={idx} onClick={() => setSelectedImageIdx(idx)}
                    className={`shrink-0 w-16 h-16 border overflow-hidden transition-all ${
                      idx === selectedImageIdx ? 'border-white/40' : 'border-white/10 opacity-50 hover:opacity-80'
                    }`}
                  >
                    <img src={img.src} alt={img.label} className="w-full h-full object-cover"
                      style={img.type === 'archival' ? { filter: 'invert(1)' } : undefined}
                      onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.3'; }}
                    />
                  </button>
                ))}
              </div>

              {/* Observation summary — collapsible */}
              <div className="border border-white/10 bg-black">
                <button onClick={() => setShowSummary(!showSummary)}
                  className="w-full px-4 py-3 flex items-center justify-between text-[11px] text-white/30 hover:text-white/50 transition-colors"
                >
                  <span className="flex items-center gap-2 font-bold uppercase tracking-[0.2em]">
                    <i className="fa-solid fa-clipboard-list"></i>
                    Observation Summary
                  </span>
                  <i className={`fa-solid fa-chevron-${showSummary ? 'up' : 'down'} text-[10px]`}></i>
                </button>
                {showSummary && (
                  <div className="px-4 pb-4 border-t border-white/5">
                    <pre className="text-[11px] text-white/30 font-mono leading-relaxed whitespace-pre-wrap mt-3 max-h-[250px] overflow-y-auto">
                      {buildSummary()}
                    </pre>
                    <button onClick={handleCopySummary}
                      className="mt-2 text-[10px] text-white/20 hover:text-white/50 transition-colors flex items-center gap-1.5"
                    >
                      <i className="fa-solid fa-copy"></i> Copy Summary
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Right: Caption + Controls */}
            <div className="space-y-4 flex flex-col">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold tracking-[0.2em] uppercase text-white/30">Caption</span>
                <button onClick={handleGenerateCaption} disabled={isGenerating}
                  className="text-[11px] text-white/40 hover:text-white disabled:text-white/15 font-bold uppercase tracking-[0.15em] flex items-center gap-1.5 transition-colors"
                >
                  <i className={`fa-solid ${isGenerating ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles'} text-[10px]`}></i>
                  {isGenerating ? 'Generating...' : 'Regenerate'}
                </button>
              </div>

              <div className="relative flex-1 min-h-0">
                <textarea ref={captionRef} value={caption} onChange={(e) => setCaption(e.target.value)}
                  disabled={isGenerating} placeholder="Your Instagram caption will appear here..."
                  className="w-full h-full min-h-[250px] bg-black border border-white/10 p-4 text-xs text-white/60 placeholder-white/15 resize-none focus:outline-none focus:border-white/30 transition-colors leading-relaxed disabled:opacity-50 tracking-wider"
                />
                <div className={`absolute bottom-3 right-3 text-[11px] ${isOverLimit ? 'text-white' : 'text-white/15'} tracking-widest`}>
                  {charCount}/2200
                </div>
              </div>

              {/* Credentials */}
              <div className="bg-black border border-white/10 overflow-hidden">
                <button onClick={() => setShowCredentials(!showCredentials)}
                  className="w-full px-4 py-3 flex items-center justify-between text-[12px] text-white/30 hover:text-white transition-colors"
                >
                  <span className="flex items-center gap-2 font-bold uppercase tracking-wider">
                    <i className="fa-solid fa-lock text-white/30"></i>
                    Instagram Account
                    {igEmail && <span className="text-white/50 normal-case tracking-normal font-normal">({igEmail})</span>}
                  </span>
                  <i className={`fa-solid fa-chevron-${showCredentials ? 'up' : 'down'} text-[12px]`}></i>
                </button>
                {showCredentials && (
                  <div className="px-4 pb-4 space-y-3 border-t border-white/5">
                    <div className="pt-3">
                      <label className="block text-[12px] text-white/30 uppercase tracking-wider mb-1">Email</label>
                      <input type="email" value={igEmail} onChange={(e) => setIgEmail(e.target.value)}
                        placeholder="your@email.com"
                        className="w-full bg-black border border-white/10 px-3 py-2 text-sm text-white placeholder-white/15 focus:outline-none focus:border-white/30"
                      />
                    </div>
                    <div>
                      <label className="block text-[12px] text-white/30 uppercase tracking-wider mb-1">Password</label>
                      <input type="password" value={igPassword} onChange={(e) => setIgPassword(e.target.value)}
                        placeholder="Instagram password"
                        className="w-full bg-black border border-white/10 px-3 py-2 text-sm text-white placeholder-white/15 focus:outline-none focus:border-white/30"
                      />
                    </div>
                    <p className="text-[11px] text-white/20 leading-relaxed">
                      <i className="fa-solid fa-shield-halved mr-1"></i>
                      Stored in your browser only. Never sent to any third-party server.
                    </p>
                  </div>
                )}
              </div>

              {/* Action buttons */}
              <div className="grid grid-cols-3 gap-2">
                <button onClick={handleCopyCaption} disabled={!caption || isGenerating}
                  className="bg-black border border-white/10 hover:border-white/25 disabled:opacity-40 text-white py-2.5 text-[11px] font-bold transition-all flex items-center justify-center gap-1.5 uppercase tracking-wider"
                >
                  <i className={`fa-solid ${copied ? 'fa-check' : 'fa-copy'} text-[10px]`}></i>
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button onClick={handleDownloadAll}
                  className="bg-black border border-white/10 hover:border-white/25 text-white py-2.5 text-[11px] font-bold transition-all flex items-center justify-center gap-1.5 uppercase tracking-wider"
                >
                  <i className="fa-solid fa-download text-[10px]"></i>
                  All ({availableImages.length})
                </button>
                <button onClick={() => {
                    const link = document.createElement('a');
                    link.href = availableImages[selectedImageIdx]?.src;
                    link.download = `celestialvision_${availableImages[selectedImageIdx]?.label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.jpg`;
                    link.click();
                  }}
                  className="bg-black border border-white/10 hover:border-white/25 text-white py-2.5 text-[11px] font-bold transition-all flex items-center justify-center gap-1.5 uppercase tracking-wider"
                >
                  <i className="fa-solid fa-image text-[10px]"></i>
                  This
                </button>
              </div>

              {/* Publish */}
              {publishState === 'success' ? (
                <div className="bg-white/5 border border-white/15 p-4 text-center space-y-2">
                  <div className="flex items-center justify-center gap-2 text-white/60 font-bold text-sm">
                    <i className="fa-solid fa-circle-check"></i> Published!
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {publishState === 'error' && (
                    <div className="border border-white/15 px-4 py-3 text-xs text-white/40 space-y-1">
                      <div className="flex items-start gap-2">
                        <i className="fa-solid fa-triangle-exclamation mt-0.5"></i>
                        <span>{publishError}</span>
                      </div>
                      <p className="text-white/20 text-[12px] pl-5">Use Copy + Download to post manually.</p>
                    </div>
                  )}
                  <button onClick={handlePublish}
                    disabled={!caption || isOverLimit || isGenerating || publishState === 'publishing'}
                    className="w-full hud-btn py-3 border-white/30 hover:border-white/60 disabled:border-white/10 text-sm"
                  >
                    {publishState === 'publishing' ? (
                      <><i className="fa-solid fa-spinner fa-spin"></i> Publishing...</>
                    ) : (
                      <><i className="fa-brands fa-instagram"></i> Publish to Instagram</>
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
