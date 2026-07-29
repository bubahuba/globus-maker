---
name: globus-deploy
description: Deploy Globus Maker to Cloudflare Workers with R2. Use when deploying, configuring production bindings, or debugging Cloudflare-specific runtime issues.
---

# Deploy to Cloudflare

## Prerequisites

- R2 bucket `globus-maker-artifacts` created in Cloudflare dashboard
- External processor already deployed (`PROCESSOR_URL`)
- `wrangler` authenticated

## Deploy

```bash
npm run deploy          # build FE + wrangler deploy
```

## Cloudflare Workers Builds (git)

Root `npm ci` does **not** install `FE/` deps. `npm run build` runs `npm ci --prefix FE` first so Vite is available.

Build command: `npm run build` (default is fine).

## wrangler.jsonc bindings

| Binding / var | Purpose |
|---------------|---------|
| `ASSETS` | Static SPA from `FE/build` |
| `ARTIFACTS` | R2 bucket for job state + zip files |
| `PROCESSOR_URL` | External processor base URL |

No Containers / Durable Object processor — processing is a separate service.

## Production processor

Set in `wrangler.jsonc` vars (or dashboard):

```jsonc
"PROCESSOR_URL": "https://globus-processor.rascasone.dev"
```

Also set `API_CALLBACK_ORIGIN` to the Worker public URL so the processor can PATCH job progress.

## Local vs production

| Setting | Local | Production |
|---------|-------|------------|
| API | `dev-server.ts` :8787 | Worker `fetch` handler |
| Processor | Docker `:8080` via `PROCESSOR_URL` | External `PROCESSOR_URL` |
| Assets | Vite dev server | `ASSETS` binding |
| Callback | `API_CALLBACK_ORIGIN=host.docker.internal:8787` | Worker public origin |

## Verify deployment

```bash
curl https://<worker-domain>/health
```

Test a small region job end-to-end before large tile counts.
