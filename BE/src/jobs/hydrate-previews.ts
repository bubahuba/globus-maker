import { unzipSync } from "fflate";
import { getArtifact, putArtifact } from "./artifacts";
import {
  addJobFile,
  contentTypeForJobFile,
  isAllowedJobFilename,
} from "./store";

/**
 * Only the square map may be recovered from the paid zip into the public preview
 * store. Globe stripes / pole-caps in the zip are full print resolution — those
 * must stay zip-only (download after payment). Stripe UI previews come from the
 * processor’s downscaled PUTs (`preview_max_height`).
 */
const ZIP_SAFE_PREVIEW_RE = /^input\.(?:svg|jpg|jpeg)$/i;

/**
 * When the processor cannot callback (wrong API_CALLBACK_ORIGIN, tunnel down, …)
 * the zip may still arrive via the /process response while mid-job file PUTs never
 * hit this API. Extract the square map so “Stitched map” is not stuck on Waiting.
 */
export async function hydratePreviewFilesFromZip(
  bucket: R2Bucket | undefined,
  jobId: string,
  zipBytes: ArrayBuffer,
): Promise<string[]> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(zipBytes));
  } catch {
    return [];
  }

  const added: string[] = [];
  for (const [rawName, data] of Object.entries(entries)) {
    const name = (rawName.split("/").pop() ?? rawName).trim();
    if (!name || !ZIP_SAFE_PREVIEW_RE.test(name) || !isAllowedJobFilename(name)) {
      continue;
    }

    const key = `jobs/${jobId}/files/${name}`;
    const existing = await getArtifact(bucket, key);
    if (!existing?.byteLength) {
      const copy = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      ) as ArrayBuffer;
      await putArtifact(bucket, key, copy, contentTypeForJobFile(name));
    }
    await addJobFile(bucket, jobId, name);
    added.push(name);
  }

  return added;
}
