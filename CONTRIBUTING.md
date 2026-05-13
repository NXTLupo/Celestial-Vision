# Contributing

## Development Setup

```bash
nvm use                       # picks up Node version from .nvmrc
npm install
cp .env.example .env.local    # fill in API keys
npm run dev                   # http://localhost:4200
```

Required API keys are listed in `.env.example`. All three (Gemini, Astrometry.net, APPLAUSE) are free to request; the APPLAUSE token requires a brief registration with the plate-archive.org team.

## Project Layout

```
App.tsx                  Top-level pipeline orchestration
services/                External-API integrations (one file per data source)
components/              React UI components
server/                  Vite middleware for server-side proxy endpoints
utils/                   Shared math and catalog-matching helpers
types.ts                 Cross-cutting TypeScript types
```

See `ARCHITECTURE.md` for the design rationale and pipeline stages.

## Branches and Commits

- Develop on a feature branch off `main`. Open a PR against `main` when ready.
- Keep commits focused. Prefer one logical change per commit.
- Commit messages should describe *why* the change is being made, not just *what* the diff contains.

## Code Style

- TypeScript strict mode is on. Run `npx tsc --noEmit` before pushing.
- No bundled linter at present; match the existing style (two-space indent, single quotes in TS, double quotes in JSX attributes).
- Comments should explain non-obvious behavior, API quirks, or constraints. They should not narrate what the code does when the code already says so.

## Testing

No automated test framework is configured yet. When adding tests, place them next to the file they cover (`foo.ts` / `foo.test.ts`) and run them through whichever runner is added in the same change.

Until tests exist, verify changes by:

1. Running the dev server.
2. Uploading a representative image and confirming the pipeline stages all log success.
3. Checking the final report against the source data: every numeric claim should trace to a logged API response.

## Adding a New Data Source

The pipeline assumes a consistent shape for every external service:

1. New file in `services/` with a single exported async function returning a typed result or `null`.
2. CORS proxy entry in `vite.config.ts` if the service does not allow direct browser access.
3. Result merged into the FactSheet (see `ARCHITECTURE.md`) with explicit source attribution.
4. Any new env var added to both `.env.example` and the `define` block in `vite.config.ts`.

## Secrets

`.env.local` and `.claude/settings.local.json` are gitignored. Do not commit credentials. The `.env.example` file documents what variables are expected without including values.

Before opening a PR, run a quick local check:

```bash
git diff --cached | grep -E "(AIzaSy|sk-|ghp_|Token [a-f0-9]{40})" || echo "no secret patterns in staged changes"
```
