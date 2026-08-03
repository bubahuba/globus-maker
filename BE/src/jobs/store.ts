import type { JobRecord, JobStatus, ProgressUpdate } from "../types";
import { normalizeJobMode } from "../osm/tile-math";

const memoryJobs = new Map<string, JobRecord>();

/** R2 / memory pointer to the most recent globe job with a sphere preview. */
const LATEST_GLOBE_KEY = "jobs/latest-globe.json";
let memoryLatestGlobeId: string | null = null;

export type LatestGlobePointer = {
  jobId: string;
  updatedAt: string;
};

export function createJobId(): string {
  return crypto.randomUUID();
}

function sortJobFiles(files: Iterable<string>): string[] {
  const rank = (name: string): number => {
    const lower = name.toLowerCase();
    if (lower === "input.svg" || lower === "input.jpg") return 0;
    if (lower === "input-distorted.svg" || lower === "input-distorted.jpg") return 1;
    if (lower === "input-distorted-preview.jpg") return 2;
    if (lower === "pole-caps.jpg") return 3;
    return 4;
  };
  return [...files].sort((a, b) => {
    const diff = rank(a) - rank(b);
    if (diff !== 0) return diff;
    return a.localeCompare(b, undefined, { numeric: true });
  });
}

/** Exported for tests — union + stable preview order. */
export function mergeJobFiles(...lists: Array<string[] | undefined>): string[] | undefined {
  const merged = new Set<string>();
  for (const list of lists) {
    for (const name of list ?? []) merged.add(name);
  }
  if (merged.size === 0) return undefined;
  return sortJobFiles(merged);
}

const JOB_FILE_RE =
  /^(?:(?:input|input-distorted|source-map)\.(?:jpg|jpeg|svg|png|webp)|input-distorted-preview\.jpe?g|pole-caps\.jpe?g|out-\d+\.(?:jpg|jpeg|svg))$/i;

export function isAllowedJobFilename(name: string): boolean {
  return JOB_FILE_RE.test(name);
}

export function contentTypeForJobFile(name: string): string {
  if (/\.svg$/i.test(name)) return "image/svg+xml";
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.webp$/i.test(name)) return "image/webp";
  return "application/octet-stream";
}

