# Security Notes

## This project is a local-first development tool

The architecture is intended for use on a developer's own machine with their own API keys. The dev server binds to `127.0.0.1` and is not designed to be exposed publicly.

## API keys are inlined into the client bundle

Vite's `define` config substitutes the values of `GEMINI_API_KEY`, `ASTROMETRY_API_KEY`, and `APPLAUSE_TOKEN` into the JavaScript bundle at build time. This means:

- **Anyone who can read the bundle can extract the keys.** That includes anyone with access to the deployed JS file, anyone in the browser's DevTools, and anyone with network-tap access to a page that loads the bundle.
- **Do not deploy this application publicly with real keys.** If you publish a hosted version, you must first refactor the keyed API calls (Gemini, Astrometry.net, APPLAUSE) to run on a server you control. The browser should call your server; your server should hold the keys and call the upstream APIs.

For local single-user development with your own keys on your own machine, the current setup is acceptable.

## Data sent to third parties

When an image is analyzed, the following data flows to external services:

| Service | Data sent |
|---|---|
| Astrometry.net | The uploaded image (downscaled to ≤1800 px) |
| Google Gemini API | The uploaded image plus structured analysis context |
| JPL Horizons | Observer latitude / longitude / date (if GPS or geocoded location is available) |
| NASA NeoWs | Observation date |
| COBS | Observation date and location (for the visibility planner) |
| CelesTrak | None (TLE catalogs are downloaded only) |
| Project Pluto | Observation date, time, observer location, RA/Dec center |
| IAU CPS SatChecker | Observation time, observer location, satellite ID lookups |
| APPLAUSE | Plate-solved RA/Dec center |
| Google Gemini (Ask the Astronomer chat) | Image, full pipeline context, user's chat messages |

EXIF metadata (camera model, date, GPS) is read locally; only the GPS coordinates (if present) are forwarded to ephemeris and satellite-identification services.

If you do not want certain data to leave your machine, you can:

- Strip GPS from your images before uploading
- Skip target/location pre-scan by setting target and date manually in the upload form
- Avoid uploading personally identifying images

## Reporting a security issue

This repository does not have a published vulnerability-disclosure program. If you believe you have found a security issue, please open a private discussion or contact the repository owner directly rather than filing a public issue.
