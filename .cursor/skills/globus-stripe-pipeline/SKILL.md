---
name: globus-stripe-pipeline
description: Understand and modify the Globus Maker job pipeline from map selection to map/stripe zip download. Use when changing job flow, tile math, stripe dimensions, processor integration, or map rendering.
---

# Map / Globe Generation Pipeline

## Modes

- **map** — square map (`input.svg` or rasterized `input.jpg`); no prewarp, no stripes
- **globe** — SVG stitch + DePolar sphere from `input.svg`, then prewarp + JPEG stripes via `slize.pl`

## User flow

1. User selects center + square side (meters); Map also sets `squareSidePx`, Globe sets diameter/stripes
2. `POST /api/estimate` → zoom, tile count, dimensions
3. `POST /api/jobs` → job queued, background `runJob()` starts
4. Processor single-flight queue: waiters get `queued` + `queuePosition`/`queueLength`
5. Frontend polls `GET /api/jobs/:id`; tab close → `POST /api/jobs/:id/cancel`
6. On complete, download via `GET /api/jobs/:id/download`

## Key formulas (`BE/src/osm/tile-math.ts`)

- Stripe height: `diameterCm × 160` px (25 cm → 4000 px)
- Stripe width: `round(2 × 0.09 × (12/stripes) × stripeHeightPx)` (12 stripes @ 4000px → 720 px)
- Map target: `squareSidePx` (500–10000); auto zoom targets that size, max 400 tiles, native cover capped ~6000 px

## Processor payload (`ProcessPayload`)

```typescript
{ jobId, callbackUrl, manifest, mode, stripes, diameterCm, stripeHeightPx,
  outputFormat, mapLayers, mapStyle, renderPalette }
```

## Processor steps

1. **fetching_tiles** — MVT → square `input.svg` (`svg_map.py`)
2. **Map** — optional SVG→JPEG; **packaging** zip (`input.svg`/`input.jpg`); done
3. **Globe** — DePolar sphere from `input.svg` → `input-distorted-preview.jpg`
4. **Globe** — BarrelInverse prewarp → `input-distorted.svg` + raster `input-distorted.jpg`
5. **projecting** — `slize.pl` → `out-*.jpg`
6. **packaging** — zip `input.svg` + `input-distorted.svg` + stripe JPGs
7. API stores zip in R2, marks **complete**

## Reference test values

Kninice (49.5467, 16.6963), 2500 m square, 25 cm globe, 12 stripes:
- `stripeHeightPx = 4000`
- `stripeWidthPx = 720`

Run `npm test` after tile-math changes.

## Modifying the pipeline

| Change | Files |
|--------|-------|
| Input validation | `validateJobInput()` in tile-math, API handlers |
| Zoom/tile limits | `BE/src/osm/tile-math.ts` |
| Map appearance | `shared/map-style.ts`, `container/svg_map.py` |
| Stripe geometry | `container/slize.pl`, `process.py` |
| Job storage | `BE/src/jobs/store.ts`, `artifacts.ts` |
