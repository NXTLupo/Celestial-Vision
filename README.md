# Celestial Vision AI

A web application that takes an astronomical image and runs it through several public astronomy databases and APIs to return identified objects, ephemeris data, and a natural-language summary.

## Demo

https://github.com/NXTLupo/astro_id/releases/download/v0.1.0-demo/celestial_vision.mp4

*If the video doesn't autoplay, [download it here](https://github.com/NXTLupo/astro_id/releases/download/v0.1.0-demo/celestial_vision.mp4).*

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

## Features

### Image Ingestion
Drag-and-drop or file-picker upload for JPEG and PNG. The uploader accepts an optional target name and an optional date override, both useful when EXIF data is missing or unreliable. EXIF.js extracts camera model, exposure, date, and GPS coordinates when present. For images with watermarks or text overlays (e.g., Seestar app exports with "Target / Date / Exposure" footers), a pre-scan pass reads the overlay and pulls out target, date, location, and exposure values.

### Plate Solving
Astrometry.net handles the WCS calibration. The image is downscaled to a maximum of 1800 pixels before upload to stay within the service's limits. Results returned: field-center RA and Dec, plate scale in arcseconds per pixel, field of view in degrees, parity, rotation, constellation, and a list of catalog annotations (named stars, NGC/IC galaxies, deep-sky objects) with their positions in the field.

### Satellite Identification
Three sources working together:

1. **Local SGP4 propagation** using TLEs fetched from CelesTrak. Three catalogs are pulled — active satellites, debris, and rocket bodies — for roughly 27,000 objects total. Each TLE is propagated to the observation time and checked against the plate-solved field. A motion-aware crossing check uses the sub-frame exposure for stacked images so a 300-second sub-exposure isn't mistakenly treated as a 30-minute integration.
2. **Project Pluto sat_code**, queried when the TLE epoch is more than seven days from the observation date. Project Pluto uses archived historical TLEs that match the observation epoch, which is necessary for accurate positions on older debris.
3. **IAU CPS SatChecker** for verification of SGP4 candidates and as a primary search when SGP4 returns nothing.

Satellites are reported as visible in the image only when both orbital prediction and the independent streak detector agree.

### Streak Detection
A dedicated vision pass identifies linear features in the image and returns their pixel coordinates, length, position angle, and brightness. Coordinates are validated against image bounds and minimum/maximum length before being accepted. Detected streaks are correlated with satellite candidates by direction and FOV crossing. Streaks without a matching satellite are reported as unresolved linear features rather than mislabeled as a specific satellite.

### Comet Identification
For every image, the pipeline queries COBS Planner for comets visible on the observation date and location. For each visible comet, JPL Horizons returns the precise RA and Dec at the observation time, and the result is checked against the plate-solved field. Comets confirmed inside the field are added to the identification list with their COBS-observed apparent magnitude when available, or a magnitude computed from the absolute H value plus the observer distance when COBS observations are sparse. MPC packed designations returned by COBS Planner (e.g. `0003I`, `CK25T010`) are unpacked to the standard form (`3I`, `C/2025 T1`) accepted by Horizons.

### Near-Earth Object Check
NASA NeoWs returns close-approach objects for the observation date window. For any object within 0.1 AU, JPL Horizons resolves the precise position at observation time and the pipeline checks whether it falls in the plate-solved field. NEOs in the field are listed with distance, RA/Dec, and visual magnitude when available.

### Catalog Registry Panel
The results dashboard shows every confirmed identification as a tile, grouped by object type. Stars and galaxies from the Astrometry.net annotation pass appear with their catalog names; satellites show NORAD ID and verification source; comets show designation and current apparent magnitude. Each tile shows the confidence and verification status (plate-solve confirmed, ephemeris only, or unresolved).

### Astrometry Overlay
The plate-solved image is rendered with vector annotations matching what Astrometry.net returned — named stars, NGC/IC galaxies, deep-sky objects, plus pixel markers for satellites and comets that the pipeline injected. Object names are rendered with a gnomonic projection from RA/Dec to pixel coordinates so they sit on the correct features rather than being approximated.

