# Architecture

This document describes the design of the identification pipeline and the conventions used in the code. For installation and contributing, see `README.md` and `CONTRIBUTING.md`.

## Design Goal

Identify objects in an astronomical image by querying authoritative public databases, then produce a natural-language summary whose numeric claims can be traced back to those database responses. Identification decisions are made by the deterministic services. The language model is used to summarize and narrate, not to identify objects from the image alone.

## Pipeline

The pipeline runs in `App.tsx` and executes in roughly nine stages. Many stages run in parallel.

```
USER IMAGE
   │
   ▼
[1] EXIF + pre-scan          Read metadata from the file. A vision pass
                              reads watermarks and text overlays for target
                              name, date, and location.
   │
   ▼
[2] Parallel stage           Astrometry.net plate solving, NASA NeoWs
                              date-window query, COBS Planner visibility
                              query, and streak detection run concurrently.
   │
   ▼
[3] Enrichment               Visible comets from COBS Planner are resolved
                              through JPL Horizons and FOV-checked against
                              the plate-solved field. NEOs are also resolved
                              through Horizons. The TLE catalog is propagated
                              via SGP4. When the TLE epoch is more than
                              seven days from the observation date, Project
                              Pluto is queried for archived TLEs and
                              SatChecker verifies candidates.
   │
   ▼
[4] FactSheet                Verified numeric values from the above are
                              collected into a structured object with source
                              attribution.
   │
   ▼
[5] Analysis                 The FactSheet plus the image are sent to the
                              language model for the main analysis pass.
                              Output is streamed for real-time display.
   │
   ▼
[6] Deterministic injection  Comets confirmed in the plate-solved FOV and
                              satellites matched to detected streaks are
                              added to the identification list directly,
                              without passing through the language model.
   │
   ▼
[7] Resolver                 Objects the language model could not identify
                              are re-checked against the same databases.
   │
   ▼
[8] APPLAUSE                 If overlapping historical plates exist, up to
                              three are fetched and a vision diff produces
                              transient indicators.
   │
   ▼
[9] Post-generation check    The generated text is scanned for numeric
                              claims and compared against the FactSheet.
   │
   ▼
RESULTS
```

## The FactSheet Pattern

The FactSheet is a structured object built after the deterministic services complete. It contains:

- Target name (if specified or detected)
- Plate-solve center RA/Dec, FOV, constellation
- Distance and magnitude with source attribution (`COBS observed`, `JPL predicted`, `computed`, etc.)
- Exposure information (single vs stacked, total integration time)
- Counts: satellites overhead, NEOs in field, streaks detected
- Identified objects list

The FactSheet is included as locked context in every prompt sent to the language model with the instruction to quote values from it rather than generate new ones. The post-generation check scans the generated text for numeric claims and compares them against the FactSheet, replacing mismatches.

This pattern is intended to keep the language model's role bounded. It can still produce text that is structurally wrong (omitting context, drawing the wrong conclusion from a number), but it should not produce numbers that aren't in the FactSheet.

## Magnitude Resolution

Comet magnitudes from automated sources are unreliable for active objects. The pipeline resolves magnitude in this order:

1. **COBS visual observations.** Visual estimates submitted by observers via the COBS observation list API. Treated as ground truth when available.
2. **JPL Horizons** (when the COBS Planner agrees within three magnitudes). Uses the H+G photometric model. Reasonable for inactive objects, often wrong for active comets.
3. **Computed estimate** (when COBS Planner and Horizons disagree by more than three magnitudes). When this happens, one of the sources is likely returning the absolute magnitude H rather than apparent magnitude. The estimate uses the standard cometary formula:

   ```
   m = H + 5·log10(Δ) + 10·log10(r)
   ```

   where `Δ` is the Earth distance (from Horizons) and `r` is approximated as `Δ` when heliocentric distance is unavailable. The result is logged as `computed (H+distance)` so downstream consumers know it is an estimate rather than a measurement.

## Satellite Identification

Four layers, used in order of preference:

1. **Local SGP4 propagation** (`services/satellites.ts`) using TLEs from CelesTrak (active + debris + rocket bodies, ~27,000 objects). Fast and runs without external requests after the catalog is cached.
2. **Project Pluto's sat_code** (`services/pluto.ts`). Queried when SGP4 is unreliable. Uses archived historical TLEs that match the observation epoch rather than current TLEs.
3. **IAU CPS SatChecker** (`services/satchecker.ts`). Used either as a verification step after SGP4 finds candidates, or as a primary search when SGP4 returns no candidates. A result is only treated as verified when `inFov === true`; positions reported for objects outside the FOV are informational.
4. **Streak correlation.** Independently, a streak detector identifies linear features in the image. The dashboard reports a satellite as visible only when both an orbital match and a matching streak are present. A satellite that was overhead at observation time but produced no detectable streak is recorded as overhead context, not as visible in the image.

### TLE Epoch Handling

Current TLEs lose accuracy when propagated backwards in time. When the gap between the catalog's epoch and the observation date exceeds about seven days, the system flags SGP4 as unreliable for debris and low-orbit objects. Project Pluto's archived TLEs are then preferred.

## Comet Identification

