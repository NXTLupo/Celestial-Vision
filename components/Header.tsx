
import React from 'react';

interface HeaderProps {
  onReset: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onReset }) => {
  return (
    <header className="sticky top-0 z-50 bg-slate-900/80 backdrop-blur-md border-b border-slate-800 px-6 py-4">
      <div className="container mx-auto flex justify-between items-center">
        <div 
          className="flex items-center gap-3 cursor-pointer group"
          onClick={onReset}
        >
          <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-500/20 group-hover:scale-110 transition-transform">
            <i className="fa-solid fa-star text-white text-xl"></i>
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white">CELESTIAL<span className="text-indigo-400">VISION</span></h1>
            <p className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">Autonomous Astro-ID Engine</p>
          </div>
        </div>
        
        <nav className="hidden md:flex items-center gap-6">
          <a href="#" className="text-sm font-medium text-slate-300 hover:text-white transition-colors">Documentation</a>
          <a href="#" className="text-sm font-medium text-slate-300 hover:text-white transition-colors">Catalogues</a>
          <button 
            onClick={onReset}
            className="bg-slate-800 hover:bg-slate-700 text-white px-4 py-2 rounded-lg text-sm font-medium border border-slate-700 transition-all"
          >
            New Analysis
          </button>
        </nav>
      </div>
    </header>
  );
};
