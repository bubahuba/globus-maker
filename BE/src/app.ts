import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import type { JobRecord, JobRequest, ProcessPayload, ProgressUpdate } from "./types";
import {
  buildTileManifest,
  maxFeasibleZoom,
  stripeHeightPx,
  stripeWidthPx,
  validateJobInput,
  squareBounds,
  resolveZoom,
} from "./osm/tile-math";
import { buildMapStyle, buildRenderPalette, validateMapLayers } from "../../shared/map-style";
import {
  createJobId,
  getJob,
  saveJob,
  updateJobProgress,
} from "./jobs/store";
import { getArtifact, putArtifact } from "./jobs/artifacts";

const DEV_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
];

export const app = new Hono<{ Bindings: Env }>();

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return "*";
      if (DEV_ORIGINS.includes(origin)) return origin;
      return origin;
    },
    allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
  }),
);

export function isApiRequest(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname === "/health" || pathname.startsWith("/api/");
}

async function dispatchToProcessor(
  env: Env,
  jobId: string,
  payload: ProcessPayload,
): Promise<Response> {
  const body = JSON.stringify(payload);

  if (!env.PROCESSOR_URL) {
    if (!env.PROCESSOR) {
      throw new Error("No processor configured (set PROCESSOR_URL for local dev)");
    }
    const container = env.PROCESSOR.getByName(jobId);
    return container.fetch("http://processor/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  }

  return fetch(`${env.PROCESSOR_URL.replace(/\/$/, "")}/process`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function runJob(env: Env, job: JobRecord, origin: string): Promise<void> {
  const zoom = resolveZoom(job.request.center, job.request.sideMeters, job.request.diameterCm);
  const manifest = buildTileManifest(job.request.center, job.request.sideMeters, {
    zoom,
    diameterCm: job.request.diameterCm,
  });
  const stripeH = stripeHeightPx(job.request.diameterCm);
  const mapLayers = validateMapLayers(job.request.mapLayers);
  const callbackOrigin = env.API_CALLBACK_ORIGIN ?? origin;

  const payload: ProcessPayload = {
    jobId: job.id,
    callbackUrl: `${callbackOrigin}/api/jobs/${job.id}/progress`,
    manifest,
    stripes: job.request.stripes,
    diameterCm: job.request.diameterCm,
    stripeHeightPx: stripeH,
    mapLayers,
    mapStyle: buildMapStyle(mapLayers),
    renderPalette: buildRenderPalette(mapLayers),
  };

  try {
    await updateJobProgress(env.ARTIFACTS, job.id, {
      status: "fetching_tiles",
      progress: 5,
      stepCurrent: 0,
      stepTotal: manifest.tiles.length * 2,
      stepUnit: "tile",
    });

    const response = await dispatchToProcessor(env, job.id, payload);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Processor failed with ${response.status}`);
    }

    const zipBytes = await response.arrayBuffer();
    await putArtifact(env.ARTIFACTS, `jobs/${job.id}/stripes.zip`, zipBytes, "application/zip");

    await updateJobProgress(env.ARTIFACTS, job.id, {
      status: "complete",
      progress: 100,
      stripeCount: job.request.stripes,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown processing error";
    await updateJobProgress(env.ARTIFACTS, job.id, {
      status: "failed",
      progress: 0,
      error: message,
    });
  }
}

app.get("/health", (c) => c.json({ status: "ok" }));

app.post("/api/jobs", async (c) => {
  const body = (await c.req.json()) as JobRequest;
  const validationError = validateJobInput(body);
  if (validationError) {
    return c.json({ error: validationError }, 400);
  }

  let manifest;
  try {
    const zoom = resolveZoom(body.center, body.sideMeters, body.diameterCm);
    manifest = buildTileManifest(body.center, body.sideMeters, { zoom, diameterCm: body.diameterCm });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid map selection";
    return c.json({ error: message }, 400);
  }

  const now = new Date().toISOString();
  const stripeH = stripeHeightPx(body.diameterCm);
  const job: JobRecord = {
    id: createJobId(),
    status: "queued",
    progress: 0,
    stripeCount: body.stripes,
    stripeHeightPx: stripeH,
    stripeWidthPx: stripeWidthPx(stripeH, body.stripes),
    createdAt: now,
    updatedAt: now,
    request: body,
  };

  await saveJob(c.env.ARTIFACTS, job);

  const origin = new URL(c.req.url).origin;
  c.executionCtx.waitUntil(runJob(c.env, job, origin));

  return c.json(
    {
      jobId: job.id,
      status: job.status,
      manifest: {
        zoom: manifest.zoom,
        tileCount: manifest.tiles.length,
        outputSizePx: manifest.targetOutputPx,
        stripeHeightPx: stripeH,
        stripeWidthPx: job.stripeWidthPx,
      },
    },
    202,
  );
});

app.get("/api/jobs/:id", async (c) => {
  const job = await getJob(c.env.ARTIFACTS, c.req.param("id"));
  if (!job) return c.json({ error: "Job not found" }, 404);

  return c.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    error: job.error,
    stripeCount: job.stripeCount,
    stripeHeightPx: job.stripeHeightPx,
    stripeWidthPx: job.stripeWidthPx,
    stepCurrent: job.stepCurrent,
    stepTotal: job.stepTotal,
    stepUnit: job.stepUnit,
    downloadUrl: job.status === "complete" ? `/api/jobs/${job.id}/download` : null,
  });
});

app.patch("/api/jobs/:id/progress", async (c) => {
  const update = (await c.req.json()) as ProgressUpdate;
  const job = await updateJobProgress(c.env.ARTIFACTS, c.req.param("id"), update);
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json({ ok: true });
});

app.get("/api/jobs/:id/download", async (c) => {
  const job = await getJob(c.env.ARTIFACTS, c.req.param("id"));
  if (!job) return c.json({ error: "Job not found" }, 404);
  if (job.status !== "complete") {
    return c.json({ error: "Job not complete" }, 409);
  }

  const zipBytes = await getArtifact(c.env.ARTIFACTS, `jobs/${job.id}/stripes.zip`);
  if (!zipBytes) return c.json({ error: "Artifact missing" }, 404);

  const headers = new Headers();
  headers.set("Content-Type", "application/zip");
  headers.set("Content-Disposition", `attachment; filename="globus-stripes-${job.id}.zip"`);

  return new Response(zipBytes, { headers });
});

app.get("/api/geocode", async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q || q.length < 2) {
    return c.json([]);
  }

  const params = new URLSearchParams({
    q,
    format: "json",
    limit: "6",
    addressdetails: "0",
  });

  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: {
      "User-Agent": "GlobusMaker/1.0 (globe stripe generator)",
      "Accept-Language": "en",
    },
  });

  if (!response.ok) {
    return c.json({ error: "Geocoding service unavailable" }, 502);
  }

  const results = (await response.json()) as Array<{
    place_id: number;
    display_name: string;
    lat: string;
    lon: string;
  }>;

  return c.json(
    results.map((item) => ({
      placeId: item.place_id,
      displayName: item.display_name,
      lat: Number(item.lat),
      lng: Number(item.lon),
    })),
  );
});

app.post("/api/estimate", async (c) => {
  const body = (await c.req.json()) as JobRequest;
  const validationError = validateJobInput(body);
  if (validationError) {
    const bounds = squareBounds(body.center, body.sideMeters);
    return c.json({ error: validationError, maxZoom: maxFeasibleZoom(bounds) }, 400);
  }

  try {
    const zoom = resolveZoom(body.center, body.sideMeters, body.diameterCm);
    const manifest = buildTileManifest(body.center, body.sideMeters, {
      zoom,
      diameterCm: body.diameterCm,
    });
    const stripeH = stripeHeightPx(body.diameterCm);
    return c.json({
      zoom,
      tileCount: manifest.tiles.length,
      outputSizePx: manifest.outputSizePx,
      targetOutputPx: manifest.targetOutputPx,
      stripeHeightPx: stripeH,
      stripeWidthPx: stripeWidthPx(stripeH, body.stripes),
      bounds: manifest.bounds,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid map selection";
    const bounds = squareBounds(body.center, body.sideMeters);
    return c.json({ error: message, maxZoom: maxFeasibleZoom(bounds) }, 400);
  }
});