/** Filenames actually stored under jobs/{id}/files/ (source of truth across isolates). */
async function listStoredJobFilenames(
  bucket: R2Bucket,
  jobId: string,
): Promise<string[]> {
  const prefix = `jobs/${jobId}/files/`;
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    for (const obj of listed.objects) {
      const name = obj.key.slice(prefix.length);
      if (name && !name.includes("/") && isAllowedJobFilename(name)) {
        names.push(name);
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return names;
}

async function reconcileJobFiles(
  bucket: R2Bucket | undefined,
  job: JobRecord,
  ...extraLists: Array<string[] | undefined>
): Promise<void> {
  const listed = bucket ? await listStoredJobFilenames(bucket, job.id) : [];
  const files = mergeJobFiles(job.files, ...extraLists, listed);
  if (files) job.files = files;
  else delete job.files;
}

export async function saveJob(
  bucket: R2Bucket | undefined,
  job: JobRecord,
): Promise<void> {
  if (bucket) {
    // Merge concurrent writers: status.json files field + objects already in R2.
    const existingObj = await bucket.get(`jobs/${job.id}/status.json`);
    const existing = existingObj ? ((await existingObj.json()) as JobRecord) : null;
    await reconcileJobFiles(bucket, job, existing?.files);

    await bucket.put(`jobs/${job.id}/status.json`, JSON.stringify(job), {
      httpMetadata: { contentType: "application/json" },
    });
  }
  memoryJobs.set(job.id, structuredClone(job));
}

export async function getJob(
  bucket: R2Bucket | undefined,
  id: string,
): Promise<JobRecord | null> {
  // Prefer R2 so waitUntil isolates don't keep a stale in-memory snapshot
  // that overwrites preview files uploaded by other isolates.
  if (bucket) {
    const obj = await bucket.get(`jobs/${id}/status.json`);
    if (obj) {
      const job = (await obj.json()) as JobRecord;
      await reconcileJobFiles(bucket, job);
      memoryJobs.set(id, structuredClone(job));
      return structuredClone(job);
    }
  }

  const cached = memoryJobs.get(id);
  if (!cached) return null;
  return structuredClone(cached);
}

export async function updateJobProgress(
  bucket: R2Bucket | undefined,
  id: string,
  update: ProgressUpdate,
): Promise<JobRecord | null> {
  const job = await getJob(bucket, id);
  if (!job) return null;

  // Fire-and-forget packaging callbacks can land after "complete" and regress the UI.
  if (job.status === "complete" && update.status !== "complete" && update.status !== "failed") {
    return job;
  }
  if (job.status === "failed" && update.status !== "failed") {
    return job;
  }

  job.status = update.status;
  job.progress = update.progress;
  job.updatedAt = new Date().toISOString();
  if (update.error) job.error = update.error;
  if (update.stripeCount !== undefined) job.stripeCount = update.stripeCount;
  if (update.stepCurrent !== undefined) {
    job.stepCurrent = update.stepCurrent;
    job.stepTotal = update.stepTotal;
    job.stepUnit = update.stepUnit;
  } else {
    delete job.stepCurrent;
    delete job.stepTotal;
    delete job.stepUnit;
  }
  if (update.status === "queued" && update.queuePosition != null) {
    job.queuePosition = update.queuePosition;
    job.queueLength = update.queueLength;
  } else {
    delete job.queuePosition;
    delete job.queueLength;
  }

  await saveJob(bucket, job);
  return job;
}

export function isTerminalStatus(status: JobStatus): boolean {
  return status === "complete" || status === "failed";
}

export async function setLatestGlobeJob(
  bucket: R2Bucket | undefined,
  jobId: string,
  updatedAt = new Date().toISOString(),
): Promise<void> {
  const pointer: LatestGlobePointer = { jobId, updatedAt };
  memoryLatestGlobeId = jobId;
  if (bucket) {
    await bucket.put(LATEST_GLOBE_KEY, JSON.stringify(pointer), {
      httpMetadata: { contentType: "application/json" },
    });
  }
}

export async function getLatestGlobeJobId(
  bucket: R2Bucket | undefined,
): Promise<string | null> {
  if (bucket) {
    const obj = await bucket.get(LATEST_GLOBE_KEY);
    if (obj) {
      const pointer = (await obj.json()) as LatestGlobePointer;
      if (pointer?.jobId) {
        memoryLatestGlobeId = pointer.jobId;
        return pointer.jobId;
      }
    }
  }
  return memoryLatestGlobeId;
}

/** Drop the monitor pointer when it still points at a purged/unavailable job. */
export async function clearLatestGlobeJobIf(
  bucket: R2Bucket | undefined,
  jobId: string,
): Promise<void> {
  const current = await getLatestGlobeJobId(bucket);
  if (current !== jobId) return;
  memoryLatestGlobeId = null;
  if (bucket) {
    await bucket.delete(LATEST_GLOBE_KEY);
  }
}

export async function addJobFile(
  bucket: R2Bucket | undefined,
  id: string,
  filename: string,
): Promise<JobRecord | null> {
  const job = await getJob(bucket, id);
  if (!job) return null;

  job.files = mergeJobFiles(job.files, [filename]) ?? [filename];
  // Always bump updatedAt so clients can cache-bust replaced preview bytes.
  job.updatedAt = new Date().toISOString();
  await saveJob(bucket, job);

  // Public monitor: keep a pointer to the newest globe job with a sphere preview.
  if (
    normalizeJobMode(job.request.mode) === "globe" &&
    filename.toLowerCase() === "input-distorted-preview.jpg"
  ) {
    await setLatestGlobeJob(bucket, job.id, job.updatedAt);
  }

  return job;
}

/** Mark a globe job as paid after a successful PayPal capture. */
export async function markJobPaid(
  bucket: R2Bucket | undefined,
  id: string,
  payment: { orderId: string; captureId?: string },
): Promise<JobRecord | null> {
  const job = await getJob(bucket, id);
  if (!job) return null;

  job.paid = true;
  job.paidAt = new Date().toISOString();
  job.paypalOrderId = payment.orderId;
  if (payment.captureId) job.paypalCaptureId = payment.captureId;
  job.updatedAt = job.paidAt;
  await saveJob(bucket, job);
  return job;
}

/** Clear paid unlock after the stripe zip was downloaded (one-time unlock). */
export async function markJobUnpaid(
  bucket: R2Bucket | undefined,
  id: string,
): Promise<JobRecord | null> {
  const job = await getJob(bucket, id);
  if (!job) return null;

  job.paid = false;
  delete job.paidAt;
  job.updatedAt = new Date().toISOString();
  await saveJob(bucket, job);
  return job;
}
