/** OpenFreeMap vector tiles stop at this zoom level. */
export const VECTOR_TILE_MAX_ZOOM = 14;

/** Max square side length (meters). ~10,000 km supports continent-scale selections. */
export const MAX_SIDE_METERS = 10_000_000;

/** Side length at which auto zoom uses max vector tile detail (zoom 14). */
export const REF_SIDE_METERS = 2500;

/** Render input.jpg at this multiple of stripe height for sharper globe projection. */
export const INPUT_SUPERSAMPLE = 2;

/** Print density for globe stripes and pole caps (px per cm). */
export const PRINT_PX_PER_CM = 160;

export function clampTileZoom(zoom: number): number {
	return Math.min(VECTOR_TILE_MAX_ZOOM, Math.max(1, Math.round(zoom)));
}

function formatCm(value: number): string {
	const rounded = Math.round(value * 10) / 10;
	return rounded % 1 === 0 ? String(Math.round(rounded)) : rounded.toFixed(1);
}

function formatCmFromPx(px: number): string {
	return formatCm(px / PRINT_PX_PER_CM);
}

/** Pole-to-pole strip length on a globe of this diameter (half the circumference). */
export function globeStripeLengthCm(diameterCm: number): number {
	return (Math.PI * diameterCm) / 2;
}

/** Stripe JPEG height in px at {@link PRINT_PX_PER_CM} (pole-to-pole print length). */
export function stripeHeightPx(diameterCm: number): number {
	return Math.round(globeStripeLengthCm(diameterCm) * PRINT_PX_PER_CM);
}

/** Stripe JPEG width in px — same slize.pl geometry as the processor. */
export function stripeWidthPx(stripeHeightPx: number, stripes: number): number {
	const dx = 0.09 * (12 / stripes);
	return Math.round(2 * dx * stripeHeightPx);
}

/** Human-readable print size for a stripe (width × pole-to-pole height). */
export function formatStripePrintSizeCm(widthPx: number, heightPx: number): string | null {
	if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx <= 0 || heightPx <= 0) {
		return null;
	}
	return `${formatCmFromPx(widthPx)} × ${formatCmFromPx(heightPx)} cm`;
}
