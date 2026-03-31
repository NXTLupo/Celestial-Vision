
import React, { useRef, useEffect, useState } from 'react';

/* ================================================================
   HUD VISUAL COMPONENTS
   Advanced spatial, particle, and wireframe elements for the
   Celestial Vision command terminal aesthetic.
   ================================================================ */

// Read the current foreground color from CSS variables (for canvas rendering)
// Must read from document.body because body.stark overrides the variable
const getHudColor = (): string => {
  const val = getComputedStyle(document.body).getPropertyValue('--c-w').trim();
  return val || '255 255 255';
};
const hudRgba = (alpha: number) => {
  const c = getHudColor();
  return `rgba(${c.replace(/ /g, ',')},${alpha})`;
};

// ─── PERSPECTIVE GRID ────────────────────────────────────────────
// Receding wireframe plane with vanishing point depth.
// Used as background layer behind image viewers.
export const PerspectiveGrid: React.FC<{
  opacity?: number;
  className?: string;
}> = ({ opacity = 0.06, className = '' }) => {
  const rows = 20;
  const cols = 24;
  return (
    <svg
      viewBox="0 0 800 500"
      className={`w-full h-full ${className}`}
      preserveAspectRatio="none"
      style={{ opacity }}
    >
      {/* Horizontal lines with perspective convergence */}
      {Array.from({ length: rows }, (_, i) => {
        const t = i / (rows - 1);
        const y = 250 + (t - 0.5) * 500 * Math.pow(t, 0.4);
        const squeeze = 1 - t * 0.7;
        const x1 = 400 - 400 * squeeze;
        const x2 = 400 + 400 * squeeze;
        return (
          <line
            key={`h${i}`}
            x1={x1} y1={y} x2={x2} y2={y}
            stroke="currentColor"
            strokeWidth={0.5 + t * 0.5}
          />
        );
      })}
      {/* Vertical lines converging to vanishing point */}
      {Array.from({ length: cols }, (_, i) => {
        const t = i / (cols - 1);
        const x = t * 800;
        return (
          <line
            key={`v${i}`}
            x1={x} y1={500} x2={400} y2={0}
            stroke="currentColor"
            strokeWidth={0.3}
            opacity={0.3 + Math.abs(t - 0.5) * 0.4}
          />
        );
      })}
      {/* Intersection nodes */}
      {Array.from({ length: 8 }, (_, i) => {
        const t = (i + 1) / 9;
        const y = 250 + (t - 0.5) * 400;
        return Array.from({ length: 5 }, (_, j) => {
          const x = 400 + (j - 2) * 80 * (1 - t * 0.6);
          return (
            <circle
              key={`n${i}${j}`}
              cx={x} cy={y} r={0.8}
              fill="currentColor"
              opacity={0.3}
            >
              <animate
                attributeName="opacity"
                values="0.1;0.5;0.1"
                dur={`${3 + Math.random() * 4}s`}
                repeatCount="indefinite"
              />
            </circle>
          );
        });
      })}
    </svg>
  );
};

