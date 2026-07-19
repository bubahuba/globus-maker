# Globus Maker

Web app to download an OpenStreetMap region and generate globe meridian stripes using the Panotools pipeline from [`slize.pl`](../ziman-globusator/slize.pl).

## Stack

- **Frontend**: SvelteKit (static) + Leaflet
- **API**: Cloudflare Worker + Hono
- **Processing**: Docker container (`nona`, ImageMagick, patched `slize.pl`)

## Quick start (local)

### 1. Install dependencies

```bash
npm run install:all
```

### 2. Start everything

```bash
npm run dev
```

This starts:
- Processor on `http://localhost:8080` (Docker)
- API on `http://localhost:8787` (proxied by Vite)
- Frontend on `http://localhost:5173`

`.dev.vars` is created automatically from `.dev.vars.example` on first run.

Or run services separately:

```bash
npm run dev:processor   # Docker processor
npm run dev:api         # API only
npm run dev:fe          # Frontend only
```

### Cloudflare-style local dev (optional)

```bash
npm run dev:cf
```

Uses `wrangler dev` instead of the standalone API server.

## Deploy (Cloudflare)

Requires Docker running locally for image build.

```bash
npm run deploy
```

Create the R2 bucket `globus-maker-artifacts` in your Cloudflare account before first deploy.

For production, leave `PROCESSOR_URL` empty so the Worker uses the `GlobusProcessor` container binding.

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/estimate` | POST | Preview zoom, tile count, stripe dimensions |
| `/api/jobs` | POST | Start stripe generation job |
| `/api/jobs/:id` | GET | Poll job status |
| `/api/jobs/:id/download` | GET | Download `stripes.zip` |
| `/health` | GET | Liveness |

## Inputs

- **Square side** (meters): map area to download
- **Stripes**: number of meridian strips (4–36, default 12)
- **Globe diameter** (cm): sets stripe height via `diameterCm × 160` px (25 cm → 4000 px)

## Tests

```bash
npm test
```

Verifies tile math and Kninice reference stripe dimensions (720×4000 px for 25 cm / 12 stripes).
