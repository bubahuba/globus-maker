---
name: globus-stripe-pipeline
description: Understand and modify the Globus Maker job pipeline from map selection to stripe zip download. Use when changing job flow, tile math, stripe dimensions, processor integration, or map rendering.
---

# Stripe Generation Pipeline

## User flow

1. User selects center + square side on map
2. `POST /api/estimate` → zoom, tile count, stripe dimensions
3. `POST /api/jobs` → job queued, background `runJob()` starts
4. Frontend polls `GET /api/jobs/:id`
5. On complete, download via `GET /api/jobs/:id/download`

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

1. **fetching_tiles** — render vector tiles with palette
2. **stitching** — merge into square `input.jpg`
3. **projecting** — `slize.pl` meridian projection
4. **packaging** — zip stripes + input.jpg
5. API stores zip in R2, marks **complete**

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
| Stripe geometry | `container/slize.pl`, `process.py` |
| Job storage | `BE/src/jobs/store.ts`, `artifacts.ts` |
