---
name: globus-local-dev
description: Start and troubleshoot Globe Maker local development (processor, API, frontend). Use when running the app locally, fixing dev environment issues, or when API/processor connection errors appear.
---

# Globe Maker Local Dev

## Prerequisites

```bash
npm run install:all
cp .dev.vars.example .dev.vars   # PROCESSOR_URL=http://localhost:8080
```

Docker required for the processor.

## Start everything

```bash
npm run dev
```

| Service | URL |
|---------|-----|
| Frontend | http://localhost:5173 |
| API | http://localhost:8787 |
| Processor | http://localhost:8080 |

Individual services: `dev:processor`, `dev:api`, `dev:fe`. Skip Docker: `npm run dev -- --no-processor`.

## Verify

```bash
curl http://localhost:8787/health    # {"status":"ok"}
curl http://localhost:8080/health    # {"status":"ok"}
```

## Common issues

| Symptom | Fix |
|---------|-----|
| "API server not running" in UI | Start `npm run dev:api` |
| Processor 500 / connection refused | Start `npm run dev:processor`, check `.dev.vars` |
| Progress not updating | Ensure `API_CALLBACK_ORIGIN=http://host.docker.internal:8787` in `.dev.vars` |
| CORS errors | API allows localhost:5173 and :8787 |

## Cloudflare-style local dev

```bash
npm run dev:cf   # wrangler dev (needs built FE)
```

## Tests

```bash
npm test         # tile-math tests
npm run typecheck
npm run check --prefix FE
```
