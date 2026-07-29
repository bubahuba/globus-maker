import assert from "node:assert/strict";
import { mergeJobFiles } from "../src/jobs/store";

assert.deepEqual(mergeJobFiles(["input.jpg"], ["pole-caps.jpg"]), [
  "input.jpg",
  "pole-caps.jpg",
]);

assert.deepEqual(
  mergeJobFiles(["out-2.jpg", "input.svg"], undefined, ["out-1.jpg", "input.svg"]),
  ["input.svg", "out-1.jpg", "out-2.jpg"],
);

assert.equal(mergeJobFiles(undefined, []), undefined);
assert.equal(mergeJobFiles(), undefined);

// Stale status.json (no files) + listed R2 objects must restore previews.
assert.deepEqual(mergeJobFiles(undefined, ["input-distorted-preview.jpg", "input.jpg"]), [
  "input.jpg",
  "input-distorted-preview.jpg",
]);

console.log("job-store.mergeJobFiles: ok");
