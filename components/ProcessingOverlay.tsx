
import React from 'react';
import { ProcessingState } from '../types';
import { ParticleSphere, Waveform, DistortedWireframe, PerspectiveGrid } from './HudVisuals';

interface ProcessingOverlayProps {
  state: ProcessingState;
  image: string;
}

export const ProcessingOverlay: React.FC<ProcessingOverlayProps> = ({ state, image }) => {
  const isFailed = state.step === 'error' || state.logs.some(l => l.type === 'critical');

  return (
    <div className="space-y-0 animate-in fade-in duration-500">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-px bg-white/5">
        {/* Main Viewer */}
        <div className="lg:col-span-8 relative aspect-video overflow-hidden bg-black hud-frame">
          {/* Perspective grid background layer */}
          <div className="absolute inset-0 pointer-events-none">
            <PerspectiveGrid opacity={0.04} />
          </div>

          {/* Image preview — hidden in stark mode where it breaks the white aesthetic */}
          <img
            src={image}
            alt="Original"
            className="w-full h-full object-contain opacity-30 blur-[1px] relative z-[1] stark-hide"
          />

          {/* Scanning waveform across top */}
          <div className="absolute top-0 left-0 right-0 h-16 z-[2] pointer-events-none">
            <Waveform type="scanning" className="opacity-30 h-full" />
          </div>

          {/* Scanning line */}
          <div className="absolute inset-0 overflow-hidden z-[2]">
            <div className="h-px w-full bg-white shadow-[0_0_8px_#FFF] animate-[scan_3s_ease-in-out_infinite] absolute top-0"></div>
          </div>

          {/* Corner brackets */}
          <div className="absolute top-3 left-3 w-8 h-8 border-t border-l border-white/30 z-[3]"></div>
          <div className="absolute top-3 right-3 w-8 h-8 border-t border-r border-white/30 z-[3]"></div>
          <div className="absolute bottom-3 left-3 w-8 h-8 border-b border-l border-white/30 z-[3]"></div>
          <div className="absolute bottom-3 right-3 w-8 h-8 border-b border-r border-white/30 z-[3]"></div>

          {/* Center: LARGE particle sphere or distorted wireframe */}
          <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center z-[4]">
            {isFailed ? (
              <DistortedWireframe size={220} className="mb-6 opacity-70" />
            ) : (
              <ParticleSphere progress={state.progress} size={240} className="mb-6" />
            )}
            <h2 className="text-lg font-bold tracking-[0.4em] uppercase mb-2">{state.step}</h2>
            <p className="opacity-25 max-w-lg text-[11px] leading-relaxed uppercase tracking-[0.25em]">{state.message}</p>
          </div>

          {/* HUD greeble */}
          <div className="absolute top-3 left-14 text-[9px] opacity-10 tracking-widest z-[3]">FRAME::ACTIVE</div>
          <div className="absolute bottom-3 right-14 text-[9px] opacity-10 tracking-widest z-[3]">PROC::{state.progress}%</div>
        </div>

        {/* Inference Log */}
        <div className="lg:col-span-4 bg-black overflow-hidden flex flex-col h-[400px] lg:h-auto hud-frame hud-ticks-y">
          <div className="hud-header-bar">
            <i className="fa-solid fa-terminal"></i>
            Expert Reasoning Log
            <span className="ml-auto text-[9px] opacity-30 tracking-[0.2em]">SYS::LOG</span>
          </div>
          <div className="flex-grow overflow-y-auto p-4 space-y-2 text-[12px]">
            {state.logs.length === 0 ? (
              <p className="opacity-15 tracking-wider">Waiting for process initialization...</p>
            ) : (
              state.logs.map((log, i) => (
                <div key={i} className="animate-in slide-in-from-left-2 duration-300">
                  <span className="opacity-15 mr-2">[{log.timestamp}]</span>
                  <span className={`
                    ${log.type === 'success' ? 'opacity-70' :
                      log.type === 'critical' ? 'opacity-100 font-bold' :
                      log.type === 'warning' ? 'opacity-50' : 'opacity-35'}
                  `}>
                    {log.type === 'success' && '++ '}
                    {log.type === 'critical' && '!! '}
                    {log.type === 'warning' && '?? '}
                    {log.message}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* Spectral waveform at bottom of log */}
          <div className="h-12 border-t border-white/5 px-2">
            <Waveform type="spectral" frequency={2 + state.progress / 15} className="h-full opacity-20" />
          </div>
        </div>
      </div>

      {/* Progress Footer */}
      <div className="bg-black p-6 hud-frame hud-ticks-x greeble" data-gl="0xA1B2::PIPELINE" data-gr="SYS::NOMINAL">
        <div className="flex justify-between items-center mb-4">
          <span className="hud-label">Expert Pipeline Progress</span>
          <span className="text-xs font-bold tracking-widest">{state.progress}%</span>
        </div>
        <div className="w-full bg-white/5 h-px overflow-hidden relative">
          <div
            className="h-full bg-white transition-all duration-700 ease-out shadow-[0_0_6px_#FFF]"
            style={{ width: `${state.progress}%` }}
          ></div>
        </div>
        <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4">
           <StepIndicator active={state.progress >= 10} label="Ingest" code="01" />
           <StepIndicator active={state.progress >= 30} label="Inference" code="02" />
           <StepIndicator active={state.progress >= 60} label="Grounding" code="03" />
           <StepIndicator active={state.progress >= 90} label="Synthesis" code="04" />
        </div>
      </div>
    </div>
  );
};

const StepIndicator = ({ active, label, code }: { active: boolean; label: string; code: string }) => (
  <div className={`flex items-center gap-2 ${active ? 'opacity-100' : 'opacity-15'}`}>
    <span className="text-[10px] tracking-widest">{active ? '[X]' : '[ ]'}</span>
    <span className="text-[11px] font-bold tracking-[0.2em] uppercase">{code}_{label}</span>
  </div>
);
