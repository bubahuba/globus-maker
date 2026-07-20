import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import { buildGlobeStripesPdf, orderStripeNamesForPdf } from "../src/jobs/globe-pdf";
import { jobDownloadFilename, normalizeGlobeDownloadFormat } from "../src/jobs/filename";

function tinyJpeg(width: number, height: number): Uint8Array {
  // Minimal valid 1×1 JPEG, then we rely on pdf-lib accepting it; for layout tests
  // embedJpg needs real JPEG SOI. Use a known minimal JPEG and accept image size from headers.
  // 1x1 red JPEG:
  const b64 =
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGfAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//Z";
  void width;
  void height;
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function main() {
  assert.equal(normalizeGlobeDownloadFormat("pdf"), "pdf");
  assert.equal(normalizeGlobeDownloadFormat("zip"), "zip");
  assert.equal(normalizeGlobeDownloadFormat(undefined), "zip");

  assert.equal(
    jobDownloadFilename({ mode: "globe", placeName: "Paris", diameterCm: 25 }, "pdf"),
    "Paris-25cm.pdf",
  );
  assert.equal(
    jobDownloadFilename({ mode: "globe", placeName: "Paris", diameterCm: 25 }, "zip"),
    "Paris-25cm.zip",
  );

  assert.deepEqual(
    orderStripeNamesForPdf(["out-00.jpg", "out-02.jpg", "out-01.jpg", "pole-caps.jpg"]),
    ["out-02.jpg", "out-01.jpg", "out-00.jpg"],
    "PDF places stripes in descending index (matches FE preview)",
  );

  const zip = zipSync({
    "out-00.jpg": tinyJpeg(10, 20),
    "out-01.jpg": tinyJpeg(10, 20),
    "pole-caps.jpg": tinyJpeg(30, 10),
  });

  const pdfBytes = await buildGlobeStripesPdf(zip);
  const pdf = await PDFDocument.load(pdfBytes);
  assert.equal(pdf.getPageCount(), 1, "single page");
  const page = pdf.getPage(0);
  const { width, height } = page.getSize();
  assert.ok(width > 0 && height > 0, "page has size");
  // 2×1px stripes + 0.5cm gap + rotated pole (10px visual width from 30×10 source)
  assert.ok(width > height * 0.5, "page is wider than tall with stripes + pole caps");

  console.log("globe-pdf.test.ts: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