### Historical Plate Comparison (APPLAUSE Archive)
When plate solving succeeds, the system queries the APPLAUSE TAP service for digitized historical photographic plates whose recorded position overlaps the user's field of view. Up to three matching plates are fetched with preview images. Each plate is compared against the modern image and an anomaly report is produced covering five categories: new objects, vanished objects, variable brightness, transients visible in only one epoch, and proper motion. Plates predating 1957 have any "satellite trail" anomalies auto-downgraded since such trails would not be possible on those plates.

This comparison is vision-based rather than catalog-based, so results should be treated as candidates for follow-up rather than confirmed detections.

### Ask the Astronomer
A chat panel in the results dashboard for follow-up questions about the analyzed image. The chat is seeded with the full identification context — plate-solve details, object list, NEO matches, and the APPLAUSE anomaly report — so questions like "what is the streak in the upper right?" or "what's the distance to that NEO?" can be answered against the actual pipeline data rather than from general knowledge.

The astronomer's system prompt covers plate solving and WCS, multi-epoch transient analysis methodology, space debris characterization, Moffat PSF photometry, GAIA-based absolute calibration, and orbit estimation from angular velocity. Google Search is enabled as a tool so the astronomer can verify facts about specific objects when asked.

Conversation history is preserved within a session. Markdown formatting (bold object names, bullet lists) is rendered inline.

