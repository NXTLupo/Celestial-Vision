# Celestial Vision AI

**An autonomous, deterministic celestial object identification pipeline for astrophotography.**

Upload any astronomical image and the system identifies every object in the field — stars, galaxies, satellites, space debris, comets, near-Earth asteroids — by orchestrating ten authoritative astronomical databases in parallel, then verifying every numeric claim before producing a natural-language report. Designed so that hallucination is structurally impossible: large language models narrate the pipeline output but never identify objects themselves.

---

## Table of Contents

- [What It Does](#what-it-does)
- [Why This Architecture](#why-this-architecture)
- [Feature Matrix](#feature-matrix)
- [The Pipeline](#the-pipeline)
- [Data Sources & API Usage](#data-sources--api-usage)
- [Installation](#installation)
- [Architecture Notes](#architecture-notes)
- [Acknowledgments](#acknowledgments)
- [References & Citations](#references--citations)
- [License & Attribution](#license--attribution)

---

## What It Does

Given a single astrophotograph (JPEG, PNG, single-exposure or stacked), Celestial Vision AI will:

1. **Solve the field astrometrically** — convert pixel coordinates to celestial coordinates (RA/Dec) via Astrometry.net's plate-solving service
2. **Identify every known object** in the field — stars, galaxies, nebulae from catalog annotations
3. **Search for satellites and orbital debris** that crossed the field of view at observation time, using two independent propagators (SGP4 with CelesTrak TLEs + Project Pluto with historical TLEs) plus the IAU's SatChecker for verification
4. **Survey active comets** visible on the observation date via COBS Planner, then check each one's JPL Horizons ephemeris against the plate-solved field
5. **Cross-check near-Earth asteroids** via NASA's NeoWs service and resolve their precise positions through JPL Horizons
6. **Compare against historical photographic plates** from the APPLAUSE archive (dating back to 1880s) for transient detection — new objects, vanished objects, brightness changes, proper motion
7. **Detect linear streaks** in the image and correlate them with satellite passes (deterministic streak detector, separate from object identification)
8. **Generate a verified report** including an Instagram-ready caption, with every numeric claim traceable to an API response

---

## Why This Architecture

Most "AI astronomy" tools ask a vision model "what's in this image?" and let it answer. That produces confident hallucinations: fabricated catalog IDs, wrong distances, made-up magnitudes, satellite claims with no actual orbital evidence.

Celestial Vision AI inverts the relationship:

- **Deterministic services identify.** Astrometry.net, JPL Horizons, CelesTrak, COBS, NASA NeoWs, Project Pluto, and the IAU SatChecker do the actual identification. Their responses are recorded in a `FactSheet` — a structured block of verified numeric values.
- **The LLM narrates.** Google Gemini 3 Pro receives the image plus the FactSheet and is instructed to quote those values exactly. It never invents distances, magnitudes, RA/Dec coordinates, or identifications.
- **Post-generation verification.** A `verifyCaption()` function scans the generated text for numeric claims and cross-references each against the FactSheet. Mismatches are corrected before display.

The result is a system that can say "the comet was at magnitude 10.2 according to a Nov 26 observation by Stephen Getliffe in the COBS database" — with the entire chain of provenance preserved.

---

## Feature Matrix

| Capability | How |
|---|---|
| **Plate solving** | Astrometry.net public API (Nova) — star pattern matching against built-in indexes (Tycho-2, 2MASS, USNO-B1, Hipparcos) |
| **Star/galaxy identification** | Astrometry.net annotations + ESA GAIA DR3 cross-reference |
| **Satellite identification (4-tier)** | (1) Local SGP4 propagation using CelesTrak TLE catalog (~27,000 objects: active + debris + rocket bodies), (2) Project Pluto's `sat_code` with historical archived TLEs, (3) IAU SatChecker verification, (4) Motion-aware FOV crossing using sub-frame exposure for stacked images |
| **Comet detection** | COBS Planner API → JPL Horizons ephemeris → plate-solved FOV check. Deterministic injection: comets confirmed in-field become identifications without LLM involvement |
| **Comet magnitude** | Three-tier priority: COBS actual observations (ground truth) → JPL Horizons (H+G model) → computed estimate from absolute H + observer distance when sources disagree |
| **MPC designation handling** | Built-in unpacker for MPC packed format (`0003I` → `3I`, `CK25T010` → `C/2025 T1`) so COBS Planner IDs work with JPL Horizons |
| **Near-Earth asteroids** | NASA NeoWs date-window query → JPL Horizons ephemeris → FOV verification |
| **Historical plate comparison** | APPLAUSE TAP query (`plate-archive.org`) → top 3 overlapping plates fetched → Gemini vision diff for 5 anomaly types: new_object, vanished_object, variable, transient, proper_motion |
| **Streak detection** | Dedicated Gemini vision pass focused only on linear features, returning pixel coordinates. Stacked images are flagged to suppress satellite trail claims (stacking rejects transients) |
| **EXIF + watermark OCR** | EXIF.js extracts camera/date/GPS. Gemini pre-scan reads target name, location, and date from image watermarks |
| **Observer location** | EXIF GPS first; falls back to OpenStreetMap Nominatim geocoding of location text from watermark |
| **TLE epoch mismatch detection** | When TLEs are >7 days from observation date, the system flags SGP4 as unreliable and prefers Project Pluto's archived TLEs |
| **Anti-hallucination FactSheet** | Single source of truth for numeric values, injected into every Gemini prompt as locked context |
| **Post-generation fact-check** | Scans output for fabricated distances/magnitudes and corrects them against the FactSheet |
| **Instagram caption generator** | First-person voice with mandatory citations to data sources and government agencies |

---

## The Pipeline

```
                                  USER IMAGE
                                       │
                              ┌────────┴────────┐
                              │   STAGE 0       │
                              │  EXIF + PRE-    │
                              │   SCAN OCR      │  Gemini reads watermarks
                              └────────┬────────┘  EXIF.js extracts metadata
                                       │
                              ┌────────┴────────┐
                              │   STAGE 1       │
                              │   PARALLEL      │
                              └────────┬────────┘
                                       │
                ┌──────────────┬───────┼───────┬──────────────┐
                │              │       │       │              │
            Astrometry.net  NASA    COBS   Streak       (Conditional)
            plate solving   NeoWs   Planner  detector   User-target
                │              │       │       │              │
                ▼              ▼       ▼       ▼              ▼
              WCS/RA/Dec   NEO list  Visible Linear feat   Target ephem
              FOV/scale              comets  pixel coords  (Horizons)
                              │
                              ▼
                       ┌──────┴──────┐
                       │  STAGE 2    │
                       │ ENRICHMENT  │
                       └──────┬──────┘
                              │
            ┌─────────────────┼─────────────────┐
            │                 │                 │
       NEO ephemeris     Comet survey:     Satellite ID:
       (Horizons)        each visible      SGP4 propagation
       FOV check         comet → Horizons  on CelesTrak TLE
                         → FOV check       catalog (3 groups)
                              │                 │
                              ▼                 ▼
                                          ┌─────┴─────┐
                                          │ TLE epoch │
                                          │ mismatch? │
                                          └─────┬─────┘
                                                │ yes
                                                ▼
                                        Project Pluto query
                                        (archived TLEs) +
                                        SatChecker verify
                              │
                              ▼
                       ┌──────┴──────┐
                       │  STAGE 3    │
                       │  FACTSHEET  │  Verified numeric values
                       └──────┬──────┘  locked, source-attributed
                              │
                              ▼
                       ┌──────┴──────┐
                       │  STAGE 4    │
                       │   GEMINI    │  Streaming analysis,
                       │  ANALYSIS   │  FactSheet injected
                       └──────┬──────┘  as locked context
                              │
                              ▼
                       ┌──────┴──────┐
                       │  STAGE 5    │
                       │ DETERMINISTIC│ Satellites + comets
                       │  INJECTION  │ → identifications
                       └──────┬──────┘  (bypasses LLM)
                              │
                              ▼
                       ┌──────┴──────┐
                       │  STAGE 6    │
                       │  RESOLVER   │  Re-check unresolved
                       │             │  against all databases
                       └──────┬──────┘
                              │
                              ▼
                       ┌──────┴──────┐
                       │  STAGE 7    │  Compare modern image
                       │  APPLAUSE   │  to historical plates
                       │  ARCHIVAL   │  for 5 anomaly types
                       └──────┬──────┘
                              │
                              ▼
                       ┌──────┴──────┐
                       │  STAGE 8    │  Scan generated text
                       │  FACT-CHECK │  for fabricated values,
                       │             │  correct from FactSheet
                       └──────┬──────┘
                              │
                              ▼
                          RESULTS UI
                       (Catalog + map +
                        Instagram caption +
                        APPLAUSE diff)
```

---

## Data Sources & API Usage

### Plate Solving

#### Astrometry.net (Nova) — `nova.astrometry.net`
The foundation of the entire pipeline. Star pattern matching against pre-built indexes produces a World Coordinate System solution: field-center RA/Dec, plate scale, rotation, parity, FOV, and catalog annotations.

- **Endpoints used:** `/api/login`, `/api/upload`, `/api/submissions/{id}`, `/api/jobs/{id}/calibration`, `/api/jobs/{id}/info`, `/api/jobs/{id}/annotations`, `/annotated_display/{id}`
- **Maintainer:** Dustin Lang, Keir Mierle, Sam Roweis, David W. Hogg (University of Toronto / NYU / Princeton)
- **Citation:** Lang, D., Hogg, D. W., Mierle, K., Blanton, M., & Roweis, S. (2010). "Astrometry.net: Blind Astrometric Calibration of Arbitrary Astronomical Images." *The Astronomical Journal*, 139(5), 1782–1800. doi:10.1088/0004-6256/139/5/1782
- **License:** Free service; commercial use of API requires `allow_commercial_use=y` parameter

### Satellite Identification

#### CelesTrak — `celestrak.org`
Source of Two-Line Element (TLE) orbital data. The TLE catalog is fed into the satellite.js SGP4 propagator to project each object's position at the observation time.

- **Catalogs fetched:** `GROUP=active`, `NAME=DEB`, `NAME=R/B` (~27,000 objects total)
- **Maintainer:** Dr. T.S. Kelso
- **Underlying data source:** U.S. Space Force 18th Space Defense Squadron (18 SDS), distributed via Space-Track.org
- **Citation:** Kelso, T.S. "CelesTrak." Online database. Available at https://celestrak.org

#### Project Pluto (sat_code / sat_id3) — `projectpluto.com/cgi-bin/sat_id/sat_id3`
Bill Gray's `sat_code` library, the authoritative source for satellite identification because it uses **archived historical TLEs** from the observation epoch — not current TLEs which drift quickly for debris. Same algorithm used by professional asteroid surveyors to reject satellite false positives.

- **Maintainer:** Bill Gray (Project Pluto)
- **Source code:** https://github.com/Bill-Gray/sat_code
- **Reference:** https://projectpluto.com/sat_id.htm

#### IAU CPS SatChecker — `satchecker.cps.iau.org`
Verification service for satellite ephemerides, run by the International Astronomical Union's Centre for the Protection of Dark and Quiet Skies from Satellite Constellation Interference (CPS).

- **Operator:** IAU Centre for the Protection of Dark and Quiet Skies (CPS)
- **Reference:** https://cps.iau.org/

#### satellite.js (local SGP4) — npm package `satellite.js`
JavaScript port of NORAD's Simplified General Perturbations model used for orbital propagation.

- **Maintainer:** Shashwat Kandadai et al.
- **Source:** https://github.com/shashwatak/satellite-js
- **Algorithmic source:** Vallado, D., Crawford, P., Hujsak, R., & Kelso, T.S. (2006). "Revisiting Spacetrack Report #3." *AIAA/AAS Astrodynamics Specialist Conference*.

### Near-Earth Objects

#### NASA NeoWs — `api.nasa.gov/neo/rest/v1/feed`
Near-Earth Object Web Service from NASA JPL. Returns objects making close approaches within a date window.

- **Operator:** NASA Jet Propulsion Laboratory, California Institute of Technology
- **Underlying data:** JPL Small-Body Database
- **API documentation:** https://api.nasa.gov/ → "Asteroids NeoWs"
- **Citation:** NASA/JPL-Caltech, Center for Near-Earth Object Studies (CNEOS)

### Solar System Ephemeris

#### JPL Horizons — `ssd.jpl.nasa.gov/api/horizons.api`
NASA's authoritative ephemeris computation service. Used for high-precision positions of comets and NEOs at the observation time and observer location.

- **Operator:** NASA Jet Propulsion Laboratory, Solar System Dynamics Group
- **Reference:** Giorgini, J.D., Yeomans, D.K., Chamberlin, A.B., et al. (1996). "JPL's On-Line Solar System Data Service." *Bulletin of the American Astronomical Society*, 28(3), 1158.
- **Web interface:** https://ssd.jpl.nasa.gov/horizons/

### Comets

#### Comet Observation Database (COBS) — `cobs.si`
Visual observations of comets reported by amateur astronomers worldwide, plus a Planner API listing comets visible on a given date and location.

- **Endpoints used:**
  - `/api/planner.api` — visible comets for a date+location
  - `/api/comet.api` — orbit and physical parameters for a single comet
  - `/api/obs_list.api` — visual magnitude reports from observers
- **Operator:** Crni Vrh Observatory, Slovenia
- **API documentation:** https://cobs.si/help/cobs_api/
- **Reference:** Zakrajsek, J. & Mikuz, H. "COBS: Comet OBServation database." Comet's Tale, 2014.

### Historical Photographic Plates

#### APPLAUSE — `www.plate-archive.org`
Archives of Photographic PLates for Astronomical USE. Digitized historical photographic plates from European observatories, primarily Bamberg, Hamburg, Potsdam, and Tartu, spanning roughly 1880–1990.

- **Endpoints used:** TAP/PostgreSQL query at `/tap/sync`, plate previews at `/files/`
- **Operator:** Leibniz Institute for Astrophysics Potsdam (AIP), in collaboration with Dr. Karl Remeis-Sternwarte Bamberg (Friedrich-Alexander-University Erlangen-Nürnberg), Hamburg Observatory, and Tartu Observatory
- **Funding:** Deutsche Forschungsgemeinschaft (DFG)
- **Citation:** Tuvikene, T., Edelmann, H., Groote, D., et al. (2014). "APPLAUSE — Archives of Photographic Plates for Astronomical USE." *Acta Polytechnica CTU Proceedings*, 2(2), 137–140. doi:10.14311/APP.2014.02.0137
- **Reference:** https://www.plate-archive.org/applause/
- **Query library inspiration:** https://github.com/lupinix/applausequery
- **Plate analysis methodology:** https://github.com/cuernodegazpacho/plateanalysis

### AI / Language Model

#### Google Gemini 3 Pro — `@google/genai` SDK
Vision-capable large language model used for narration only (not identification). Streamed responses provide real-time thought log during analysis. Five distinct calls per image: pre-scan, streak detection, main analysis, Instagram caption generation, APPLAUSE archival diff.

- **Operator:** Google DeepMind / Google AI Studio
- **Documentation:** https://ai.google.dev/

### Reference Star Catalogs (via Astrometry.net)

#### ESA Gaia (Data Release 3)
Reference astrometric catalog used by Astrometry.net for high-precision star positions.

- **Mission:** European Space Agency, Gaia
- **Citation:** Gaia Collaboration, Vallenari, A., Brown, A.G.A., et al. (2023). "Gaia Data Release 3: Summary of the content and survey properties." *Astronomy & Astrophysics*, 674, A1. doi:10.1051/0004-6361/202243940
- **Acknowledgment:** This work has made use of data from the European Space Agency (ESA) mission Gaia (https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium).

#### Other catalogs used internally by Astrometry.net indexes
- **Tycho-2 Catalogue** — ESA Hipparcos mission (Høg, E., et al. 2000)
- **2MASS** (Two Micron All-Sky Survey) — University of Massachusetts / IPAC
- **USNO-B1.0** — United States Naval Observatory
- **Hipparcos Catalogue** — European Space Agency
- **NOMAD** — United States Naval Observatory
- **NGC/IC** — New General Catalogue / Index Catalogue of deep-sky objects

### Geocoding

#### OpenStreetMap Nominatim — `nominatim.openstreetmap.org`
Used when GPS coordinates are absent from EXIF but a location name appears in the image watermark.

- **Operator:** OpenStreetMap Foundation
- **License:** Open Database License (ODbL)
- **Usage policy:** https://operations.osmfoundation.org/policies/nominatim/

### CORS Proxy

#### corsproxy.io
Fallback proxy used when the Vite dev proxy is unavailable (e.g., CelesTrak rate-limiting, Project Pluto network errors).

- **Operator:** corsproxy.io

### Front-end Libraries

| Library | Purpose | License |
|---|---|---|
| **React 19** | UI framework | MIT |
| **TypeScript 5.8** | Type system | Apache 2.0 |
| **Vite 6** | Build tool / dev server | MIT |
| **Tailwind CSS** (CDN) | Styling | MIT |
| **Font Awesome 6.4** (CDN) | Icons | Font Awesome Free License |
| **EXIF.js** (CDN) | EXIF metadata extraction | MIT |
| **satellite.js** | SGP4 orbital propagation | MIT |
| **@google/genai** | Gemini API client | Apache 2.0 |
| **instagram-publisher** | Instagram posting | MIT |

---

## Installation

**Prerequisites:** Node.js 18+, npm

```bash
git clone https://github.com/NXTLupo/astro_id.git
cd astro_id
npm install
cp .env.example .env.local
# Edit .env.local and add your API keys
npm run dev
```

### Required API Keys

Edit `.env.local` with the following values:

```env
GEMINI_API_KEY=        # Free at https://aistudio.google.com/app/apikey
ASTROMETRY_API_KEY=    # Free at https://nova.astrometry.net/api_help
APPLAUSE_TOKEN=        # Request at https://www.plate-archive.org/
```

`.env.local` is gitignored. Never commit credentials.

### Running

```bash
npm run dev       # Dev server on http://localhost:4200
npm run build     # Production build to dist/
npm run preview   # Preview production build
```

---

## Architecture Notes

### The FactSheet Pattern
The single most important architectural decision in this codebase. After all deterministic services run, their numeric outputs are consolidated into a `FactSheet` object: target name, distance, magnitude (with source attribution), RA/Dec, FOV, exposure type, observation date, satellite/streak/NEO counts, and identified-object list. This block is injected as locked context into every Gemini prompt with the instruction: "Every numeric claim in your output MUST come from FACT_SHEET above. Never invent distances, magnitudes, or counts."

### Magnitude Resolution Priority
Comet magnitudes from automated sources are notoriously unreliable for active objects:

1. **COBS actual observations** (ground truth from visual observers) — used if available
2. **JPL Horizons** (H+G model, distance-corrected but ignores cometary activity) — used if Planner and Horizons agree within 3 mag
3. **Computed estimate** — when Planner and Horizons disagree by >3 mag (typical for unusual objects like 3I/ATLAS), compute apparent magnitude from absolute H + observer distance using `m = H + 5·log₁₀(Δ) + 10·log₁₀(r)`

### Streak Detection vs Satellite Identification
These run independently. A satellite "overhead" at observation time does not mean its trail is visible in the image — stacked images actively reject transients during integration. The streak detector is the ground truth for visibility. Satellites from SGP4/Pluto without a matching detected streak are recorded as context but never reported as visible in the image.

### TLE Epoch Mismatch
Current TLEs degrade rapidly for orbital prediction backwards in time. When the catalog is >7 days from the observation date, debris positions can be off by degrees. The pipeline detects this and prefers Project Pluto's archived historical TLEs over local SGP4.

### MPC Designation Unpacking
COBS Planner returns comet IDs in MPC packed format (`0003I`, `CK25T010`) which JPL Horizons rejects. A built-in unpacker converts to standard IAU format (`3I`, `C/2025 T1`).

---

## Acknowledgments

This project would not exist without the decades of public investment in open astronomical data and software. In particular:

- **NASA / JPL / Caltech** for Horizons, NeoWs, and the Small-Body Database
- **U.S. Space Force / 18th Space Defense Squadron** for the public satellite catalog
- **European Space Agency** for the Gaia mission and Hipparcos/Tycho catalogues
- **International Astronomical Union** for the SatChecker service and its work protecting dark and quiet skies
- **Dr. T.S. Kelso** for CelesTrak — over 35 years of free public access to satellite orbital elements
- **Bill Gray** for Project Pluto's `sat_code`, which sets the gold standard for satellite identification
- **Dustin Lang, Keir Mierle, Sam Roweis, and David W. Hogg** for Astrometry.net — making blind plate solving universally available
- **The COBS team and amateur comet observers worldwide** — without their visual reports, the magnitude of an active comet would remain a guess
- **The APPLAUSE project, AIP, and partner observatories** for digitizing over a century of photographic plates
- **The Crni Vrh Observatory team** for maintaining the COBS database
- **OpenStreetMap contributors** for the Nominatim geocoding service
- **Google DeepMind / Google AI Studio** for the Gemini 3 Pro model

---

## References & Citations

### Foundational Papers
- Lang, D., Hogg, D. W., Mierle, K., Blanton, M., & Roweis, S. (2010). "Astrometry.net: Blind Astrometric Calibration of Arbitrary Astronomical Images." *The Astronomical Journal*, 139(5), 1782–1800. doi:10.1088/0004-6256/139/5/1782
- Vallado, D., Crawford, P., Hujsak, R., & Kelso, T.S. (2006). "Revisiting Spacetrack Report #3." *AIAA/AAS Astrodynamics Specialist Conference*.
- Giorgini, J.D., Yeomans, D.K., Chamberlin, A.B., et al. (1996). "JPL's On-Line Solar System Data Service." *Bulletin of the American Astronomical Society*, 28(3), 1158.
- Gaia Collaboration, Vallenari, A., Brown, A.G.A., et al. (2023). "Gaia Data Release 3: Summary of the content and survey properties." *Astronomy & Astrophysics*, 674, A1. doi:10.1051/0004-6361/202243940
- Høg, E., Fabricius, C., Makarov, V.V., et al. (2000). "The Tycho-2 Catalogue of the 2.5 Million Brightest Stars." *Astronomy & Astrophysics*, 355, L27–L30.
- Skrutskie, M.F., Cutri, R.M., Stiening, R., et al. (2006). "The Two Micron All Sky Survey (2MASS)." *The Astronomical Journal*, 131(2), 1163–1183.
- Tuvikene, T., Edelmann, H., Groote, D., et al. (2014). "APPLAUSE — Archives of Photographic Plates for Astronomical USE." *Acta Polytechnica CTU Proceedings*, 2(2), 137–140. doi:10.14311/APP.2014.02.0137

### Transient Detection Methodology
- VASCO project (Vanishing & Appearing Sources during a Century of Observations) methodology informs the bidirectional anomaly detection in APPLAUSE cross-analysis.

### Data Source URLs
- Astrometry.net: https://nova.astrometry.net
- CelesTrak: https://celestrak.org
- Project Pluto: https://projectpluto.com
- IAU CPS SatChecker: https://satchecker.cps.iau.org
- NASA NeoWs: https://api.nasa.gov
- JPL Horizons: https://ssd.jpl.nasa.gov/horizons/
- COBS: https://cobs.si
- APPLAUSE: https://www.plate-archive.org
- ESA Gaia: https://www.cosmos.esa.int/gaia
- OpenStreetMap Nominatim: https://nominatim.openstreetmap.org

---

## License & Attribution

This software is provided as-is for research and personal astrophotography use. When sharing identification reports, please retain attribution to the underlying data sources. The Instagram caption generator does this automatically.

If you publish scientific work using this tool, cite the underlying data sources directly — not this repository — since the actual identification is performed by the upstream services listed above.

The hardcoded API keys in earlier commits of this repository were scrubbed via `git-filter-repo` before public release. The current source requires all API keys to be provided via `.env.local`.

---

*"Deterministic services identify. The LLM narrates. Every numeric claim traces to an API response."*
