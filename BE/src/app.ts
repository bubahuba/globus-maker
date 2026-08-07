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
import {
  buildMapStyle,
  buildRenderPalette,
  getBaseFillColor,
  getMapCanvasColor,
  validateMapLayers,
} from "../../shared/map-style";
import {
  addJobFile,
  contentTypeForJobFile,
  createJobId,
  getJob,
  getLatestGlobeJobId,
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
import { hydratePreviewFilesFromZip } from "./jobs/hydrate-previews";
import { captureGlobeDownloadOrder, createGlobeDownloadOrder } from "./paypal/client";
import { publicPaypalConfig } from "./paypal/config";

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
      // Allow any origin (monitor site may be hosted elsewhere).
      return origin;
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Content-Type", "Content-Length", "X-Archive-Name"],
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
  const base = processorBase(env);
  if (!base) {
    throw new Error("No processor configured (set PROCESSOR_URL)");
  }

  return fetch(`${base}/process`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function cancelOnProcessor(env: Env, jobId: string): Promise<void> {
  const base = processorBase(env);
  if (!base) return;

  try {
    await fetch(`${base}/process/${encodeURIComponent(jobId)}`, {
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

    // Prefer zip already uploaded via PUT /api/jobs/:id/zip (CF Workers often
    // cannot hold the long /process response until the zip body arrives).
    let zipBytes = await getArtifact(env.ARTIFACTS, `jobs/${job.id}/stripes.zip`);
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!zipBytes && !contentType.includes("application/json")) {
      zipBytes = await response.arrayBuffer();
      if (zipBytes.byteLength > 0) {
        await putArtifact(env.ARTIFACTS, `jobs/${job.id}/stripes.zip`, zipBytes, "application/zip");
      }
    } else if (!zipBytes) {
      // Drain JSON ack so the connection closes cleanly.
      await response.arrayBuffer();
    }

    zipBytes = zipBytes ?? (await getArtifact(env.ARTIFACTS, `jobs/${job.id}/stripes.zip`));
    if (!zipBytes?.byteLength) {
      const latest = await getJob(env.ARTIFACTS, job.id);
      if (latest?.status === "complete") {
        // Callback path marked complete; zip should exist — re-check once.
        zipBytes = await getArtifact(env.ARTIFACTS, `jobs/${job.id}/stripes.zip`);
      }
      if (!zipBytes?.byteLength) {
        throw new Error("Processor finished without delivering the zip");
      }
    }

    // Recover previews when mid-job PUTs never reached this API (bad callback origin).
    await hydratePreviewFilesFromZip(env.ARTIFACTS, job.id, zipBytes);

    await updateJobProgress(env.ARTIFACTS, job.id, {
      status: "complete",
      progress: 100,
      stripeCount: request.mode === "globe" ? request.stripes : 0,
    });
    // Zip is the source of truth for download; keep preview JPEGs until download/TTL.
    const completed = await getJob(env.ARTIFACTS, job.id);
    if (completed && completed.artifactsAvailable !== false) {
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
  if (sourceMap) {
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
  request.mapLayers = validateMapLayers(body.mapLayers);

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

/** Monitor-site-relative fallback when no recent globe preview exists. */
const MONITOR_FALLBACK_SPHERE = "rip.jpeg";

/** Filenames accepted by monitor `globe-preview/save.php`. */
const ARCHIVE_FILENAME_RE = /^[A-Za-z0-9._-]+\.(jpe?g|png|webp)$/i;

function monitorOrigin(env: Env): string {
  return (env.MONITOR_ORIGIN ?? "https://rgb.sk").replace(/\/$/, "");
}

function sanitizeArchiveFilename(raw: string): string | null {
  const name = raw.replace(/\\/g, "/").split("/").pop() ?? "";
  return ARCHIVE_FILENAME_RE.test(name) ? name : null;
}

/**
 * Proxy to monitor PHP archive APIs on MONITOR_ORIGIN (rgb.sk):
 *   GET  /api/globe-preview/list
 *   POST /api/globe-preview/save?name=
 *   GET  /api/globe-preview/:name
 */
app.get("/api/globe-preview/list", async (c) => {
  const upstream = await fetch(`${monitorOrigin(c.env)}/globe-preview/list.php`, {
    headers: { Accept: "application/json, text/plain, */*" },
  });
  const body = await upstream.arrayBuffer();
  return new Response(body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") || "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
});

app.post("/api/globe-preview/save", async (c) => {
  const name = sanitizeArchiveFilename(c.req.query("name") ?? "");
  if (!name) return c.text("Invalid filename", 400);

  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) return c.text("Empty body", 400);
  if (body.byteLength > 32 * 1024 * 1024) return c.text("Too large", 413);

  // Forward optional archive metadata for JPEG COM embed (GD strips EXIF).
  const metaParams = new URLSearchParams();
  metaParams.set("name", name);
  for (const key of ["placeName", "lat", "lng", "sideMeters"] as const) {
    const value = c.req.query(key);
    if (value != null && value !== "") metaParams.set(key, value);
  }

  const upstream = await fetch(
    `${monitorOrigin(c.env)}/globe-preview/save.php?${metaParams.toString()}`,
    {
      method: "POST",
      body,
      headers: {
        "Content-Type": c.req.header("Content-Type") || "image/jpeg",
      },
    },
  );
  const text = await upstream.text();
  const headers = new Headers({
    "Content-Type": upstream.headers.get("Content-Type") || "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  const archiveName = upstream.headers.get("X-Archive-Name");
  if (archiveName) headers.set("X-Archive-Name", archiveName);
  return new Response(text, { status: upstream.status, headers });
});

app.on(["GET", "HEAD"], "/api/globe-preview/:name", async (c) => {
  const name = sanitizeArchiveFilename(c.req.param("name"));
  if (!name) return c.text("Not found", 404);

  const upstream = await fetch(
    `${monitorOrigin(c.env)}/globe-preview/${encodeURIComponent(name)}`,
    { method: c.req.method },
  );
  if (!upstream.ok) {
    return new Response(upstream.status === 404 ? "Not found" : "Upstream error", {
      status: upstream.status,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const headers = {
    "Content-Type": upstream.headers.get("Content-Type") || "image/jpeg",
    "Cache-Control": "public, max-age=3600",
  };
  if (c.req.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  const body = await upstream.arrayBuffer();
  return new Response(body, { status: 200, headers });
});

function latestGlobeFallback() {
  return {
    id: null,
    status: null,
    updatedAt: null,
    placeName: null,
    center: null,
    sideMeters: null,
    diameterCm: null,
    stripes: null,
    mode: "globe" as const,
    files: [] as string[],
    emptyFillColor: "#808080",
    mapCanvasColor: "#808080",
    mapLayers: null,
    /** Relative to the monitor site (not the API origin). */
    spherePreviewUrl: MONITOR_FALLBACK_SPHERE,
    mapPreviewUrl: null,
    mapPreviewFilename: null,
    fallback: true,
  };
}

/**
 * Latest globe job with a sphere preview — for the public monitor site
 * (cross-origin; returns empty-fill + preview URLs like the FE globe card).
 * When none is available, returns monitor-relative `rip.jpeg` as spherePreviewUrl.
 */
app.get("/api/jobs/latest-globe", async (c) => {
  const jobId = await getLatestGlobeJobId(c.env.ARTIFACTS);
  if (!jobId) return c.json(latestGlobeFallback());

  let job = await getJob(c.env.ARTIFACTS, jobId);
  if (!job) return c.json(latestGlobeFallback());

  job = await purgeJobArtifactsIfExpired(c.env.ARTIFACTS, job);
  if (job.artifactsAvailable === false) {
    return c.json(latestGlobeFallback());
  }

  const mode = normalizeJobMode(job.request.mode);
  if (mode !== "globe") {
    return c.json(latestGlobeFallback());
  }

  const files = job.files ?? [];
  const fileSet = new Set(files.map((f) => f.toLowerCase()));
  if (!fileSet.has("input-distorted-preview.jpg")) {
    return c.json(latestGlobeFallback());
  }

  const mapLayers = validateMapLayers(job.request.mapLayers);
  const bust = job.updatedAt ? `?v=${encodeURIComponent(job.updatedAt)}` : "";
  const mapFile = fileSet.has("input.svg")
    ? "input.svg"
    : fileSet.has("input.jpg")
      ? "input.jpg"
      : fileSet.has("input.jpeg")
        ? (files.find((f) => f.toLowerCase() === "input.jpeg") ?? "input.jpg")
        : null;

  return c.json({
    id: job.id,
    status: job.status,
    updatedAt: job.updatedAt,
    placeName: job.request.placeName ?? null,
    center: job.request.center,
    sideMeters: job.request.sideMeters,
    diameterCm: job.request.diameterCm,
    stripes: job.request.stripes,
    mode,
    files,
    emptyFillColor: getBaseFillColor(mapLayers),
    mapCanvasColor: getMapCanvasColor(mapLayers),
    mapLayers,
    spherePreviewUrl: `/api/jobs/${job.id}/files/input-distorted-preview.jpg${bust}`,
    mapPreviewUrl: mapFile
      ? `/api/jobs/${job.id}/files/${encodeURIComponent(mapFile)}${bust}`
      : null,
    mapPreviewFilename: mapFile,
    fallback: false,
  });
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
    mapLayers: validateMapLayers(job.request.mapLayers),
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

/** Processor uploads the finished zip here so Workers need not stream it from /process. */
app.put("/api/jobs/:id/zip", async (c) => {
  const jobId = c.req.param("id");
  const job = await getJob(c.env.ARTIFACTS, jobId);
  if (!job) return c.json({ error: "Job not found" }, 404);
  if (job.error === "Cancelled") {
    return c.json({ ok: true, ignored: true, abort: true });
  }

  const bytes = await c.req.arrayBuffer();
  if (!bytes.byteLength) {
    return c.json({ error: "Empty zip body" }, 400);
  }

  await putArtifact(c.env.ARTIFACTS, `jobs/${jobId}/stripes.zip`, bytes, "application/zip");
  await hydratePreviewFilesFromZip(c.env.ARTIFACTS, jobId, bytes);

  const mode = normalizeJobMode(job.request.mode);
  await updateJobProgress(c.env.ARTIFACTS, jobId, {
    status: "complete",
    progress: 100,
    stripeCount: mode === "globe" ? job.stripeCount || job.request.stripes : 0,
  });

  const updated = await getJob(c.env.ARTIFACTS, jobId);
  if (updated) {
    updated.artifactsAvailable = true;
    await saveJob(c.env.ARTIFACTS, updated);
  }

  return c.json({ ok: true });
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

const NOMINATIM_HEADERS = {
  "User-Agent": "GlobusMaker/1.0 (globe stripe generator)",
  "Accept-Language": "en",
} as const;

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
    headers: NOMINATIM_HEADERS,
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

/** Nominatim reverse `zoom` ≈ Leaflet zoom: higher → finer place (suburb/street). */
function clampNominatimZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 10;
  return Math.min(18, Math.max(0, Math.round(zoom)));
}

type NominatimAddress = {
  continent?: string;
  country?: string;
  state?: string;
  region?: string;
  state_district?: string;
  county?: string;
  municipality?: string;
  city?: string;
  town?: string;
  village?: string;
  hamlet?: string;
  suburb?: string;
  city_district?: string;
  neighbourhood?: string;
  quarter?: string;
  city_block?: string;
  road?: string;
  amenity?: string;
  tourism?: string;
  building?: string;
  [key: string]: string | undefined;
};

/** Pick a short label matching the requested detail level. */
function placeLabelFromNominatim(
  zoom: number,
  name: string | undefined,
  displayName: string,
  address?: NominatimAddress,
): string {
  const first = (...keys: string[]) => {
    if (!address) return undefined;
    for (const key of keys) {
      const value = address[key]?.trim();
      if (value) return value;
    }
    return undefined;
  };

  let label: string | undefined;
  if (zoom >= 16) {
    label = first("amenity", "tourism", "building", "road", "neighbourhood", "suburb", "city_block");
  } else if (zoom >= 14) {
    label = first("suburb", "neighbourhood", "quarter", "city_district", "city_block");
  } else if (zoom >= 12) {
    label = first("city_district", "suburb", "town", "village", "hamlet", "city", "municipality");
  } else if (zoom >= 10) {
    label = first("city", "town", "village", "hamlet", "municipality");
  } else if (zoom >= 7) {
    label = first("county", "state_district", "municipality");
  } else if (zoom >= 4) {
    label = first("state", "region", "state_district");
  } else {
    label = first("country", "continent");
  }

  if (!label) {
    label =
      name?.trim() ||
      first(
        "suburb",
        "neighbourhood",
        "city",
        "town",
        "village",
        "municipality",
        "county",
        "state",
        "country",
      ) ||
      displayName.split(",")[0]?.trim() ||
      displayName;
  }
  return label;
}

app.get("/api/reverse-geocode", async (c) => {
  const lat = Number(c.req.query("lat"));
  const lng = Number(c.req.query("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return c.json({ error: "Invalid coordinates" }, 400);
  }

  const zoomParam = c.req.query("zoom");
  const zoom = clampNominatimZoom(zoomParam != null && zoomParam !== "" ? Number(zoomParam) : 10);

  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lng),
    format: "json",
    zoom: String(zoom),
    addressdetails: "1",
  });

  const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`, {
    headers: NOMINATIM_HEADERS,
  });

  if (!response.ok) {
    return c.json({ error: "Geocoding service unavailable" }, 502);
  }

  const result = (await response.json()) as {
    place_id?: number;
    name?: string;
    display_name?: string;
    lat?: string;
    lon?: string;
    address?: NominatimAddress;
    error?: string;
  };

  if (result.error || !result.display_name || result.lat == null || result.lon == null) {
    return c.json(null);
  }

  const label = placeLabelFromNominatim(zoom, result.name, result.display_name, result.address);

  return c.json({
    placeId: result.place_id ?? 0,
    displayName: result.display_name,
    label,
    lat: Number(result.lat),
    lng: Number(result.lon),
  });
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