// ─── PARTICLE SPHERE ─────────────────────────────────────────────
// Dense rotating particle sphere for processing/analysis states.
// Particles expand outward as matches are found.
export const ParticleSphere: React.FC<{
  progress?: number; // 0-100: controls expansion
  size?: number;
  className?: string;
}> = ({ progress = 0, size = 200, className = '' }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number>(0);
  const particlesRef = useRef<{ x: number; y: number; z: number; vx: number; vy: number; vz: number }[]>([]);

  useEffect(() => {
    // Generate particles once
    if (particlesRef.current.length === 0) {
      for (let i = 0; i < 300; i++) {
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        const r = 0.3 + Math.random() * 0.7;
        particlesRef.current.push({
          x: r * Math.sin(phi) * Math.cos(theta),
          y: r * Math.sin(phi) * Math.sin(theta),
          z: r * Math.cos(phi),
          vx: (Math.random() - 0.5) * 0.02,
          vy: (Math.random() - 0.5) * 0.02,
          vz: (Math.random() - 0.5) * 0.02,
        });
      }
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    canvas.width = size * 2; // retina
    canvas.height = size * 2;

    let angle = 0;
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      angle += 0.005;
      const expansion = 1 + (progress / 100) * 1.5;
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const scale = size * 0.7;

      // Draw vector lines from center
      ctx.strokeStyle = hudRgba(0.12);
      ctx.lineWidth = 0.5;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + angle;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * scale * expansion, cy + Math.sin(a) * scale * expansion);
        ctx.stroke();
      }

      // Draw particles
      const sorted = particlesRef.current.map(p => {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const rx = p.x * cos - p.z * sin;
        const rz = p.x * sin + p.z * cos;
        return { ...p, rx, ry: p.y, rz, depth: rz };
      }).sort((a, b) => a.depth - b.depth);

      for (const p of sorted) {
        const px = cx + p.rx * scale * expansion;
        const py = cy + p.ry * scale * expansion;
        const brightness = 0.4 + (p.rz + 1) * 0.3;
        const sz = 1.5 + (p.rz + 1) * 2.5;

        ctx.fillStyle = hudRgba(brightness);
        ctx.fillRect(px - sz / 2, py - sz / 2, sz, sz);
      }

      // Outer ring
      ctx.strokeStyle = hudRgba(0.1 + (progress / 100) * 0.15);
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.arc(cx, cy, scale * expansion, 0, Math.PI * 2);
      ctx.stroke();

      frameRef.current = requestAnimationFrame(draw);
    };
    draw();

    return () => cancelAnimationFrame(frameRef.current);
  }, [progress, size]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size }}
      className={className}
    />
  );
};