### Instagram Caption Generator
A separate panel generates an Instagram-ready caption from the identification results. The caption uses a fixed structure: opening hook, what was captured, what the pipeline found, a historical-plate paragraph if APPLAUSE data is available, and a citations paragraph naming the data sources used. The caption is generated in first person and constrained to 2,200 characters (Instagram's hard limit). Numeric values are taken verbatim from the FactSheet; if the post-generation check finds a numeric claim that doesn't match the FactSheet, it is corrected before display.

### Instagram Publisher
The caption can be sent directly to an Instagram account from the dashboard. Credentials are entered by the user, held in `localStorage` for convenience, and posted to the server-side middleware (`server/instagramApi.ts`) which uses the `instagram-publisher` library. Credentials are never persisted server-side; they live for the duration of the request.

### Real-Time Processing Log
While the pipeline runs, a split overlay shows the image on one side and a live log on the other. Each pipeline stage logs its progress: API calls, response sizes, satellite candidates, comet ephemeris results, FOV crossings, and the deterministic injections. Failures and warnings are color-coded. The full log is preserved with the results so it can be reviewed after analysis completes.

### Deterministic FactSheet
Every numeric value displayed in the dashboard or caption — distances, magnitudes, RA/Dec, FOV, object counts — comes from a `FactSheet` object assembled from API responses with explicit source attribution. The FactSheet is included as context in every generative prompt, and a post-generation pass compares numeric claims in the generated text against the FactSheet, correcting mismatches.

### Theme and HUD Layer
A "STARK" theme toggle inverts the dashboard between dark and light. A decorative HUD layer (wireframe globe, perspective grid, scanning waveforms) is rendered on canvas and reads from CSS custom properties so it adapts to the theme automatically.

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

Star pattern matching service maintained by Dustin Lang, Keir Mierle, Sam Roweis, and David W. Hogg (University of Toronto / NYU / Princeton).

> Lang, D., Hogg, D.W., Mierle, K., Blanton, M., & Roweis, S. (2010). "Astrometry.net: Blind Astrometric Calibration of Arbitrary Astronomical Images." *The Astronomical Journal*, 139(5), 1782–1800. doi:[10.1088/0004-6256/139/5/1782](https://doi.org/10.1088/0004-6256/139/5/1782)

### Satellites

**CelesTrak** — `celestrak.org`

Two-Line Element (TLE) catalog maintained by Dr. T.S. Kelso. Source data is the public catalog from the U.S. Space Force 18th Space Defense Squadron, distributed via Space-Track.org.

> Kelso, T.S. "CelesTrak." Online database. https://celestrak.org

**Project Pluto sat_code** — `projectpluto.com/cgi-bin/sat_id/sat_id3`

Satellite identification using archived historical TLEs. Maintained by Bill Gray.

> Gray, B. "sat_code." Source code: https://github.com/Bill-Gray/sat_code
> Reference page: https://projectpluto.com/sat_id.htm

**IAU CPS SatChecker** — `satchecker.cps.iau.org`

Verification service operated by the International Astronomical Union's Centre for the Protection of Dark and Quiet Skies from Satellite Constellation Interference (CPS). https://cps.iau.org/

**satellite.js**

JavaScript SGP4 propagator (npm package `satellite.js`).

> Vallado, D., Crawford, P., Hujsak, R., & Kelso, T.S. (2006). "Revisiting Spacetrack Report #3." *AIAA/AAS Astrodynamics Specialist Conference*.
> Source: https://github.com/shashwatak/satellite-js

### Solar System Bodies

**NASA NeoWs** — `api.nasa.gov/neo/rest/v1/feed`

Near-Earth Object Web Service operated by NASA Jet Propulsion Laboratory / Caltech, drawing on the JPL Small-Body Database and the Center for Near-Earth Object Studies (CNEOS). API documentation: https://api.nasa.gov/

**JPL Horizons** — `ssd.jpl.nasa.gov/api/horizons.api`

Solar System ephemeris computation service from the NASA JPL Solar System Dynamics group.

> Giorgini, J.D., Yeomans, D.K., Chamberlin, A.B., Chodas, P.W., Jacobson, R.A., Keesey, M.S., Lieske, J.H., Ostro, S.J., Standish, E.M., & Wimberly, R.N. (1996). "JPL's On-Line Solar System Data Service." *Bulletin of the American Astronomical Society*, 28(3), 1158.
> Web interface: https://ssd.jpl.nasa.gov/horizons/

### Comets

**COBS (Comet OBServation Database)** — `cobs.si`

Visual observations submitted by amateur observers worldwide, plus a Planner API for visibility predictions. Operated by Crni Vrh Observatory, Slovenia.

> Zakrajsek, J. & Mikuz, H. "COBS: Comet OBServation database." *The Comet's Tale*, 2014.
> API documentation: https://cobs.si/help/cobs_api/

### Historical Plates

**APPLAUSE** (Archives of Photographic PLates for Astronomical USE) — `plate-archive.org`

Digitized historical photographic plates from Bamberg, Hamburg, Potsdam, and Tartu observatories, spanning roughly 1880–1990. Hosted by the Leibniz Institute for Astrophysics Potsdam (AIP) in collaboration with Dr. Karl Remeis-Sternwarte Bamberg (Friedrich-Alexander-University Erlangen-Nürnberg), Hamburg Observatory, and Tartu Observatory. Funded by the Deutsche Forschungsgemeinschaft (DFG).

> Tuvikene, T., Edelmann, H., Groote, D., Enke, H., & Dick, W.R. (2014). "APPLAUSE — Archives of Photographic Plates for Astronomical USE." *Acta Polytechnica CTU Proceedings*, 2(2), 137–140. doi:[10.14311/APP.2014.02.0137](https://doi.org/10.14311/APP.2014.02.0137)
> Project page: https://www.plate-archive.org/applause/
> Query library inspiration: https://github.com/lupinix/applausequery
> Plate analysis methodology: https://github.com/cuernodegazpacho/plateanalysis

### Reference Catalogs

These catalogs are used internally by Astrometry.net's index files for star pattern matching, and a subset are referenced in the analysis output.

**Gaia Data Release 3** — European Space Agency

> Gaia Collaboration, Vallenari, A., Brown, A.G.A., et al. (2023). "Gaia Data Release 3: Summary of the content and survey properties." *Astronomy & Astrophysics*, 674, A1. doi:[10.1051/0004-6361/202243940](https://doi.org/10.1051/0004-6361/202243940)
>
> This work has made use of data from the European Space Agency (ESA) mission Gaia (https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium). Funding for the DPAC has been provided by national institutions, in particular the institutions participating in the Gaia Multilateral Agreement.

**Tycho-2 Catalogue**

> Høg, E., Fabricius, C., Makarov, V.V., Urban, S., Corbin, T., Wycoff, G., Bastian, U., Schwekendiek, P., & Wicenec, A. (2000). "The Tycho-2 Catalogue of the 2.5 Million Brightest Stars." *Astronomy & Astrophysics*, 355, L27–L30.

**Two Micron All-Sky Survey (2MASS)**

> Skrutskie, M.F., Cutri, R.M., Stiening, R., Weinberg, M.D., Schneider, S., Carpenter, J.M., Beichman, C., Capps, R., Chester, T., Elias, J., et al. (2006). "The Two Micron All Sky Survey (2MASS)." *The Astronomical Journal*, 131(2), 1163–1183. doi:[10.1086/498708](https://doi.org/10.1086/498708)

**Hipparcos Catalogue** — ESA, 1997. ESA SP-1200.

**USNO-B1.0** — Monet, D.G., et al. (2003). *The Astronomical Journal*, 125, 984.

**NOMAD** — Zacharias, N., et al. (2004). *Bulletin of the American Astronomical Society*, 36, 1418.

**NGC/IC** — Dreyer, J.L.E. (1888, 1895, 1908). New General Catalogue and Index Catalogues, with subsequent revisions including the Revised New General Catalogue (Sulentic & Tifft, 1973) and NGC 2000.0 (Sinnott, 1988).

### AI Model

**Google Gemini 3 Pro** via the `@google/genai` SDK. Used for image-aware text generation. Operated by Google DeepMind. Documentation: https://ai.google.dev/

### Geocoding

**OpenStreetMap Nominatim** — `nominatim.openstreetmap.org`

Used when GPS is absent from EXIF and a location name is read from a watermark. Operated by the OpenStreetMap Foundation under the Open Database License (ODbL).

> © OpenStreetMap contributors. Data licensed under ODbL; see https://www.openstreetmap.org/copyright
> Usage policy: https://operations.osmfoundation.org/policies/nominatim/

### CORS Proxy

**corsproxy.io** — fallback proxy used when the Vite dev proxy is unavailable.

### Front-end Libraries

| Library | Purpose | License |
|---|---|---|
| React 19 | UI framework | MIT |
| TypeScript 5.8 | Type system | Apache 2.0 |
| Vite 6 | Build tool / dev server | MIT |
| Tailwind CSS (CDN) | Styling | MIT |
| Font Awesome 6.4 (CDN) | Icons | Font Awesome Free License |
| EXIF.js (CDN) | EXIF metadata extraction | MIT |
| satellite.js | SGP4 orbital propagation | MIT |
| @google/genai | Gemini API client | Apache 2.0 |
| instagram-publisher | Instagram posting | MIT |

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
- European Space Agency for the Gaia mission and the Hipparcos and Tycho-2 catalogues
- The International Astronomical Union and the IAU Centre for the Protection of Dark and Quiet Skies (CPS) for SatChecker
- Dr. T.S. Kelso for CelesTrak
- Bill Gray for Project Pluto and `sat_code`
- Dustin Lang, Keir Mierle, Sam Roweis, David W. Hogg, and the Astrometry.net team
- The COBS team at Crni Vrh Observatory and the amateur comet observation community
- The APPLAUSE consortium, the Leibniz Institute for Astrophysics Potsdam (AIP), and the Bamberg, Hamburg, Potsdam, and Tartu observatories
- Friedrich-Alexander-University Erlangen-Nürnberg (Dr. Karl Remeis-Sternwarte Bamberg)
- The Deutsche Forschungsgemeinschaft (DFG) for funding the APPLAUSE digitization effort
- The 2MASS team (University of Massachusetts / IPAC / Caltech)
- The United States Naval Observatory for USNO-B1.0 and NOMAD
- OpenStreetMap contributors for Nominatim
- Google DeepMind for the Gemini model

## Data Source URLs

| Source | URL |
|---|---|
| Astrometry.net | https://nova.astrometry.net |
| CelesTrak | https://celestrak.org |
| Project Pluto | https://projectpluto.com |
| IAU CPS SatChecker | https://satchecker.cps.iau.org |
| NASA NeoWs | https://api.nasa.gov |
| JPL Horizons | https://ssd.jpl.nasa.gov/horizons/ |
| COBS | https://cobs.si |
| APPLAUSE | https://www.plate-archive.org |
| ESA Gaia | https://www.cosmos.esa.int/gaia |
| OpenStreetMap Nominatim | https://nominatim.openstreetmap.org |
| Google Gemini API | https://ai.google.dev/ |

## License and Attribution

When using identification results in published or shared material, please credit the underlying data sources. The generated Instagram caption includes attribution automatically.

If results are used in scientific work, cite the upstream data sources directly rather than this repository.
