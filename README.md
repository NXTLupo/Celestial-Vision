# Celestial Vision AI

A web application that takes an astronomical image and runs it through several public astronomy databases and APIs to return identified objects, ephemeris data, and a natural-language summary.

## Overview

The app accepts an image (JPEG or PNG, single-exposure or stacked) and orchestrates queries to:

- Astrometry.net (plate solving)
- NASA NeoWs (near-Earth objects)
- JPL Horizons (ephemeris)
- COBS (comet observations and visibility planner)
- CelesTrak (satellite TLEs)
- Project Pluto sat_code (satellite identification with archived TLEs)
- IAU CPS SatChecker (satellite verification)
- APPLAUSE (historical photographic plates)
- OpenStreetMap Nominatim (geocoding)

Results from the deterministic services are consolidated and passed to Google Gemini, which generates the human-readable report.

## Pipeline

1. **EXIF + pre-scan.** EXIF.js extracts camera, date, GPS, and exposure. A Gemini call reads watermarks for target name, date, and location text.
2. **Parallel stage.** Astrometry.net plate solving, NASA NeoWs date-window query, COBS Planner visibility query, and streak detection run concurrently.
3. **Enrichment.** Visible comets from COBS Planner are resolved through JPL Horizons and FOV-checked against the plate-solved field. NEOs are also resolved through Horizons. The TLE catalog is propagated via SGP4. When the TLE epoch is more than seven days from the observation date, Project Pluto is queried for archived TLEs and SatChecker verifies candidates.
4. **FactSheet.** Verified numeric values from the above are collected into a structured block with source attribution.
5. **Analysis.** The FactSheet plus the image are sent to Gemini 3 Pro for the main analysis pass. The output is streamed.
6. **Deterministic injection.** Comets confirmed in the plate-solved FOV and satellites matched to detected streaks are added to the identification list without depending on the model.
7. **Resolver.** Unresolved objects are re-checked against the same databases.
8. **APPLAUSE.** If overlapping historical plates exist, up to three are fetched and a vision diff is run for transient indicators (new objects, vanished objects, variability, proper motion).
9. **Post-generation check.** The generated text is scanned for numeric claims and compared against the FactSheet.

## Data Sources

### Plate Solving
**Astrometry.net** — `nova.astrometry.net`
Star pattern matching service maintained by Dustin Lang and collaborators.
Reference: Lang, D., Hogg, D.W., Mierle, K., Blanton, M., Roweis, S. (2010). "Astrometry.net: Blind Astrometric Calibration of Arbitrary Astronomical Images." *The Astronomical Journal*, 139(5), 1782–1800.

### Satellites
**CelesTrak** — `celestrak.org`
Two-Line Element (TLE) catalog maintained by Dr. T.S. Kelso. Source data is the public catalog from the U.S. Space Force 18th Space Defense Squadron.

**Project Pluto sat_code** — `projectpluto.com`
Satellite identification using archived historical TLEs. Maintained by Bill Gray. Source code at https://github.com/Bill-Gray/sat_code.

**IAU CPS SatChecker** — `satchecker.cps.iau.org`
Verification service operated by the International Astronomical Union's Centre for the Protection of Dark and Quiet Skies from Satellite Constellation Interference (CPS).

**satellite.js**
JavaScript SGP4 propagator. Algorithm reference: Vallado, D., Crawford, P., Hujsak, R., Kelso, T.S. (2006). "Revisiting Spacetrack Report #3." AIAA/AAS Astrodynamics Specialist Conference.

### Solar System Bodies
**NASA NeoWs** — `api.nasa.gov`
Near-Earth Object Web Service operated by NASA JPL / Caltech, drawing on the JPL Small-Body Database.

**JPL Horizons** — `ssd.jpl.nasa.gov`
Solar System ephemeris service from the NASA JPL Solar System Dynamics group.
Reference: Giorgini, J.D., Yeomans, D.K., Chamberlin, A.B., et al. (1996). "JPL's On-Line Solar System Data Service." *Bulletin of the American Astronomical Society*, 28(3), 1158.

### Comets
**COBS (Comet OBServation Database)** — `cobs.si`
Visual observations from amateur observers, plus a Planner API for visibility predictions. Operated by Crni Vrh Observatory, Slovenia. API documentation at https://cobs.si/help/cobs_api/.

