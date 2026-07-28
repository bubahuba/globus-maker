import { degrees, PDFDocument, type PDFImage, type PDFPage } from "pdf-lib";
import { unzipSync } from "fflate";

/** Matches processor print density (pole-to-pole cm × 160 px/cm). */
const PRINT_PX_PER_CM = 160;
const PT_PER_IN = 72;
const CM_PER_IN = 2.54;
/** Gap between the stripe row and the pole-caps sheet (cm). */
const POLE_CAPS_GAP_CM = 0.5;

function pxToPt(px: number): number {
  return (px / PRINT_PX_PER_CM) * (PT_PER_IN / CM_PER_IN);
}

function isStripeName(name: string): boolean {
  return /^out-\d+\.jpe?g$/i.test(name.split("/").pop() ?? "");
}

function isPoleCapsName(name: string): boolean {
  const base = name.split("/").pop() ?? name;
  return /^pole-caps\.jpe?g$/i.test(base);
}

function stripeSortKey(name: string): number {
  const base = name.split("/").pop() ?? name;
  const m = /^out-(\d+)\.jpe?g$/i.exec(base);
  return m ? Number(m[1]) : 0;
}

/** Left→right PDF / preview order: highest index first (matches FE JobOutputs). */
export function orderStripeNamesForPdf(names: string[]): string[] {
  return [...names].filter(isStripeName).sort((a, b) => stripeSortKey(b) - stripeSortKey(a));
}

/**
 * Draw image rotated 90° clockwise.
 * `(x, y)` is the bottom-left of the axis-aligned box after rotation.
 * Returns visual width/height in the same units as x/y/scale.
 */
function drawImageRot90Cw(
  page: PDFPage,
  image: PDFImage,
  x: number,
  y: number,
  scale: number,
): { width: number; height: number } {
  const w = image.width * scale;
  const h = image.height * scale;
  // Pivot at bottom-left of the *unrotated* draw; after −90° the AABB
  // occupies [x, x+h] × [y, y+w].
  page.drawImage(image, {
    x,
    y: y + w,
    width: w,
    height: h,
    rotate: degrees(-90),
  });
  return { width: h, height: w };
}

/**
 * Build a single-page PDF: full-size stripe JPEGs side-by-side (no gaps),
 * then a gap, then pole-caps (rotated 90° CW when wider than tall).
 */
export async function buildGlobeStripesPdf(zipBytes: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const raw = zipBytes instanceof Uint8Array ? zipBytes : new Uint8Array(zipBytes);
  const files = unzipSync(raw);

  const stripeEntries = orderStripeNamesForPdf(Object.keys(files));
  if (stripeEntries.length === 0) {
    throw new Error("Zip has no stripe JPEGs (out-*.jpg)");
  }

  const poleKey = Object.keys(files).find(isPoleCapsName);
  if (!poleKey) {
    throw new Error("Zip has no pole-caps.jpg");
  }

  const pdf = await PDFDocument.create();
  const stripeImages = await Promise.all(
    stripeEntries.map((key) => pdf.embedJpg(files[key]!)),
  );
  const poleImage = await pdf.embedJpg(files[poleKey]!);

  const stripeH = Math.max(...stripeImages.map((img) => img.height));
  const stripesW = stripeImages.reduce((sum, img) => sum + img.width, 0);
  const gapPx = POLE_CAPS_GAP_CM * PRINT_PX_PER_CM;

  const poleW0 = poleImage.width;
  const poleH0 = poleImage.height;
  // Landscape pole-caps sheet → rotate to stand beside tall stripes.
  const rotatePole = poleW0 > poleH0;
  const poleDrawW = rotatePole ? poleH0 : poleW0;
  const poleDrawH = rotatePole ? poleW0 : poleH0;

  const pageWpx = stripesW + gapPx + poleDrawW;
  const pageHpx = Math.max(stripeH, poleDrawH);

  const page = pdf.addPage([pxToPt(pageWpx), pxToPt(pageHpx)]);
  const pageHpt = pxToPt(pageHpx);
  const scale = pxToPt(1); // points per pixel

  let xPx = 0;
  for (const img of stripeImages) {
    const w = pxToPt(img.width);
    const h = pxToPt(img.height);
    page.drawImage(img, {
      x: pxToPt(xPx),
      y: pageHpt - h,
      width: w,
      height: h,
    });
    xPx += img.width;
  }

  const poleLeftPx = xPx + gapPx;
  const poleBottomPt = pageHpt - pxToPt(poleDrawH);
  const poleLeftPt = pxToPt(poleLeftPx);

  if (rotatePole) {
    drawImageRot90Cw(page, poleImage, poleLeftPt, poleBottomPt, scale);
  } else {
    page.drawImage(poleImage, {
      x: poleLeftPt,
      y: poleBottomPt,
      width: pxToPt(poleW0),
      height: pxToPt(poleH0),
    });
  }

  return pdf.save();
}