1. COBS Planner returns a list of comets visible on the observation date and location.
2. For each, the MPC packed designation is unpacked to the standard form (`0003I` → `3I`, `CK25T010` → `C/2025 T1`).
3. JPL Horizons returns the precise RA/Dec at the observation time.
4. The position is checked against the plate-solved FOV.
5. Comets confirmed in the FOV are added to identifications with confidence based on whether plate solving succeeded (`wcs_confirmed`) or only ephemeris is available (`ephemeris_only`).

Without a plate-solved field, no claim is made about whether a comet is in the image. The visibility-on-date information is still passed to the language model as context.

## Historical Plate Comparison

The APPLAUSE archive is queried via a TAP/PostgreSQL endpoint for plates whose recorded RA/Dec overlaps the plate-solved field. Up to three matching plates are fetched with preview images. A vision pass compares the modern image against each historical plate and produces an anomaly report with five categories:

- `new_object` — source visible in modern image, absent from plate
- `vanished_object` — source visible on plate, absent from modern image
- `variable` — same source, significantly different brightness
- `transient` — visible in one epoch only
- `proper_motion` — apparent position shifted

Pre-1957 plates have modern satellite trails auto-downgraded to low significance because such trails could not have existed on those plates.

This step is the only part of the pipeline where identification depends on a vision model rather than catalog data. Its results should be treated as candidates for follow-up rather than confirmed detections.

## CORS Proxying

Most of the external services do not send permissive CORS headers. The Vite dev server proxies these via the entries in `vite.config.ts`:

| Route | Target |
|---|---|
| `/proxy/astrometry/*` | https://nova.astrometry.net |
| `/proxy/cobs/*` | https://cobs.si |
| `/proxy/horizons/*` | https://ssd.jpl.nasa.gov |
| `/proxy/celestrak/*` | https://celestrak.org |
| `/proxy/satchecker/*` | https://satchecker.cps.iau.org |
| `/proxy/pluto/*` | https://projectpluto.com |

A `corsproxy.io` fallback is used when the Vite proxy is unavailable (e.g., CelesTrak rate-limiting).

## Server Middleware

Two endpoints run as Vite middleware (`server/`) because they require server-side credentials or browser-unsafe libraries:

- `instagramApi.ts` — server-side Instagram publishing using `instagram-publisher`. Credentials are sent in the request body and never persisted.
- `applauseApi.ts` — APPLAUSE TAP query plus a preview-image scraper. The APPLAUSE token lives in `.env.local` and is read at server start, never sent to the browser.

## Known Limitations

- **Streak detection is vision-based.** A separate prompt is used and validated against pixel-coordinate bounds, but the detector can miss faint streaks or produce coordinates slightly off.
- **APPLAUSE diff is vision-based.** The anomaly classifier is not deterministic. False positives and false negatives are expected.
- **Astrometry.net failures.** When plate solving fails (low star count, noise, queue timeouts), the pipeline cannot perform FOV-based checks. Comets and NEOs are not asserted as in-field in that case.
- **TLE catalog completeness.** CelesTrak covers most public catalog entries. Maneuvering satellites or recently launched objects may not yet appear.
- **COBS Planner magnitudes for unusual objects.** The Planner API sometimes returns absolute H rather than apparent magnitude for interstellar comets and other special cases. The magnitude waterfall handles this when Horizons disagrees significantly; otherwise the Planner value is reported with its source attribution.

## File Layout

```
App.tsx                  Pipeline orchestration. Runs each stage and
                         assembles the FactSheet and identification list.
types.ts                 Cross-cutting interfaces.

services/
  astrometry.ts          Astrometry.net plate solving.
  nasa.ts                NASA NeoWs and Horizons-based NEO enrichment.
  horizons.ts            JPL Horizons ephemeris queries with CSV parsing.
  cobs.ts                COBS comet, planner, and observation queries.
                         Includes MPC packed designation unpacker.
  satellites.ts          CelesTrak TLE fetching, SGP4 propagation,
                         two-pass FOV scan, streak matching.
  satchecker.ts          IAU CPS SatChecker verification and primary search.
  pluto.ts               Project Pluto sat_code query and response parser.
  applause.ts            APPLAUSE plate discovery via TAP.
  resolver.ts            Final pass that re-checks unresolved objects
                         against every database.
  gemini.ts              Language model integration: pre-scan, streak
                         detection, main analysis, Instagram caption,
                         APPLAUSE diff, post-generation fact-check.

components/
  Header.tsx             Sticky navigation.
  ImageUploader.tsx      Drag-drop upload with target and date overrides.
  ProcessingOverlay.tsx  Real-time log display while pipeline runs.
  ResultsDashboard.tsx   Main results UI: catalog, map, citations, chat.
  ArchivalPlates.tsx     APPLAUSE plate previews and anomaly cards.
  HudVisuals.tsx         Decorative HUD overlays.
  InstagramPublisher.tsx Caption editor and publish flow.

server/
  applauseApi.ts         Vite middleware for APPLAUSE proxy + preview.
  instagramApi.ts        Vite middleware for Instagram posting.

utils/
  catalogMatch.ts        Helper functions for matching identifications
                         against catalogs.
```
