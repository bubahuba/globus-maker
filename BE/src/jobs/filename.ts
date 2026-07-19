/** Build a filesystem-safe download name: `{place}-{diameterCm}cm.zip`. */
export function stripeZipFilename(placeName: string | undefined, diameterCm: number): string {
  const raw = (placeName ?? "").trim();
  const slug =
    raw
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "globus";
  const cm = Number.isFinite(diameterCm) ? Math.round(diameterCm) : 0;
  return `${slug}-${cm}cm.zip`;
}
