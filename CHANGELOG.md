# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- LICENSE (MIT)
- `.nvmrc` pinning the Node version
- `CONTRIBUTING.md` with development setup and conventions
- `CHANGELOG.md`
- `ARCHITECTURE.md` describing the pipeline design and FactSheet pattern
- `.env.example` documenting required environment variables
- MPC packed designation unpacker so COBS Planner IDs work with JPL Horizons
- Deterministic comet injection: comets confirmed in the plate-solved FOV are added to identifications without depending on the language model
- Magnitude estimation from absolute H + observer distance when COBS Planner and JPL Horizons disagree by more than three magnitudes
- Pipeline summary log including comet count alongside satellite and NEO counts

### Changed
- Comet survey now runs for every image regardless of whether a target is specified
- Magnitude resolution priority: COBS observations → JPL Horizons (when sources agree) → computed estimate (when sources disagree)
- `fetchCometData` errors now surface with detail instead of being swallowed silently
- README rewritten to focus on technical content and data source citations

### Fixed
- COBS Planner returning MPC packed format (`0003I`, `CK25T010`) which JPL Horizons rejected
- No-plate-solve path falsely reporting comets as "in the field" based only on magnitude
- SatChecker results being treated as verified when the object was outside the FOV
- Astrometry.net API key was hardcoded in source; now required via `ASTROMETRY_API_KEY` env var

### Security
- Astrometry.net API key removed from source tree
- Git history rewritten to scrub the previously committed Astrometry.net key
- `.env.example` added so contributors can set up keys without copying from another developer

[Unreleased]: https://github.com/NXTLupo/astro_id/commits/main
