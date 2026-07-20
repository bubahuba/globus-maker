import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import type {
  JobMode,
  JobRecord,
  JobRequest,
  OutputFormat,
  ProcessPayload,
  ProgressUpdate,
  TileManifest,
} from "./types";
import {
  buildTileManifest,
  maxFeasibleZoom,
  normalizeJobMode,
  resolveTargetOutputPx,
  resolveZoom,
  stripeHeightPx,
  stripeWidthPx,
  stubManifestForUpload,
  validateJobInput,
  squareBounds,
} from "./osm/tile-math";
import { buildMapStyle, buildRenderPalette, validateMapLayers } from "../../shared/map-style";
import {
  addJobFile,
  contentTypeForJobFile,
  createJobId,
  getJob,
  isAllowedJobFilename,
  isTerminalStatus,
  markJobPaid,
  markJobUnpaid,
  saveJob,
  updateJobProgress,
} from "./jobs/store";
import {
  getArtifact,
  purgeJobArtifacts,
  purgeJobArtifactsIfExpired,
  putArtifact,
} from "./jobs/artifacts";
import {
  jobDownloadFilename,
  jobZipFilename,
  normalizeGlobeDownloadFormat,
} from "./jobs/filename";
import { buildGlobeStripesPdf } from "./jobs/globe-pdf";
import { captureGlobeDownloadOrder, createGlobeDownloadOrder } from "./paypal/client";
import { publicPaypalConfig } from "./paypal/config";

const DEV_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
];

/** Shared processor instance so all jobs share one queue. */
const PROCESSOR_INSTANCE = "shared";

export const app = new Hono<{ Bindings: Env }>();

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return "*";
      if (DEV_ORIGINS.includes(origin)) return origin;
      return origin;
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

export function isApiRequest(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname === "/health" || pathname.startsWith("/api/");
}

function processorBase(env: Env): string {
  return (env.PROCESSOR_URL ?? "").replace(/\/$/, "");
}

/** Globe stripe zip requires a successful PayPal capture; map zip stays free. */
function canDownloadZip(job: JobRecord): boolean {
  if (job.status !== "complete") return false;
  if (job.artifactsAvailable === false) return false;
  if (normalizeJobMode(job.request.mode) === "globe" && job.paid !== true) return false;
  return true;
}

function normalizeRequest(body: JobRequest): JobRequest & {
  mode: JobMode;
  outputFormat: OutputFormat;
  stripes: number;
  diameterCm: number;
  squareSidePx: number;
} {
  const mode = normalizeJobMode(body.mode);
  const outputFormat: OutputFormat =
    mode === "globe" ? "jpg" : body.outputFormat === "svg" ? "svg" : "jpg";
  return {
    ...body,
    mode,
    outputFormat,
    stripes: Number.isFinite(Number(body.stripes)) ? Math.round(Number(body.stripes)) : 12,
    diameterCm: Number.isFinite(Number(body.diameterCm))
      ? Math.round(Number(body.diameterCm) * 10) / 10
      : 25,
    squareSidePx: Number.isFinite(Number(body.squareSidePx))
      ? Math.round(Number(body.squareSidePx))
      : 4000,
  };
}

