# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Celestial Vision AI — a React + TypeScript web app for autonomous celestial object identification. Users upload astronomical images, which are analyzed through parallel API calls (Astrometry.net plate solving, NASA NeoWs, COBS comet database, JPL Horizons ephemeris) and synthesized by Google Gemini 3 Pro vision model.

## Commands

```bash
npm run dev       # Start Vite dev server on localhost:3000
npm run build     # Production build to dist/
npm run preview   # Preview production build
```

No test framework, linter, or CI/CD is configured.

## Architecture

### Processing Pipeline

Image upload triggers a 4-stage pipeline orchestrated in `App.tsx`:

1. **Ingestion** — Extract EXIF metadata (camera, date, GPS location, focal length)
2. **Parallel Analysis** — All external APIs called concurrently via `Promise.all`:
   - `services/astrometry.ts` — Plate solving via Astrometry.net (WCS solution, RA/Dec, plate scale)
   - `services/nasa.ts` — NASA NeoWs for near-Earth objects within 0.1 AU
   - `services/cobs.ts` — Comet observation data with offline fallback database
   - `services/horizons.ts` — JPL Horizons precise ephemeris
3. **Semantic Analysis** — Gemini 3 Pro streaming analysis integrating all API results
4. **Finalization** — Results aggregated and displayed in dashboard

### Key Design Decisions

- **CORS proxy**: All external APIs are accessed through `corsproxy.io` to bypass browser CORS
- **Graceful degradation**: If plate solving fails, falls back to visual-only identification via Gemini
- **Streaming**: Gemini responses are streamed for real-time thought log display
- **Gnomonic projection**: `gemini.ts` contains `projectWorldToPixel()` for mathematically accurate RA/Dec → pixel coordinate conversion
- **Offline comet database**: `cobs.ts` has hardcoded visibility windows (2020-2026) as API fallback
- **Flexible comet designation parsing**: Supports informal names ("neowise"), periodic numbers ("12P"), and official IAU designations ("C/2023 A3")

### Component Structure

- `App.tsx` — Main orchestrator, state management, processing pipeline
- `components/ImageUploader.tsx` — Drag-drop upload with comet targeting and date override
- `components/ProcessingOverlay.tsx` — Real-time progress with split image/log view
- `components/ResultsDashboard.tsx` — Comprehensive results display (largest component at ~46KB)
- `components/Header.tsx` — Sticky navigation header

### Services

- `services/gemini.ts` — Gemini 3 Pro vision analysis, vector illustration generation, coordinate math utilities
- `services/astrometry.ts` — Image downscaling + Astrometry.net plate solving with polling
- `services/nasa.ts` — NASA NeoWs near-Earth object lookup
- `services/cobs.ts` — COBS comet data + designation normalization + offline predictions
- `services/horizons.ts` — JPL Horizons ephemeris with observer location support

### Type System

All shared types are in `types.ts`: `Identification`, `PlateSolveMetadata`, `NeoObject`, `CometData`, `HorizonsData`, `IdentificationResult`, `ProcessingState`, `ThoughtLog`.

## Tech Stack

- React 19 + TypeScript 5.8 + Vite 6.2
- Tailwind CSS (CDN), Font Awesome 6.4 (CDN), EXIF.js (CDN)
- `@google/genai` 1.34.0 for Gemini API
- Dark theme (slate-900/950), Inter + JetBrains Mono fonts

## Environment

- `GEMINI_API_KEY` in `.env.local` — injected via Vite's `define` config
- Designed for deployment on Google AI Studio (checks `window.aistudio`)
- Path alias: `@` maps to project root
