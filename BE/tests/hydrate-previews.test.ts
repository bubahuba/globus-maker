import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { hydratePreviewFilesFromZip } from "../src/jobs/hydrate-previews";
import { getArtifact } from "../src/jobs/artifacts";
import { getJob, saveJob } from "../src/jobs/store";
import type { JobRecord } from "../src/types";

function makeJob(id: string): JobRecord {
  return {
    id,
    status: "packaging",
    progress: 90,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    request: {
      mode: "globe",
      center: { lat: 0, lng: 0 },
      sideMeters: 1000,
      squareSidePx: 1000,
      stripes: 12,
      diameterCm: 25,
      outputFormat: "jpg",
    },
  };
}

async function main() {
  const jobId = "hydrate-test-job";
  await saveJob(undefined, makeJob(jobId));

  const zipBytes = zipSync({
    "input.svg": new TextEncoder().encode("<svg/>"),
    "pole-caps.jpg": new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    "readme.txt": new TextEncoder().encode("skip me"),
    "nested/out-00.jpg": new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  });

  const added = await hydratePreviewFilesFromZip(
    undefined,
    jobId,
    zipBytes.buffer.slice(
      zipBytes.byteOffset,
      zipBytes.byteOffset + zipBytes.byteLength,
    ) as ArrayBuffer,
  );

  assert.deepEqual(added, ["input.svg"]);
  assert.equal(added.includes("out-00.jpg"), false);
  assert.equal(added.includes("pole-caps.jpg"), false);

  const svg = await getArtifact(undefined, `jobs/${jobId}/files/input.svg`);
  assert.ok(svg && svg.byteLength > 0);

  const stripe = await getArtifact(undefined, `jobs/${jobId}/files/out-00.jpg`);
  assert.equal(stripe, null);

  const job = await getJob(undefined, jobId);
  assert.ok(job?.files?.includes("input.svg"));
  assert.equal(job?.files?.includes("out-00.jpg"), false);

  console.log("hydrate-previews.test.ts: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
