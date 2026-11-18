import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { applauseQueryPlugin } from './server/applauseApi';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 4200,
        strictPort: true,
        host: '127.0.0.1',
        proxy: {
          '/proxy/astrometry': {
            target: 'https://nova.astrometry.net',
            changeOrigin: true,
            rewrite: (p: string) => p.replace(/^\/proxy\/astrometry/, ''),
          },
          '/proxy/cobs': {
            target: 'https://cobs.si',
            changeOrigin: true,
            rewrite: (p: string) => p.replace(/^\/proxy\/cobs/, ''),
          },
          '/proxy/horizons': {
            target: 'https://ssd.jpl.nasa.gov',
            changeOrigin: true,
            rewrite: (p: string) => p.replace(/^\/proxy\/horizons/, ''),
          },
          '/proxy/celestrak': {
            target: 'https://celestrak.org',
            changeOrigin: true,
            rewrite: (p: string) => p.replace(/^\/proxy\/celestrak/, ''),
            headers: { 'User-Agent': 'CelestialVisionAI/2.0 (astrophotography research tool)' },
          },
          '/proxy/satchecker': {
            target: 'https://satchecker.cps.iau.org',
            changeOrigin: true,
            rewrite: (p: string) => p.replace(/^\/proxy\/satchecker/, ''),
          },
          '/proxy/pluto': {
            target: 'https://projectpluto.com',
            changeOrigin: true,
            rewrite: (p: string) => p.replace(/^\/proxy\/pluto/, ''),
          },
        },
      },
      plugins: [react(), applauseQueryPlugin(env.APPLAUSE_TOKEN || '')],
      // NOTE: client-side keys are inlined into the bundle by Vite at build time.
      // This app is intended for LOCAL development use with your own keys only.
      // Do not deploy publicly without first moving keyed API calls behind server-side proxies.
      // See SECURITY.md for details.
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.APPLAUSE_TOKEN': JSON.stringify(env.APPLAUSE_TOKEN),
        'process.env.ASTROMETRY_API_KEY': JSON.stringify(env.ASTROMETRY_API_KEY),
        'process.env.NASA_API_KEY': JSON.stringify(env.NASA_API_KEY || '')
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