// ─── WAVEFORM ────────────────────────────────────────────────────
// Oscillating waveform for scanning/spectral states.
export const Waveform: React.FC<{
  type?: 'scanning' | 'spectral';
  frequency?: number; // 1-10 for spectral class mapping
  className?: string;
}> = ({ type = 'scanning', frequency = 3, className = '' }) => {
  const points = 80;
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    let frame: number;
    const animate = () => {
      setOffset(prev => prev + 0.05);
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, []);

  const generatePath = () => {
    const pts: string[] = [];
    for (let i = 0; i <= points; i++) {
      const t = i / points;
      const x = t * 100;
      let y: number;
      if (type === 'scanning') {
        // Chaotic circular waveform
        y = 50 + Math.sin(t * 12 + offset) * 15 * Math.sin(t * 3 + offset * 0.7)
              + Math.sin(t * 7 - offset * 1.3) * 8;
      } else {
        // Symmetrical spectral waveform — frequency maps to spectral class
        const amp = 20 / (1 + frequency * 0.3);
        const freq = frequency * 2;
        y = 50 + Math.sin(t * freq * Math.PI + offset) * amp
              * Math.exp(-Math.pow((t - 0.5) * 3, 2));
      }
      pts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return pts.join(' ');
  };

  return (
    <svg viewBox="0 0 100 100" className={`w-full ${className}`} preserveAspectRatio="none">
      {/* Center line */}
      <line x1="0" y1="50" x2="100" y2="50" stroke="currentColor" strokeWidth="0.2" opacity="0.1" />
      {/* Waveform */}
      <path
        d={generatePath()}
        fill="none"
        stroke="currentColor"
        strokeWidth="0.5"
        opacity="0.4"
      />
      {/* Glow duplicate */}
      <path
        d={generatePath()}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity="0.08"
      />
    </svg>
  );
};

// ─── STACKED RETICLE ─────────────────────────────────────────────
// Multi-layered targeting rings for major identified objects.
// Rings spin on opposing axes.
export const StackedReticle: React.FC<{
  size?: number;
  active?: boolean;
  className?: string;
}> = ({ size = 48, active = true, className = '' }) => {
  return (
    <div className={`relative ${className}`} style={{ width: size, height: size }}>
      {/* Outer ring — slow spin */}
      <svg
        viewBox="0 0 100 100"
        className="absolute inset-0 w-full h-full"
        style={{ animation: active ? 'spin 12s linear infinite' : 'none' }}
      >
        <circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" strokeWidth="0.5" opacity="0.2"
          strokeDasharray="4 3"
        />
        {/* Tick marks */}
        {[0, 90, 180, 270].map(deg => (
          <line
            key={deg}
            x1="50" y1="2" x2="50" y2="8"
            stroke="currentColor" strokeWidth="0.8" opacity="0.4"
            transform={`rotate(${deg} 50 50)`}
          />
        ))}
      </svg>

      {/* Middle ring — counter spin */}
      <svg
        viewBox="0 0 100 100"
        className="absolute inset-0 w-full h-full"
        style={{ animation: active ? 'spin 8s linear infinite reverse' : 'none' }}
      >
        <circle cx="50" cy="50" r="36" fill="none" stroke="currentColor" strokeWidth="0.5" opacity="0.3" />
        {/* Corner brackets */}
        {[0, 90, 180, 270].map(deg => (
          <g key={deg} transform={`rotate(${deg} 50 50)`}>
            <line x1="50" y1="14" x2="50" y2="20" stroke="currentColor" strokeWidth="0.6" opacity="0.5" />
          </g>
        ))}
      </svg>

      {/* Inner ring — fast spin */}
      <svg
        viewBox="0 0 100 100"
        className="absolute inset-0 w-full h-full"
        style={{ animation: active ? 'spin 5s linear infinite' : 'none' }}
      >
        <circle cx="50" cy="50" r="24" fill="none" stroke="currentColor" strokeWidth="0.8" opacity="0.4"
          strokeDasharray="2 4"
        />
      </svg>

      {/* Center crosshair — static */}
      <svg viewBox="0 0 100 100" className="absolute inset-0 w-full h-full">
        <line x1="50" y1="38" x2="50" y2="44" stroke="currentColor" strokeWidth="0.8" opacity="0.6" />
        <line x1="50" y1="56" x2="50" y2="62" stroke="currentColor" strokeWidth="0.8" opacity="0.6" />
        <line x1="38" y1="50" x2="44" y2="50" stroke="currentColor" strokeWidth="0.8" opacity="0.6" />
        <line x1="56" y1="50" x2="62" y2="50" stroke="currentColor" strokeWidth="0.8" opacity="0.6" />
        <circle cx="50" cy="50" r="1.5" fill="currentColor" opacity="0.8">
          {active && (
            <animate attributeName="opacity" values="0.4;1;0.4" dur="2s" repeatCount="indefinite" />
          )}
        </circle>
      </svg>
    </div>
  );
};

// ─── WIREFRAME GLOBE ─────────────────────────────────────────────
// Slowly rotating latitude/longitude wireframe sphere.
export const WireframeGlobe: React.FC<{
  size?: number;
  className?: string;
}> = ({ size = 120, className = '' }) => {
  const lats = 10;
  const lons = 12;
  return (
    <div className={`relative ${className}`} style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" className="w-full h-full" style={{ animation: 'spin 20s linear infinite' }}>
        {/* Latitude rings */}
        {Array.from({ length: lats }, (_, i) => {
          const t = (i + 1) / (lats + 1);
          const y = t * 100;
          const ry = Math.sin(t * Math.PI) * 45;
          return (
            <ellipse
              key={`lat${i}`}
              cx="50" cy={y}
              rx={ry} ry={ry * 0.3}
              fill="none" stroke="currentColor"
              strokeWidth="0.4"
              opacity={0.15 + Math.sin(t * Math.PI) * 0.1}
            />
          );
        })}
        {/* Longitude arcs */}
        {Array.from({ length: lons }, (_, i) => {
          const angle = (i / lons) * Math.PI;
          const rx = Math.cos(angle) * 45;
          return (
            <ellipse
              key={`lon${i}`}
              cx="50" cy="50"
              rx={Math.abs(rx) || 0.5} ry="45"
              fill="none" stroke="currentColor"
              strokeWidth="0.4"
              opacity={0.1 + Math.abs(Math.cos(angle)) * 0.15}
            />
          );
        })}
        {/* Equator */}
        <ellipse cx="50" cy="50" rx="45" ry="13" fill="none" stroke="currentColor" strokeWidth="0.6" opacity="0.25" />
        {/* Outer boundary */}
        <circle cx="50" cy="50" r="45" fill="none" stroke="currentColor" strokeWidth="0.5" opacity="0.2" />
      </svg>
    </div>
  );
};

// ─── DISTORTED WIREFRAME ─────────────────────────────────────────
// Melting/corrupted sphere for error/anomaly states.
export const DistortedWireframe: React.FC<{
  size?: number;
  className?: string;
}> = ({ size = 120, className = '' }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    canvas.width = size * 2;
    canvas.height = size * 2;
    let time = 0;

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      time += 0.02;
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const r = size * 0.6;

      ctx.strokeStyle = hudRgba(0.15);
      ctx.lineWidth = 0.8;

      // Draw latitude rings with distortion
      for (let lat = 0; lat < 12; lat++) {
        const phi = (lat / 12) * Math.PI;
        ctx.beginPath();
        for (let i = 0; i <= 60; i++) {
          const theta = (i / 60) * Math.PI * 2;
          const distort = 1 + Math.sin(phi * 3 + time + theta * 2) * 0.3
                          + Math.sin(time * 2 + lat) * 0.15 * (phi > Math.PI * 0.6 ? 2 : 0.5);
          // "Melting" — lower hemisphere droops
          const droop = phi > Math.PI * 0.5 ? (phi - Math.PI * 0.5) * Math.sin(time + theta) * 0.4 : 0;

          const x = cx + r * Math.sin(phi) * Math.cos(theta) * distort;
          const y = cy + r * Math.cos(phi) * distort + droop * r * 0.5;

          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // Draw longitude lines with distortion
      for (let lon = 0; lon < 10; lon++) {
        const theta = (lon / 10) * Math.PI * 2;
        ctx.beginPath();
        for (let i = 0; i <= 40; i++) {
          const phi = (i / 40) * Math.PI;
          const distort = 1 + Math.sin(phi * 2 + time * 1.5 + theta) * 0.2;
          const droop = phi > Math.PI * 0.5 ? (phi - Math.PI * 0.5) * Math.sin(time + theta) * 0.4 : 0;

          const x = cx + r * Math.sin(phi) * Math.cos(theta) * distort;
          const y = cy + r * Math.cos(phi) * distort + droop * r * 0.5;

          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      frameRef.current = requestAnimationFrame(draw);
    };
    draw();

    return () => cancelAnimationFrame(frameRef.current);
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size }}
      className={className}
    />
  );
};

// ─── DATA CALLOUT LINE ───────────────────────────────────────────
// Orthogonal line from an object to an edge data block.
export const DataCalloutLine: React.FC<{
  startX: number; // percentage 0-100
  startY: number;
  label: string;
  sublabel?: string;
  side?: 'left' | 'right';
}> = ({ startX, startY, label, sublabel, side = 'right' }) => {
  const endX = side === 'right' ? 95 : 5;
  const midX = side === 'right' ? Math.max(startX + 5, endX - 15) : Math.min(startX - 5, endX + 15);

  return (
    <div className="absolute inset-0 pointer-events-none z-10">
      <svg className="w-full h-full" preserveAspectRatio="none">
        {/* Horizontal then vertical orthogonal line */}
        <line
          x1={`${startX}%`} y1={`${startY}%`}
          x2={`${midX}%`} y2={`${startY}%`}
          stroke="currentColor" strokeWidth="0.5" opacity="0.15"
        />
        <line
          x1={`${midX}%`} y1={`${startY}%`}
          x2={`${endX}%`} y2={`${startY}%`}
          stroke="currentColor" strokeWidth="0.5" opacity="0.15"
          strokeDasharray="2 2"
        />
      </svg>
      {/* Data block at terminus */}
      <div
        className="absolute text-right"
        style={{
          [side]: '1%',
          top: `${startY - 2}%`,
        }}
      >
        <div className="text-[9px] text-white/40 tracking-[0.2em] uppercase font-bold">{label}</div>
        {sublabel && (
          <div className="text-[6px] text-white/15 tracking-widest">{sublabel}</div>
        )}
      </div>
    </div>
  );
};

// ─── THEME TOGGLE (Dark/Stark) ───────────────────────────────────
// Flash transition between dark and light modes.
export const ThemeToggle: React.FC<{
  isDark: boolean;
  onToggle: () => void;
}> = ({ isDark, onToggle }) => {
  const [flashing, setFlashing] = useState(false);

  const handleToggle = () => {
    setFlashing(true);
    setTimeout(() => {
      onToggle();
      setTimeout(() => setFlashing(false), 150);
    }, 100);
  };

  return (
    <>
      {/* Flash overlay */}
      {flashing && (
        <div
          className="fixed inset-0 z-[9999] pointer-events-none"
          style={{
            background: isDark ? '#FFFFFF' : '#000000',
            animation: 'flash-out 250ms ease-out forwards',
          }}
        />
      )}
      <button
        onClick={handleToggle}
        className="hud-btn px-3 py-1.5 text-[11px]"
        title={isDark ? 'Switch to Stark Mode' : 'Switch to Deep Space Mode'}
      >
        <i className={`fa-solid ${isDark ? 'fa-sun' : 'fa-moon'} text-[10px]`}></i>
        {isDark ? 'STARK' : 'DEEP'}
      </button>

      <style>{`
        @keyframes flash-out {
          0% { opacity: 1; }
          100% { opacity: 0; }
        }
      `}</style>
    </>
  );
};

// ─── AI THINKING ANIMATION ──────────────────────────────────────
// Neural-network-inspired canvas animation with pulsing nodes,
// traveling signals, and orbiting scan ring.
export const AiThinkingAnimation: React.FC<{
  className?: string;
}> = ({ className = '' }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let animId: number;
    const dpr = window.devicePixelRatio || 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
    };
    resize();

    const W = () => canvas.width / dpr;
    const H = () => canvas.height / dpr;

    // Neural nodes
    const nodeCount = 18;
    const nodes: { x: number; y: number; vx: number; vy: number; r: number; phase: number }[] = [];
    for (let i = 0; i < nodeCount; i++) {
      nodes.push({
        x: Math.random() * 300, y: Math.random() * 80,
        vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.15,
        r: 1.5 + Math.random() * 2, phase: Math.random() * Math.PI * 2,
      });
    }

    // Traveling signal pulses
    const signals: { from: number; to: number; t: number; speed: number }[] = [];

    let frame = 0;
    const draw = () => {
      const w = W(), h = H();
      ctx.clearRect(0, 0, w, h);
      const c = getHudColor();
      frame++;

      // Update nodes — gentle drift
      for (const n of nodes) {
        n.x += n.vx;
        n.y += n.vy;
        if (n.x < 20 || n.x > w - 20) n.vx *= -1;
        if (n.y < 10 || n.y > h - 10) n.vy *= -1;
        n.phase += 0.02;
      }

      // Spawn new signals periodically
      if (frame % 8 === 0) {
        const from = Math.floor(Math.random() * nodeCount);
        let to = Math.floor(Math.random() * nodeCount);
        if (to === from) to = (to + 1) % nodeCount;
        signals.push({ from, to, t: 0, speed: 0.02 + Math.random() * 0.03 });
      }

      // Draw connections (faint)
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x;
          const dy = nodes[i].y - nodes[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 120) {
            const alpha = (1 - dist / 120) * 0.08;
            ctx.beginPath();
            ctx.moveTo(nodes[i].x, nodes[i].y);
            ctx.lineTo(nodes[j].x, nodes[j].y);
            ctx.strokeStyle = `rgba(${c.replace(/ /g, ',')},${alpha})`;
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        }
      }

      // Draw & update signals
      for (let s = signals.length - 1; s >= 0; s--) {
        const sig = signals[s];
        sig.t += sig.speed;
        if (sig.t >= 1) { signals.splice(s, 1); continue; }
        const a = nodes[sig.from], b = nodes[sig.to];
        const x = a.x + (b.x - a.x) * sig.t;
        const y = a.y + (b.y - a.y) * sig.t;
        const glow = Math.sin(sig.t * Math.PI); // brightest at midpoint
        ctx.beginPath();
        ctx.arc(x, y, 2 + glow * 2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${c.replace(/ /g, ',')},${0.3 + glow * 0.5})`;
        ctx.fill();
      }

      // Draw nodes
      for (const n of nodes) {
        const pulse = 0.4 + 0.6 * Math.abs(Math.sin(n.phase));
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${c.replace(/ /g, ',')},${pulse * 0.5})`;
        ctx.fill();
      }

      // Central scan ring
      const cx = w / 2, cy = h / 2;
      const ringR = 16;
      const angle = frame * 0.03;
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, angle, angle + Math.PI * 1.2);
      ctx.strokeStyle = `rgba(${c.replace(/ /g, ',')},0.25)`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Inner dot
      ctx.beginPath();
      ctx.arc(cx, cy, 2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${c.replace(/ /g, ',')},${0.3 + 0.3 * Math.sin(frame * 0.05)})`;
      ctx.fill();

      animId = requestAnimationFrame(draw);
    };
    draw();

    return () => cancelAnimationFrame(animId);
  }, []);

  return <canvas ref={canvasRef} className={`w-full h-full ${className}`} />;
};

// ─── IMAGE LIGHTBOX MODAL ────────────────────────────────────────
// Universal full-screen image viewer. Any image in the app can open this.
export const ImageLightbox: React.FC<{
  src: string;
  alt?: string;
  onClose: () => void;
  invert?: boolean; // For archival plates
}> = ({ src, alt = 'Image', onClose, invert = false }) => {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[300] bg-black/95 flex items-center justify-center p-6 animate-in fade-in duration-200 cursor-zoom-out"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute top-6 right-6 text-white/40 hover:text-white text-2xl transition-colors z-[310]"
      >
        <i className="fa-solid fa-xmark"></i>
      </button>

      {/* Corner brackets */}
      <div className="absolute top-10 left-10 w-10 h-10 border-t-2 border-l-2 border-white/15 pointer-events-none"></div>
      <div className="absolute top-10 right-10 w-10 h-10 border-t-2 border-r-2 border-white/15 pointer-events-none"></div>
      <div className="absolute bottom-10 left-10 w-10 h-10 border-b-2 border-l-2 border-white/15 pointer-events-none"></div>
      <div className="absolute bottom-10 right-10 w-10 h-10 border-b-2 border-r-2 border-white/15 pointer-events-none"></div>

      <img
        src={src}
        alt={alt}
        className="max-w-[90vw] max-h-[90vh] object-contain cursor-default"
        style={invert ? { filter: 'invert(1)' } : undefined}
        onClick={(e) => e.stopPropagation()}
      />

      {/* Label bar */}
      <div className="absolute bottom-10 left-1/2 -translate-x-1/2 text-[11px] text-white/25 tracking-[0.2em] uppercase pointer-events-none">
        {alt}
      </div>

      {/* Download button */}
      <a
        href={src}
        download={`celestialvision_${alt.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.jpg`}
        onClick={(e) => e.stopPropagation()}
        className="absolute bottom-6 right-6 hud-btn py-1.5 px-4 text-[11px] z-[310]"
      >
        <i className="fa-solid fa-download text-[10px]"></i>
        Download
      </a>
    </div>
  );
};