### Historical Plates
**APPLAUSE** (Archives of Photographic PLates for Astronomical USE) — `plate-archive.org`
Digitized historical plates from Bamberg, Hamburg, Potsdam, and Tartu observatories, hosted by the Leibniz Institute for Astrophysics Potsdam (AIP).
Reference: Tuvikene, T., Edelmann, H., Groote, D., et al. (2014). "APPLAUSE — Archives of Photographic Plates for Astronomical USE." *Acta Polytechnica CTU Proceedings*, 2(2), 137–140.

### Reference Catalogs (used internally by Astrometry.net)
- ESA Gaia DR3 — Gaia Collaboration, Vallenari, A., Brown, A.G.A., et al. (2023). *A&A*, 674, A1.
- Tycho-2 — Høg, E., et al. (2000). *A&A*, 355, L27.
- 2MASS — Skrutskie, M.F., et al. (2006). *AJ*, 131(2), 1163.
- USNO-B1.0, Hipparcos, NOMAD, NGC/IC.

### AI Model
**Google Gemini 3 Pro** via the `@google/genai` SDK. Used for image-aware text generation. Documentation at https://ai.google.dev/.

### Geocoding
**OpenStreetMap Nominatim** — `nominatim.openstreetmap.org`
Used when GPS is absent from EXIF and a location name is read from a watermark. Subject to the OSMF Nominatim usage policy.

## Installation

Prerequisites: Node.js 18+ and npm.

```bash
git clone https://github.com/NXTLupo/astro_id.git
cd astro_id
npm install
cp .env.example .env.local
# Fill in API keys in .env.local
npm run dev
```

### Required Environment Variables

In `.env.local`:

```
GEMINI_API_KEY=        # https://aistudio.google.com/app/apikey
ASTROMETRY_API_KEY=    # https://nova.astrometry.net/api_help
APPLAUSE_TOKEN=        # request access at https://www.plate-archive.org/
```

`.env.local` is gitignored.

### Commands

```
npm run dev       # Dev server on http://localhost:4200
npm run build     # Production build to dist/
npm run preview   # Preview production build
```

## Architecture Notes

**FactSheet pattern.** Numeric values from the deterministic services (RA/Dec, FOV, magnitudes, distances, counts) are collected into a single structured object with source attribution. This object is included in the Gemini prompt as context, and the model is asked to quote values from it rather than generating new ones. A post-generation pass compares numeric claims in the output against the FactSheet.

**Magnitude resolution.** For comets, recent COBS visual observations are preferred when available. If only COBS Planner and JPL Horizons values are available and they disagree by more than three magnitudes (which can happen for unusual objects where one source reports absolute magnitude H rather than apparent), an estimate is computed from `m = H + 5·log₁₀(Δ) + 10·log₁₀(r)` using the Horizons observer distance.

**TLE epoch handling.** Current TLEs lose accuracy when propagated to dates well before their epoch. The pipeline flags this and, when the gap is large, prefers Project Pluto's archived TLEs.

**Streak detection is independent of satellite identification.** A satellite being above the horizon at observation time is not the same as a trail being visible in the image; stacked images reject transients during integration. The streak detector results determine whether identified satellites are reported as visible or as overhead context only.

**MPC packed designations.** COBS Planner returns comet IDs in MPC packed format (`0003I`, `CK25T010`); a helper unpacks these to the standard form (`3I`, `C/2025 T1`) accepted by JPL Horizons.

## Acknowledgments

- NASA / JPL / Caltech for Horizons, NeoWs, and the Small-Body Database
- U.S. Space Force 18th Space Defense Squadron for the public satellite catalog
- European Space Agency for the Gaia mission and Hipparcos/Tycho catalogues
- The International Astronomical Union and CPS for SatChecker
- Dr. T.S. Kelso for CelesTrak
- Bill Gray for Project Pluto and sat_code
- Dustin Lang and the Astrometry.net team
- The COBS team and the amateur comet observation community
- The APPLAUSE consortium and the AIP, Bamberg, Hamburg, Potsdam, and Tartu observatories
- OpenStreetMap contributors for Nominatim
- Google DeepMind for the Gemini model

## License and Attribution

When using identification results in published or shared material, please credit the underlying data sources. The generated Instagram caption includes attribution automatically.

If results are used in scientific work, cite the upstream data sources directly rather than this repository.
