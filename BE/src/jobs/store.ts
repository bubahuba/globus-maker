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

  await saveJob(bucket, job);
  return job;
}

export function isTerminalStatus(status: JobStatus): boolean {
  return status === "complete" || status === "failed";
}
