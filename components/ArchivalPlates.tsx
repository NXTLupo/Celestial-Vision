
import React, { useState, useEffect, useCallback } from 'react';
import { ArchivalPlate, searchArchivalPlates, parseRaDegrees } from '../services/applause';
import { analyzeArchivalCrossMatch, ArchivalCrossAnalysis } from '../services/gemini';
import { IdentificationResult } from '../types';
import { WireframeGlobe } from './HudVisuals';

interface ArchivalPlatesProps {
  centerRa: string;
  centerDec: string;
  fieldOfView: string;
  userImage: string;
  results: IdentificationResult;
  onCrossAnalysis?: (report: CrossAnalysisReport) => void;
}

export interface CrossAnalysisReport {
  plate: ArchivalPlate;
  analysis: ArchivalCrossAnalysis;
  platePreviewUrl: string;
}

export const ArchivalPlates: React.FC<ArchivalPlatesProps> = ({
  centerRa,
  centerDec,
  fieldOfView,
  userImage,
  results,
  onCrossAnalysis,
}) => {
  const [plates, setPlates] = useState<ArchivalPlate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisComplete, setAnalysisComplete] = useState(false);
  const [analysisResults, setAnalysisResults] = useState<CrossAnalysisReport[]>([]);
  const [activeAnalysis, setActiveAnalysis] = useState<number>(0); // which plate is being analyzed

  const ra = parseRaDegrees(centerRa);
  const dec = parseRaDegrees(centerDec);

  const fovMatch = fieldOfView?.match(/([\d.]+)/);
  const fovDeg = fovMatch ? parseFloat(fovMatch[1]) : 1.0;

  const handleSearch = useCallback(async () => {
    if (ra === null || dec === null) return;
    setLoading(true);
    setError('');
    try {
      const searchResults = await searchArchivalPlates(ra, dec, Math.max(fovDeg, 1.0));
      const seen = new Set<string>();
      const unique = searchResults.filter(p => {
        if (seen.has(p.plate_id)) return false;
        seen.add(p.plate_id);
        return true;
      });
      setPlates(unique);
      setSearched(true);
    } catch (err: any) {
      setError(err.message || 'Search failed');
    } finally {
      setLoading(false);
    }
  }, [ra, dec, fovDeg]);

  // Auto-search on mount
  useEffect(() => {
    if (ra !== null && dec !== null && !searched) {
      handleSearch();
    }
  }, [ra, dec, handleSearch, searched]);

  // Auto-trigger cross-analysis on the best plates (up to 3)
  useEffect(() => {
    if (plates.length === 0 || analyzing || analysisComplete) return;

    const runCrossAnalysis = async () => {
      setAnalyzing(true);
      const platesToAnalyze = plates.slice(0, 3); // Analyze top 3 plates
      const reports: CrossAnalysisReport[] = [];

      for (let i = 0; i < platesToAnalyze.length; i++) {
        const plate = platesToAnalyze[i];
        setActiveAnalysis(i);
        const previewUrl = `/api/applause/preview?plate_id=${plate.plate_id}&archive_id=${plate.archive_id}`;

        try {
          const analysis = await analyzeArchivalCrossMatch(
            userImage,
            previewUrl,
            results,
            {
              plate_id: plate.plate_id,
              plate_num: plate.plate_num,
              date_orig: plate.date_orig,
              telescope: plate.telescope,
              ra_icrs: plate.ra_icrs,
              dec_icrs: plate.dec_icrs,
              fov1: plate.fov1,
              fov2: plate.fov2,
              exptime: plate.exptime,
            }
          );

          const report: CrossAnalysisReport = { plate, analysis, platePreviewUrl: previewUrl };
          reports.push(report);

          // Fire callback for each completed analysis so chat can update incrementally
          if (onCrossAnalysis) onCrossAnalysis(report);
        } catch (err: any) {
          console.error(`[APPLAUSE] Cross-analysis failed for plate ${plate.plate_id}:`, err);
        }
      }

      setAnalysisResults(reports);
      setAnalysisComplete(true);
      setAnalyzing(false);
    };

    runCrossAnalysis();
  }, [plates, analyzing, analysisComplete, userImage, results, onCrossAnalysis]);

  if (ra === null || dec === null) return null;

  const totalAnomalies = analysisResults.reduce(
    (sum, r) => sum + (r.analysis.anomalies?.length || 0), 0
  );
  const highSignificance = analysisResults.reduce(
    (sum, r) => sum + (r.analysis.anomalies?.filter(a => a.significance === 'high').length || 0), 0
  );

  return (
    <div className="bg-black hud-frame relative">
      <div className="hud-header-bar">
        <i className="fa-solid fa-clock-rotate-left"></i>
        Historical Archive // APPLAUSE Cross-Analysis
        <span className="ml-auto flex items-center gap-3">
          {analysisComplete && totalAnomalies > 0 && (
            <span className="text-[10px] tracking-[0.2em] border border-white/30 px-2 py-0.5 animate-pulse">
              {totalAnomalies} DETECTION{totalAnomalies !== 1 ? 'S' : ''}
              {highSignificance > 0 && ` // ${highSignificance} HIGH`}
            </span>
          )}
          <span className="text-[9px] text-white/20 tracking-[0.2em]">
            {plates.length > 0 ? `${plates.length} PLATES` : loading ? 'SEARCHING' : ''}
          </span>
        </span>
      </div>

      <div className="p-5">
        {/* Loading: Searching archive */}
        {loading && (
          <div className="flex items-center justify-center py-8 gap-4">
            <WireframeGlobe size={40} />
            <div>
              <p className="text-[11px] text-white/40 tracking-[0.2em] uppercase">Querying APPLAUSE Archive...</p>
              <p className="text-[10px] text-white/15 tracking-wider mt-1">
                RA {ra.toFixed(4)}° // Dec {dec.toFixed(4)}° // Radius {Math.max(fovDeg, 1.0).toFixed(1)}°
              </p>
            </div>
          </div>
        )}

        {/* Loading: Cross-analyzing plates */}
        {analyzing && (
          <div className="flex items-center justify-center py-6 gap-4">
            <div className="w-5 h-5 border border-white/20 border-t-white/60 animate-spin"></div>
            <div>
              <p className="text-[11px] text-white/40 tracking-[0.2em] uppercase">
                Cross-analyzing plate {activeAnalysis + 1} of {Math.min(plates.length, 3)}...
              </p>
              <p className="text-[10px] text-white/15 tracking-wider mt-1">
                Feeding archival data to Gemini for anomaly detection
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="py-4 text-[11px] text-white/40 tracking-wider">!! {error}</div>
        )}

        {searched && !loading && plates.length === 0 && (
          <div className="py-6 text-center">
            <p className="text-[11px] text-white/20 tracking-[0.2em] uppercase">
              No archival plates found for this sky region
            </p>
          </div>
        )}

        {/* Cross-Analysis Results — Detection Alerts */}
        {analysisComplete && analysisResults.length > 0 && (
          <div className="space-y-4">
            {/* Summary banner */}
            <div className="border border-white/10 p-4">
              <div className="flex items-start gap-4">
                <div className="w-8 h-8 border border-white/20 flex items-center justify-center shrink-0 mt-0.5">
                  <i className={`fa-solid ${totalAnomalies > 0 ? 'fa-triangle-exclamation' : 'fa-check'} text-white/40`}></i>
                </div>
                <div>
                  <p className="text-xs font-bold tracking-[0.15em] uppercase mb-1">
                    {totalAnomalies > 0
                      ? `${totalAnomalies} Anomal${totalAnomalies !== 1 ? 'ies' : 'y'} Detected Across ${analysisResults.length} Plate${analysisResults.length !== 1 ? 's' : ''}`
                      : `No Anomalies Detected Across ${analysisResults.length} Plates`
                    }
                  </p>
                  <p className="text-[11px] text-white/30 tracking-wider leading-relaxed">
                    {analysisResults.map(r => {
                      const year = r.plate.date_orig?.substring(0, 4) || '?';
                      return `${r.plate.plate_num || r.plate.plate_id} (${year})`;
                    }).join(' · ')}
                    {' '} — Baseline: {(() => {
                      const years = analysisResults
                        .map(r => r.plate.date_orig ? parseInt(r.plate.date_orig.substring(0, 4)) : 0)
                        .filter(y => y > 0);
                      if (years.length === 0) return '?';
                      const oldest = Math.min(...years);
                      return `${new Date().getFullYear() - oldest} years`;
                    })()}
                  </p>
                </div>
              </div>
            </div>

            {/* Per-plate results */}
            {analysisResults.map((report, idx) => {
              const year = report.plate.date_orig?.substring(0, 4) || '?';
              const anomalyCount = report.analysis.anomalies?.length || 0;

              return (
                <div key={idx} className="border border-white/8 bg-black">
                  {/* Plate header */}
                  <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
                    <div className="flex items-center gap-3">
                      <span className="text-[12px] font-bold tracking-[0.15em] uppercase">
                        {report.plate.plate_num || `#${report.plate.plate_id}`}
                      </span>
                      <span className="text-[10px] text-white/20 tracking-wider">
                        {year} // {report.plate.telescope || 'Unknown'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {anomalyCount > 0 ? (
                        <span className="text-[10px] tracking-[0.2em] border border-white/25 px-2 py-0.5">
                          {anomalyCount} DETECTION{anomalyCount !== 1 ? 'S' : ''}
                        </span>
                      ) : (
                        <span className="text-[10px] text-white/15 tracking-[0.2em]">CLEAR</span>
                      )}
                      {report.plate.archive_url && (
                        <a
                          href={report.plate.archive_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] text-white/20 hover:text-white/50 transition-colors"
                        >
                          <i className="fa-solid fa-external-link-alt"></i>
                        </a>
                      )}
                    </div>
                  </div>

                  {/* Plate assessment */}
                  {report.analysis.plate_assessment && (
                    <div className="px-4 py-2 border-b border-white/5">
                      <p className="text-[11px] text-white/25 tracking-wider leading-relaxed">
                        {report.analysis.plate_assessment}
                      </p>
                    </div>
                  )}

                  {/* Anomaly cards */}
                  {report.analysis.anomalies && report.analysis.anomalies.length > 0 && (
                    <div className="divide-y divide-white/5">
                      {report.analysis.anomalies.map((anomaly, aIdx) => (
                        <div key={aIdx} className="px-4 py-3 flex gap-3">
                          <div className={`
                            w-1.5 shrink-0 mt-1
                            ${anomaly.significance === 'high' ? 'bg-white/70' :
                              anomaly.significance === 'medium' ? 'bg-white/35' : 'bg-white/15'}
                          `} style={{ height: '100%', minHeight: '1rem' }}></div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-[10px] font-bold tracking-[0.2em] uppercase border border-white/15 px-1.5 py-0.5">
                                {anomaly.type.replace(/_/g, ' ')}
                              </span>
                              <span className={`text-[9px] tracking-[0.2em] uppercase
                                ${anomaly.significance === 'high' ? 'text-white/70' :
                                  anomaly.significance === 'medium' ? 'text-white/40' : 'text-white/20'}
                              `}>
                                {anomaly.significance}
                              </span>
                            </div>
                            <p className="text-[12px] text-white/50 leading-relaxed tracking-wide">
                              {anomaly.description}
                            </p>
                            {anomaly.possible_explanations && anomaly.possible_explanations.length > 0 && (
                              <div className="mt-1.5 flex flex-wrap gap-1.5">
                                {anomaly.possible_explanations.map((exp, eIdx) => (
                                  <span key={eIdx} className="text-[10px] text-white/20 tracking-wider bg-white/[0.03] px-2 py-0.5 border border-white/5">
                                    {exp}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Plate grid — collapsed summary of all searched plates */}
        {searched && !loading && plates.length > 0 && (
          <div className="mt-4 border-t border-white/5 pt-4">
            <p className="text-[10px] text-white/15 tracking-[0.2em] uppercase mb-2">
              All {plates.length} plates in this sky region
            </p>
            <div className="flex flex-wrap gap-1">
              {plates.map((plate, idx) => {
                const isAnalyzed = analysisResults.some(r => r.plate.plate_id === plate.plate_id);
                return (
                  <span
                    key={`plate-${plate.plate_id}-${idx}`}
                    className={`text-[9px] tracking-wider px-2 py-0.5 border transition-all
                      ${isAnalyzed ? 'border-white/20 text-white/40' : 'border-white/5 text-white/15'}
                    `}
                  >
                    {plate.plate_num || plate.plate_id} ({plate.date_orig?.substring(0, 4) || '?'})
                  </span>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