async function dispatchToProcessor(
  env: Env,
  payload: ProcessPayload,
): Promise<Response> {
  const body = JSON.stringify(payload);

  if (!env.PROCESSOR_URL) {
    if (!env.PROCESSOR) {
      throw new Error("No processor configured (set PROCESSOR_URL for local dev)");
    }
    const container = env.PROCESSOR.getByName(PROCESSOR_INSTANCE);
    return container.fetch("http://processor/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  }

  return fetch(`${processorBase(env)}/process`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function cancelOnProcessor(env: Env, jobId: string): Promise<void> {
  try {
    if (!env.PROCESSOR_URL) {
      if (!env.PROCESSOR) return;
      const container = env.PROCESSOR.getByName(PROCESSOR_INSTANCE);
      await container.fetch(`http://processor/process/${jobId}`, { method: "DELETE" });
      return;
    }
    await fetch(`${processorBase(env)}/process/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
    });
  } catch {
    // Best-effort: job may not have reached the processor yet.
  }
}

async function cancelJob(env: Env, jobId: string): Promise<JobRecord | null> {
  const job = await getJob(env.ARTIFACTS, jobId);
  if (!job) return null;

  const alreadyCancelled = job.status === "failed" && job.error === "Cancelled";
  // Don't wipe a successful/failed-for-other-reason job; do clean on cancel (incl. retries).
  if (isTerminalStatus(job.status) && !alreadyCancelled) return job;

  if (!isTerminalStatus(job.status)) {
    await updateJobProgress(env.ARTIFACTS, jobId, {
      status: "failed",
      progress: 0,
      error: "Cancelled",
    });
  }

  // Drop uploaded previews/zip from API storage, then stop processor + wipe its work dir.
  await purgeJobArtifacts(env.ARTIFACTS, jobId);
  await cancelOnProcessor(env, jobId);
  return (await getJob(env.ARTIFACTS, jobId)) ?? job;
}

const SOURCE_MAP_MAX_BYTES = 40 * 1024 * 1024;
const SOURCE_MAP_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type SourceMapUpload = {
  name: string;
  type: string;
  size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

function sourceMapFilename(contentType: string): string {
  if (contentType === "image/png") return "source-map.png";
  if (contentType === "image/webp") return "source-map.webp";
  return "source-map.jpg";
}

function asSourceMapUpload(value: unknown): SourceMapUpload | null {
  if (value == null || typeof value !== "object") return null;
  const candidate = value as Partial<SourceMapUpload> & { arrayBuffer?: unknown };
  if (typeof candidate.arrayBuffer !== "function" || typeof candidate.size !== "number") {
    return null;
  }
  if (candidate.size <= 0) return null;
  const name =
    typeof candidate.name === "string" && candidate.name.trim()
      ? candidate.name
      : "source-map.jpg";
  const type = typeof candidate.type === "string" ? candidate.type : "";
  return {
    name,
    type,
    size: candidate.size,
    arrayBuffer: () => candidate.arrayBuffer!() as Promise<ArrayBuffer>,
  };
}

async function parseCreateJobBody(c: {
  req: {
    header: (name: string) => string | undefined;
    json: () => Promise<unknown>;
    parseBody: (options?: { all?: boolean }) => Promise<Record<string, unknown>>;
  };
}): Promise<{ body: JobRequest; sourceMap: SourceMapUpload | null }> {
  const contentType = c.req.header("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.parseBody({ all: true });
    const raw = form["request"];
    if (typeof raw !== "string") {
      throw new Error("request JSON field required");
    }
    let body: JobRequest;
    try {
      body = JSON.parse(raw) as JobRequest;
    } catch {
      throw new Error("request must be valid JSON");
    }
    const fileField = form["sourceMap"];
    const file = Array.isArray(fileField) ? fileField[0] : fileField;
    return { body, sourceMap: asSourceMapUpload(file) };
  }
  return { body: (await c.req.json()) as JobRequest, sourceMap: null };
}

async function runJob(
  env: Env,
  job: JobRecord,
  origin: string,
  options?: { sourceMapFilename?: string },
): Promise<void> {
  const request = normalizeRequest(job.request);
  const targetPx = resolveTargetOutputPx(request);
  const sourceMapName = options?.sourceMapFilename;
  const manifest: TileManifest = sourceMapName
    ? stubManifestForUpload(targetPx)
    : (() => {
        const zoom = resolveZoom(request.center, request.sideMeters, targetPx);
        return buildTileManifest(request.center, request.sideMeters, {
          zoom,
          targetOutputPx: targetPx,
        });
      })();
  const stripeH =
    request.mode === "globe" ? stripeHeightPx(request.diameterCm) : 0;
  const mapLayers = validateMapLayers(request.mapLayers);
  const callbackOrigin = env.API_CALLBACK_ORIGIN ?? origin;

  const payload: ProcessPayload = {
    jobId: job.id,
    callbackUrl: `${callbackOrigin}/api/jobs/${job.id}/progress`,
    manifest,
    mode: request.mode,
    stripes: request.stripes,
    diameterCm: request.diameterCm,
    stripeHeightPx: stripeH || targetPx,
    outputFormat: request.outputFormat,
    placeName: request.placeName,
    mapLayers,
    mapStyle: buildMapStyle(mapLayers),
    renderPalette: buildRenderPalette(mapLayers),
    ...(sourceMapName
      ? { sourceMapUrl: `${callbackOrigin}/api/jobs/${job.id}/files/${sourceMapName}` }
      : {}),
  };

  try {
    const current = await getJob(env.ARTIFACTS, job.id);
    if (current?.error === "Cancelled" || current?.status === "failed") {
      return;
    }

    const response = await dispatchToProcessor(env, payload);
    if (!response.ok) {
      const text = await response.text();
      const cancelled = response.status === 409 || /cancel/i.test(text);
      throw new Error(cancelled ? "Cancelled" : text || `Processor failed with ${response.status}`);
    }

    const after = await getJob(env.ARTIFACTS, job.id);
    if (after?.error === "Cancelled") {
      return;
    }

    const zipBytes = await response.arrayBuffer();
    await putArtifact(env.ARTIFACTS, `jobs/${job.id}/stripes.zip`, zipBytes, "application/zip");

    await updateJobProgress(env.ARTIFACTS, job.id, {
      status: "complete",
      progress: 100,
      stripeCount: request.mode === "globe" ? request.stripes : 0,
    });
    // Zip is the source of truth for download; keep preview JPEGs until download/TTL.
    const completed = await getJob(env.ARTIFACTS, job.id);
    if (completed && completed.artifactsAvailable === undefined) {
      completed.artifactsAvailable = true;
      await saveJob(env.ARTIFACTS, completed);
    }
  } catch (error) {
    const existing = await getJob(env.ARTIFACTS, job.id);
    if (existing?.error === "Cancelled") {
      return;
    }
    let message = error instanceof Error ? error.message : "Unknown processing error";
    if (message === "fetch failed" || /ECONNREFUSED|Failed to fetch/i.test(message)) {
      message =
        "Processor unreachable — start it with npm run dev:processor (or npm run dev)";
    }
    await updateJobProgress(env.ARTIFACTS, job.id, {
      status: "failed",
      progress: 0,
      error: message,
    });
    // Failed jobs won't be downloaded — free preview/partial uploads.
    await purgeJobArtifacts(env.ARTIFACTS, job.id);
  }
}

app.get("/health", (c) => c.json({ status: "ok" }));

app.post("/api/jobs", async (c) => {
  let body: JobRequest;
  let sourceMap: SourceMapUpload | null;
  try {
    ({ body, sourceMap } = await parseCreateJobBody(c));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid job request";
    return c.json({ error: message }, 400);
  }

  const hasSourceMap = sourceMap != null;
  if (hasSourceMap) {
    if (sourceMap.size > SOURCE_MAP_MAX_BYTES) {
      return c.json({ error: "sourceMap must be 40 MB or smaller" }, 400);
    }
    const type = (sourceMap.type || "").toLowerCase();
    const name = sourceMap.name.toLowerCase();
    const extOk = /\.(jpe?g|png|webp)$/i.test(name);
    if (type ? !SOURCE_MAP_TYPES.has(type) : !extOk) {
      return c.json({ error: "sourceMap must be JPEG, PNG, or WebP" }, 400);
    }
  }

  const validationError = validateJobInput(body, { hasSourceMap });
  if (validationError) {
    return c.json({ error: validationError }, 400);
  }

  const request = normalizeRequest(body);
  if (hasSourceMap && request.mode !== "globe") {
    return c.json({ error: "Uploaded map is only supported in Globe mode" }, 400);
  }
  // Upload-only jobs may omit a real map center; keep a stable stub for storage.
  if (hasSourceMap && (!Number.isFinite(request.center?.lat) || !Number.isFinite(request.center?.lng))) {
    request.center = { lat: 0, lng: 0 };
  }
  if (hasSourceMap && (!Number.isFinite(request.sideMeters) || request.sideMeters <= 0)) {
    request.sideMeters = 2500;
  }

  const placeName =
    typeof body.placeName === "string" ? body.placeName.trim().slice(0, 120) || undefined : undefined;
  request.placeName = placeName;

  let manifest: TileManifest;
  try {
    const targetPx = resolveTargetOutputPx(request);
    if (hasSourceMap) {
      manifest = stubManifestForUpload(targetPx);
    } else {
      const zoom = resolveZoom(request.center, request.sideMeters, targetPx);
      manifest = buildTileManifest(request.center, request.sideMeters, {
        zoom,
        targetOutputPx: targetPx,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid map selection";
    return c.json({ error: message }, 400);
  }

  const now = new Date().toISOString();
  const stripeH =
    request.mode === "globe" ? stripeHeightPx(request.diameterCm) : 0;
  const job: JobRecord = {
    id: createJobId(),
    status: "queued",
    progress: 0,
    stripeCount: request.mode === "globe" ? request.stripes : 0,
    stripeHeightPx: stripeH || undefined,
    stripeWidthPx:
      request.mode === "globe" ? stripeWidthPx(stripeH, request.stripes) : undefined,
    createdAt: now,
    updatedAt: now,
    request,
  };

  await saveJob(c.env.ARTIFACTS, job);

  let storedSourceName: string | undefined;
  if (hasSourceMap && sourceMap) {
    let type = (sourceMap.type || "").toLowerCase();
    if (!SOURCE_MAP_TYPES.has(type)) {
      const name = sourceMap.name.toLowerCase();
      if (name.endsWith(".png")) type = "image/png";
      else if (name.endsWith(".webp")) type = "image/webp";
      else type = "image/jpeg";
    }
    storedSourceName = sourceMapFilename(type);
    const bytes = await sourceMap.arrayBuffer();
    await putArtifact(
      c.env.ARTIFACTS,
      `jobs/${job.id}/files/${storedSourceName}`,
      bytes,
      contentTypeForJobFile(storedSourceName),
    );
    await addJobFile(c.env.ARTIFACTS, job.id, storedSourceName);
  }

  const origin = new URL(c.req.url).origin;
  c.executionCtx.waitUntil(
    runJob(c.env, job, origin, { sourceMapFilename: storedSourceName }),
  );

  return c.json(
    {
      jobId: job.id,
      status: job.status,
      manifest: {
        zoom: manifest.zoom,
        tileCount: manifest.tiles.length,
        outputSizePx: manifest.targetOutputPx,
        stripeHeightPx: stripeH,
        stripeWidthPx: job.stripeWidthPx ?? 0,
      },
    },
    202,
  );
});

app.get("/api/jobs/:id", async (c) => {
  let job = await getJob(c.env.ARTIFACTS, c.req.param("id"));
  if (!job) return c.json({ error: "Job not found" }, 404);

  job = await purgeJobArtifactsIfExpired(c.env.ARTIFACTS, job);

  const hasArtifacts = job.artifactsAvailable !== false;
  const mode = normalizeJobMode(job.request.mode);
  const zipReady = canDownloadZip(job);
  // Default listing uses zip name; FE swaps .pdf when that format is selected.
  const downloadFilename = jobZipFilename({ ...job.request, mode });

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
    queuePosition: job.queuePosition,
    queueLength: job.queueLength,
    files: job.files ?? [],
    artifactsAvailable: hasArtifacts,
    paid: job.paid === true,
    updatedAt: job.updatedAt,
    downloadUrl: zipReady ? `/api/jobs/${job.id}/download` : null,
    // Filename is always available once complete (not gated on paid) so the UI can show
    // place + size before checkout; only downloadUrl requires payment for globe.
    downloadFilename:
      job.status === "complete" && hasArtifacts ? downloadFilename : null,
    placeName: job.request.placeName,
    center: job.request.center,
    sideMeters: job.request.sideMeters,
    mode,
    squareSidePx: job.request.squareSidePx,
    stripes: job.request.stripes,
    diameterCm: job.request.diameterCm,
    outputFormat: job.request.outputFormat === "svg" ? "svg" : "jpg",
  });
});

app.put("/api/jobs/:id/files/:name", async (c) => {
  const jobId = c.req.param("id");
  const name = c.req.param("name");
  if (!isAllowedJobFilename(name)) {
    return c.json({ error: "Invalid filename" }, 400);
  }

  const job = await getJob(c.env.ARTIFACTS, jobId);
  if (!job) return c.json({ error: "Job not found" }, 404);
  if (job.error === "Cancelled") {
    return c.json({ ok: true, ignored: true, abort: true });
  }

  const bytes = await c.req.arrayBuffer();
  if (!bytes.byteLength) {
    return c.json({ error: "Empty file body" }, 400);
  }

  const contentType = contentTypeForJobFile(name);
  await putArtifact(c.env.ARTIFACTS, `jobs/${jobId}/files/${name}`, bytes, contentType);
  await addJobFile(c.env.ARTIFACTS, jobId, name);
  return c.json({ ok: true, file: name });
});

app.get("/api/jobs/:id/files/:name", async (c) => {
  const jobId = c.req.param("id");
  const name = c.req.param("name");
  if (!isAllowedJobFilename(name)) {
    return c.json({ error: "Invalid filename" }, 400);
  }

  const job = await getJob(c.env.ARTIFACTS, jobId);
  if (!job) return c.json({ error: "Job not found" }, 404);

  const bytes = await getArtifact(c.env.ARTIFACTS, `jobs/${jobId}/files/${name}`);
  if (!bytes) return c.json({ error: "File not ready" }, 404);

  const headers = new Headers();
  headers.set("Content-Type", contentTypeForJobFile(name));
  // Previews may be replaced after a partial upload; never serve stale bytes.
  headers.set("Cache-Control", "no-store");
  return new Response(bytes, { headers });
});

app.patch("/api/jobs/:id/progress", async (c) => {
  const jobId = c.req.param("id");
  const existing = await getJob(c.env.ARTIFACTS, jobId);
  if (!existing) return c.json({ error: "Job not found" }, 404);
  // Tell the processor to stop if the client already cancelled.
  if (existing.error === "Cancelled") {
    return c.json({ ok: true, ignored: true, abort: true });
  }

  const update = (await c.req.json()) as ProgressUpdate;
  const job = await updateJobProgress(c.env.ARTIFACTS, jobId, update);
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json({ ok: true });
});

app.delete("/api/jobs/:id", async (c) => {
  const job = await cancelJob(c.env, c.req.param("id"));
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json({ ok: true, status: job.status, error: job.error });
});

/** Beacon-friendly cancel (sendBeacon only supports POST). */
app.post("/api/jobs/:id/cancel", async (c) => {
  const job = await cancelJob(c.env, c.req.param("id"));
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json({ ok: true, status: job.status, error: job.error });
});

app.get("/api/jobs/:id/download", async (c) => {
  let job = await getJob(c.env.ARTIFACTS, c.req.param("id"));
  if (!job) return c.json({ error: "Job not found" }, 404);

  job = await purgeJobArtifactsIfExpired(c.env.ARTIFACTS, job);

  const mode = normalizeJobMode(job.request.mode);
  const format = normalizeGlobeDownloadFormat(c.req.query("format"));
  if (mode === "map" && format === "pdf") {
    return c.json({ error: "PDF download is only available for globe jobs" }, 400);
  }
  if (mode === "globe" && job.paid !== true) {
    return c.json({ error: "Payment required for globe download" }, 402);
  }
  if (job.status !== "complete") {
    return c.json({ error: "Job not complete" }, 409);
  }
  if (job.artifactsAvailable === false) {
    return c.json({ error: "Artifacts already removed" }, 410);
  }
  if (!canDownloadZip(job)) {
    return c.json({ error: "Download not available" }, 403);
  }

  const zipBytes = await getArtifact(c.env.ARTIFACTS, `jobs/${job.id}/stripes.zip`);
  if (!zipBytes) {
    await purgeJobArtifacts(c.env.ARTIFACTS, job.id);
    return c.json({ error: "Artifact missing" }, 404);
  }

  const filename = jobDownloadFilename({ ...job.request, mode }, format);
  const headers = new Headers();
  // Client can refresh job status; server deletes zip + previews after the body is buffered.
  headers.set("X-Artifacts-Purged", "1");
  headers.set("Content-Disposition", `attachment; filename="${filename}"`);

  let body: ArrayBuffer | Uint8Array = zipBytes;
  if (format === "pdf") {
    try {
      body = await buildGlobeStripesPdf(zipBytes);
      headers.set("Content-Type", "application/pdf");
    } catch (err) {
      const message = err instanceof Error ? err.message : "PDF build failed";
      console.error("[download] pdf:", message);
      return c.json({ error: message }, 500);
    }
  } else {
    headers.set("Content-Type", "application/zip");
  }

  const artifacts = c.env.ARTIFACTS;
  const jobId = job.id;
  c.executionCtx.waitUntil(
    (async () => {
      await purgeJobArtifacts(artifacts, jobId);
      // One-time unlock: paid download clears paid so the URL cannot be reused.
      if (mode === "globe") {
        await markJobUnpaid(artifacts, jobId);
      }
    })(),
  );

  return new Response(body, { headers });
});

app.get("/api/paypal/config", (c) => {
  const raw = c.req.query("diameterCm");
  const diameterCm = raw != null && raw !== "" ? Number(raw) : undefined;
  return c.json(publicPaypalConfig(c.env, diameterCm));
});

app.post("/api/paypal/orders", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    jobId?: string;
    format?: string;
  } | null;
  const jobId = body?.jobId?.trim();
  if (!jobId) return c.json({ error: "jobId is required" }, 400);
  const format = normalizeGlobeDownloadFormat(body?.format);

  const job = await getJob(c.env.ARTIFACTS, jobId);
  if (!job) return c.json({ error: "Job not found" }, 404);
  if (job.status !== "complete") return c.json({ error: "Job not complete" }, 409);
  if (normalizeJobMode(job.request.mode) !== "globe") {
    return c.json({ error: "PayPal checkout is only for globe downloads" }, 400);
  }
  if (job.artifactsAvailable === false) {
    return c.json({ error: "Artifacts already removed" }, 410);
  }
  if (job.paid === true) {
    return c.json({ id: job.paypalOrderId ?? "already-paid", alreadyPaid: true });
  }

  try {
    const filename = jobDownloadFilename({ ...job.request, mode: "globe" }, format);
    const order = await createGlobeDownloadOrder(c.env, {
      jobId,
      filename,
      diameterCm: Number(job.request.diameterCm) || 0,
      format,
    });
    return c.json(order);
  } catch (err) {
    const message = err instanceof Error ? err.message : "PayPal create order failed";
    console.error("[paypal] create order:", message);
    return c.json({ error: message }, 502);
  }
});

app.post("/api/paypal/orders/:orderId/capture", async (c) => {
  const orderId = c.req.param("orderId");
  const body = (await c.req.json().catch(() => null)) as { jobId?: string } | null;
  const expectedJobId = body?.jobId?.trim();

  try {
    const result = await captureGlobeDownloadOrder(c.env, orderId);
    const jobId = result.jobId || expectedJobId;
    if (!jobId) {
      return c.json({ error: "Capture succeeded but job id missing" }, 502);
    }
    if (expectedJobId && result.jobId && expectedJobId !== result.jobId) {
      return c.json({ error: "Order job mismatch" }, 409);
    }
    if (result.status !== "COMPLETED") {
      return c.json({ error: `Payment not completed (${result.status})` }, 402);
    }

    const job = await getJob(c.env.ARTIFACTS, jobId);
    if (!job) return c.json({ error: "Job not found" }, 404);
    if (normalizeJobMode(job.request.mode) !== "globe") {
      return c.json({ error: "PayPal checkout is only for globe downloads" }, 400);
    }

    const paid = await markJobPaid(c.env.ARTIFACTS, jobId, {
      orderId: result.orderId,
      captureId: result.captureId,
    });
    if (!paid) return c.json({ error: "Failed to unlock download" }, 500);

    return c.json({
      ok: true,
      status: result.status,
      orderId: result.orderId,
      captureId: result.captureId,
      jobId,
      paid: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "PayPal capture failed";
    console.error("[paypal] capture:", message);
    return c.json({ error: message }, 502);
  }
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
    const request = normalizeRequest(body);
    const targetPx = resolveTargetOutputPx(request);
    const zoom = resolveZoom(request.center, request.sideMeters, targetPx);
    const manifest = buildTileManifest(request.center, request.sideMeters, {
      zoom,
      targetOutputPx: targetPx,
    });
    const stripeH =
      request.mode === "globe" ? stripeHeightPx(request.diameterCm) : 0;
    return c.json({
      zoom,
      tileCount: manifest.tiles.length,
      outputSizePx: manifest.outputSizePx,
      targetOutputPx: manifest.targetOutputPx,
      stripeHeightPx: stripeH,
      stripeWidthPx: request.mode === "globe" ? stripeWidthPx(stripeH, request.stripes) : 0,
      bounds: manifest.bounds,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid map selection";
    const bounds = squareBounds(body.center, body.sideMeters);
    return c.json({ error: message, maxZoom: maxFeasibleZoom(bounds) }, 400);
  }
});
