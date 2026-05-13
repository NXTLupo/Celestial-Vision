import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { instagramPublishPlugin } from './server/instagramApi';
import { applauseQueryPlugin } from './server/applauseApi';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 4200,
        strictPort: true,
        host: '0.0.0.0',
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
      plugins: [react(), instagramPublishPlugin(), applauseQueryPlugin(env.APPLAUSE_TOKEN || '')],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.APPLAUSE_TOKEN': JSON.stringify(env.APPLAUSE_TOKEN),
        'process.env.ASTROMETRY_API_KEY': JSON.stringify(env.ASTROMETRY_API_KEY)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
