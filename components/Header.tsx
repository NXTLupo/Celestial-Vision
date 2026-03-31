
import React, { useState, useEffect } from 'react';
import { ThemeToggle } from './HudVisuals';

interface HeaderProps {
  onReset: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onReset }) => {
  const [isDark, setIsDark] = useState(() => !document.body.classList.contains('stark'));

  const handleToggle = () => {
    const next = !isDark;
    setIsDark(next);
    if (next) {
      document.body.classList.remove('stark');
    } else {
      document.body.classList.add('stark');
    }
  };

  return (
    <header className="sticky top-0 z-50 bg-black/90 backdrop-blur-sm border-b border-white/10 px-6 py-3 stark:bg-white/90 stark:border-black/10">
      <div className="container mx-auto flex justify-between items-center">
        <div
          className="flex items-center gap-3 cursor-pointer group"
          onClick={onReset}
        >
          <div className="w-9 h-9 border border-white/30 flex items-center justify-center group-hover:border-white/60 transition-colors">
            <i className="fa-solid fa-crosshairs text-sm"></i>
          </div>
          <div>
            <h1 className="text-base font-bold tracking-[0.2em] uppercase">
              <span className="opacity-30">[</span> Celestial_Vision <span className="opacity-30">]</span>
            </h1>
            <p className="text-[10px] tracking-[0.3em] opacity-30 uppercase">Autonomous Astro-ID Engine // v2.0</p>
          </div>
        </div>

        <nav className="hidden md:flex items-center gap-1">
          <span className="text-[9px] opacity-10 tracking-widest mr-3">SYS::NAV</span>
          <a href="#" className="text-[12px] font-bold tracking-widest opacity-40 hover:opacity-100 transition-opacity uppercase px-3 py-2 border border-transparent hover:border-white/10">Documentation</a>
          <a href="#" className="text-[12px] font-bold tracking-widest opacity-40 hover:opacity-100 transition-opacity uppercase px-3 py-2 border border-transparent hover:border-white/10">Catalogues</a>
          <ThemeToggle isDark={isDark} onToggle={handleToggle} />
          <button
            onClick={onReset}
            className="hud-btn ml-2 text-[12px] py-2 px-4"
          >
            New Analysis
          </button>
        </nav>
      </div>
    </header>
  );
};
