import type { JobRecord } from "../types";
import { getJob, saveJob } from "./store";

const memoryArtifacts = new Map<string, ArrayBuffer>();

/** Drop zip/previews for completed/failed jobs after this age (lazy purge on access). */
export const JOB_ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;

export async function putArtifact(
  bucket: R2Bucket | undefined,
  key: string,
  data: ArrayBuffer,
  contentType: string,
): Promise<void> {
  memoryArtifacts.set(key, data);
  if (bucket) {
    await bucket.put(key, data, {
      httpMetadata: { contentType },
    });
  }
}

export async function getArtifact(
  bucket: R2Bucket | undefined,
  key: string,
): Promise<ArrayBuffer | null> {
  if (bucket) {
    const object = await bucket.get(key);
    if (object) return object.arrayBuffer();
  }
  return memoryArtifacts.get(key) ?? null;
}

/** Delete preview/zip artifacts for a job (keeps status.json if present). */
export async function deleteJobFileArtifacts(
  bucket: R2Bucket | undefined,
  jobId: string,
): Promise<void> {
  const prefix = `jobs/${jobId}/`;
  const statusKey = `${prefix}status.json`;

  for (const key of [...memoryArtifacts.keys()]) {
    if (key.startsWith(prefix) && key !== statusKey) {
      memoryArtifacts.delete(key);
    }
  }

  if (!bucket) return;

  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    const toDelete = listed.objects.map((obj) => obj.key).filter((key) => key !== statusKey);
    await Promise.all(toDelete.map((key) => bucket.delete(key)));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

/** Remove zip + preview files and mark the job so the UI stops offering download. */
export async function purgeJobArtifacts(
  bucket: R2Bucket | undefined,
  jobId: string,
): Promise<JobRecord | null> {
  await deleteJobFileArtifacts(bucket, jobId);
  const job = await getJob(bucket, jobId);
  if (!job) return null;
  delete job.files;
  job.artifactsAvailable = false;
  job.updatedAt = new Date().toISOString();
  await saveJob(bucket, job);
  return job;
}

/** Lazy TTL: wipe heavy artifacts for old terminal jobs (status.json kept). */
export async function purgeJobArtifactsIfExpired(
  bucket: R2Bucket | undefined,
  job: JobRecord,
  nowMs = Date.now(),
): Promise<JobRecord> {
  if (job.artifactsAvailable === false) return job;
  if (job.status !== "complete" && job.status !== "failed") return job;

  const updated = Date.parse(job.updatedAt);
  if (!Number.isFinite(updated) || nowMs - updated < JOB_ARTIFACT_TTL_MS) {
    return job;
  }

  return (await purgeJobArtifacts(bucket, job.id)) ?? job;
}
