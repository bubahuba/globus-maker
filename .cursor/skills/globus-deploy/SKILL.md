---
name: globus-deploy
description: Deploy Globus Maker to Cloudflare Workers with R2 and Containers. Use when deploying, configuring production bindings, or debugging Cloudflare-specific runtime issues.
---

# Deploy to Cloudflare

## Prerequisites

- Docker running (container image build)
- R2 bucket `globus-maker-artifacts` created in Cloudflare dashboard
- `wrangler` authenticated

## Deploy

```bash
npm run deploy          # build FE + wrangler deploy
npm run deploy:worker   # skip container rollout
```

## wrangler.jsonc bindings

| Binding | Purpose |
|---------|---------|
| `ASSETS` | Static SPA from `FE/build` |
| `ARTIFACTS` | R2 bucket for job state + zip files |
| `PROCESSOR` | `GlobusProcessor` Container DO |

## Production processor

Leave `PROCESSOR_URL` empty in `wrangler.jsonc` vars. Worker uses:

```typescript
env.PROCESSOR.getByName(jobId).fetch("http://processor/process", ...)
```

## Local vs production

| Setting | Local | Production |
|---------|-------|------------|
| API | `dev-server.ts` :8787 | Worker `fetch` handler |
| Processor | Docker `:8080` via `PROCESSOR_URL` | CF Container binding |
| Assets | Vite dev server | `ASSETS` binding |
| Callback | `API_CALLBACK_ORIGIN=host.docker.internal:8787` | Worker public origin |

## Verify deployment

```bash
curl https://<worker-domain>/health
```

Test a small region job end-to-end before large tile counts.
