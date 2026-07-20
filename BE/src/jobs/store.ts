import type { JobRecord, JobStatus, ProgressUpdate } from "../types";

const memoryJobs = new Map<string, JobRecord>();

export function createJobId(): string {
  return crypto.randomUUID();
}

export async function saveJob(
  bucket: R2Bucket | undefined,
  job: JobRecord,
): Promise<void> {
  memoryJobs.set(job.id, structuredClone(job));
  if (bucket) {
    await bucket.put(`jobs/${job.id}/status.json`, JSON.stringify(job), {
      httpMetadata: { contentType: "application/json" },
    });
  }
}

export async function getJob(
  bucket: R2Bucket | undefined,
  id: string,
): Promise<JobRecord | null> {
  const cached = memoryJobs.get(id);
  if (cached) return structuredClone(cached);

  if (!bucket) return null;

  const obj = await bucket.get(`jobs/${id}/status.json`);
  if (!obj) return null;

  const job = (await obj.json()) as JobRecord;
  memoryJobs.set(id, job);
  return structuredClone(job);
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

function mergeJobFiles(...lists: Array<string[] | undefined>): string[] | undefined {
  const merged = new Set<string>();
  for (const list of lists) {
    for (const name of list ?? []) merged.add(name);
  }
  if (merged.size === 0) return undefined;
  return sortJobFiles(merged);
}

export async function updateJobProgress(
  bucket: R2Bucket | undefined,
  id: string,
  update: ProgressUpdate,
): Promise<JobRecord | null> {
  const job = await getJob(bucket, id);
  if (!job) return null;

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

  // Preserve files added concurrently by upload handlers (avoid lost updates).
  const latestFiles = mergeJobFiles(job.files, memoryJobs.get(id)?.files);
  if (latestFiles) job.files = latestFiles;
  else delete job.files;

  await saveJob(bucket, job);
  return job;
}

export function isTerminalStatus(status: JobStatus): boolean {
  return status === "complete" || status === "failed";
}

const JOB_FILE_RE =
  /^(?:(?:input|input-distorted)\.(?:jpg|jpeg|svg)|input-distorted-preview\.jpe?g|pole-caps\.jpe?g|out-\d+\.(?:jpg|jpeg|svg))$/i;

export function isAllowedJobFilename(name: string): boolean {
  return JOB_FILE_RE.test(name);
}

export function contentTypeForJobFile(name: string): string {
  if (/\.svg$/i.test(name)) return "image/svg+xml";
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.png$/i.test(name)) return "image/png";
  return "application/octet-stream";
}

export async function addJobFile(
  bucket: R2Bucket | undefined,
  id: string,
  filename: string,
): Promise<JobRecord | null> {
  const job = await getJob(bucket, id);
  if (!job) return null;

  job.files = mergeJobFiles(job.files, memoryJobs.get(id)?.files, [filename]) ?? [filename];
  // Always bump updatedAt so clients can cache-bust replaced preview bytes.
  job.updatedAt = new Date().toISOString();
  await saveJob(bucket, job);
  return job;
}
