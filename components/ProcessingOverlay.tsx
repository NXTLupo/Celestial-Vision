
import React from 'react';
import { ProcessingState } from '../types';

interface ProcessingOverlayProps {
  state: ProcessingState;
  image: string;
}

export const ProcessingOverlay: React.FC<ProcessingOverlayProps> = ({ state, image }) => {
  return (
    <div className="max-w-6xl mx-auto space-y-8 animate-in fade-in duration-500">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Main Viewer */}
        <div className="lg:col-span-8 relative aspect-video rounded-3xl overflow-hidden bg-slate-900 border border-slate-800 shadow-2xl">
          <img 
            src={image} 
            alt="Original" 
            className="w-full h-full object-contain opacity-40 blur-[2px]"
          />
          
          <div className="absolute inset-0 overflow-hidden">
            <div className="h-0.5 w-full bg-indigo-500 shadow-[0_0_20px_#6366f1] animate-[scan_3s_ease-in-out_infinite] absolute top-0"></div>
          </div>

          <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center bg-slate-900/40">
            <div className="w-16 h-16 mb-6">
               <div className="w-full h-full rounded-full border-4 border-slate-700 border-t-indigo-500 animate-spin"></div>
            </div>
            <h2 className="text-3xl font-bold text-white mb-2 tracking-tight">{state.step.toUpperCase()}</h2>
            <p className="text-slate-300 max-w-md font-mono text-[10px] leading-relaxed uppercase tracking-widest">{state.message}</p>
          </div>
        </div>

        {/* Inference Log (Chain of Thought) */}
        <div className="lg:col-span-4 bg-slate-950/80 border border-slate-800 rounded-3xl overflow-hidden flex flex-col h-[400px] lg:h-auto shadow-2xl backdrop-blur-md">
          <div className="px-5 py-4 border-b border-slate-800 bg-slate-900/50 flex justify-between items-center">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Expert Reasoning Log</span>
            <div className="flex gap-1">
              <div className="w-1.5 h-1.5 rounded-full bg-red-500/50"></div>
              <div className="w-1.5 h-1.5 rounded-full bg-yellow-500/50"></div>
              <div className="w-1.5 h-1.5 rounded-full bg-green-500/50"></div>
            </div>
          </div>
          <div className="flex-grow overflow-y-auto p-5 space-y-3 font-mono text-[11px] custom-scrollbar bg-black/40">
            {state.logs.length === 0 ? (
              <p className="text-slate-700 italic">Waiting for process initialization...</p>
            ) : (
              state.logs.map((log, i) => (
                <div key={i} className="animate-in slide-in-from-left-2 duration-300">
                  <span className="text-slate-600 mr-2">[{log.timestamp}]</span>
                  <span className={`
                    ${log.type === 'success' ? 'text-emerald-400' : 
                      log.type === 'critical' ? 'text-red-400 font-bold' : 
                      log.type === 'warning' ? 'text-yellow-400' : 'text-slate-300'}
                  `}>
                    {log.type === 'success' && <i className="fa-solid fa-check-double mr-1.5 text-[9px]"></i>}
                    {log.type === 'critical' && <i className="fa-solid fa-triangle-exclamation mr-1.5"></i>}
                    {log.message}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Progress Footer */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 shadow-xl">
        <div className="flex justify-between items-center mb-4">
          <span className="text-slate-400 text-[10px] font-bold uppercase tracking-widest">Expert Pipeline Progress</span>
          <span className="text-indigo-400 text-sm font-bold">{state.progress}%</span>
        </div>
        <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
          <div 
            className="h-full bg-indigo-500 transition-all duration-700 ease-out shadow-[0_0_10px_#6366f1]"
            style={{ width: `${state.progress}%` }}
          ></div>
        </div>
        <div className="mt-8 grid grid-cols-2 md:grid-cols-4 gap-4">
           <StepIndicator active={state.progress >= 10} label="Ingest" />
           <StepIndicator active={state.progress >= 30} label="Inference" />
           <StepIndicator active={state.progress >= 60} label="Grounding" />
           <StepIndicator active={state.progress >= 90} label="Synthesis" />
        </div>
      </div>

      <style>{`
        @keyframes scan {
          0% { top: 0% }
          50% { top: 100% }
          100% { top: 0% }
        }
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #1e293b;
          border-radius: 10px;
        }
      `}</style>
    </div>
  );
};

const StepIndicator = ({ active, label }: { active: boolean; label: string }) => (
  <div className={`flex items-center gap-2 ${active ? 'text-white' : 'text-slate-600'}`}>
    <div className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-indigo-500 animate-pulse' : 'bg-slate-800'}`}></div>
    <span className="text-[10px] font-bold tracking-widest uppercase">{label}</span>
  </div>
);
