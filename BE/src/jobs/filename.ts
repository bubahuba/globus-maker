/** Build a filesystem-safe place slug for download names. */
function placeSlug(placeName: string | undefined): string {
  const raw = (placeName ?? "").trim();
  return (
    raw
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "globus"
  );
}

/** Globe download: `{place}-{diameterCm}cm.zip` (one decimal when needed). */
export function stripeZipFilename(placeName: string | undefined, diameterCm: number): string {
  const cm = Number.isFinite(diameterCm) ? Math.round(diameterCm * 10) / 10 : 0;
  const label = Number.isInteger(cm) ? String(cm) : cm.toFixed(1);
  return `${placeSlug(placeName)}-${label}cm.zip`;
}

/** Map download: `{place}-{side}px.zip`. */
export function mapZipFilename(placeName: string | undefined, squareSidePx: number): string {
  const px = Number.isFinite(squareSidePx) ? Math.round(squareSidePx) : 0;
  return `${placeSlug(placeName)}-${px}px.zip`;
}

export function jobZipFilename(request: {
  mode?: string;
  placeName?: string;
  diameterCm?: number;
  squareSidePx?: number;
}): string {
  if (request.mode === "map") {
    return mapZipFilename(request.placeName, Number(request.squareSidePx) || 0);
  }
  return stripeZipFilename(request.placeName, Number(request.diameterCm) || 0);
}
