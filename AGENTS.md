# Globus Maker — Agent Guide

Web app: select an OSM region → export a square map (Map mode) or generate globe meridian stripe JPEGs (Globe mode).

## Quick commands

```bash
npm run install:all
npm run dev             # processor :8080 + API :8787 + FE :5173
npm test
npm run deploy
```

## Project map

- **FE/** — SvelteKit 5 + Tailwind + Leaflet (`@lib`, `@shared` aliases)
- **BE/src/** — Hono API, tile math, job store
- **worker.ts** — Cloudflare Worker entry
- **container/** — Python processor (MVT → SVG map → globe prewarp → slize.pl JPEG stripes → zip)
- **shared/** — `map-style.ts` (layers, MapLibre style, render palette)

## Cursor context

Rules in `.cursor/rules/` (auto-applied by file type):
- `project-overview.mdc` — always on
- `svelte-frontend.mdc` — FE changes
- `api-backend.mdc` — API/Worker changes
- `processor-container.mdc` — Python pipeline
- `shared-map-style.mdc` — map layer/style changes

Skills in `.cursor/skills/` (load when relevant):
- `globus-local-dev` — run/troubleshoot local setup
- `globus-stripe-pipeline` — job flow and tile math
- `globus-deploy` — Cloudflare deployment

## Critical invariants

- Modes: `map` (square export) | `globe` (prewarp + JPEG stripes via `slize.pl`)
- Stripe height: `diameterCm × 160` px (Globe); Map uses `squareSidePx` (500–10000)
- Keep `BE/src/types.ts` and `FE/src/lib/types.ts` aligned
- Map layers: single source in `shared/map-style.ts`
- Always stitch via SVG tiles (`input.svg`). Map: zip `input.svg`/`input.jpg` only. Globe: sphere DePolar from `input.svg`; prewarp → `input-distorted.svg` + `pole-caps.jpg` + `slize.pl` → `out-*.jpg`
- Run `npm test` after `tile-math.ts` changes
