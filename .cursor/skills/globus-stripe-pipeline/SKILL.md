---
name: globus-stripe-pipeline
description: Understand and modify the Globus Maker job pipeline from map selection to stripe zip download. Use when changing job flow, tile math, stripe dimensions, processor integration, or map rendering.
---

# Stripe Generation Pipeline

## User flow

1. User selects center + square side on map
2. `POST /api/estimate` → zoom, tile count, stripe dimensions
3. `POST /api/jobs` → job queued, background `runJob()` starts
4. Processor single-flight queue: waiters get `queued` + `queuePosition`/`queueLength`
5. Frontend polls `GET /api/jobs/:id`; tab close → `POST /api/jobs/:id/cancel`
6. On complete, download via `GET /api/jobs/:id/download`

## Key formulas (`BE/src/osm/tile-math.ts`)

- Stripe height: `diameterCm × 160` px (25 cm → 4000 px)
- Stripe width: `round(2 × 0.09 × (12/stripes) × stripeHeightPx)` (12 stripes @ 4000px → 720 px)
- Auto zoom targets ~4500 px output, max 400 tiles, max 6000 px

## Processor payload (`ProcessPayload`)

```typescript
{ jobId, callbackUrl, manifest, stripes, diameterCm, stripeHeightPx,
  mapLayers, mapStyle, renderPalette }
```

## Processor steps

1. **fetching_tiles** — MVT → square `input.svg` (`svg_map.py`)
2. **stitching** — upload stitched SVG (crop/pad already in SVG build)
3. **prewarp** — geometric BarrelInverse → `input-distorted.svg` (`svg_warp.py`)
4. **projecting** — stereographic→TM → `out-*.svg`; DePolar JPEG preview for globe
5. **packaging** — zip SVGs (`input.svg`, `input-distorted.svg`, stripes)
6. API stores zip in R2, marks **complete**

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
| Map appearance | `shared/map-style.ts`, `container/tile_render.py` |
| Stripe geometry | `container/svg_warp.py`, `process.py` |
| Job storage | `BE/src/jobs/store.ts`, `artifacts.ts` |
