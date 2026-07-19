/** OpenFreeMap vector tiles stop at this zoom level. */
export const VECTOR_TILE_MAX_ZOOM = 14;

/** Max square side length (meters). ~10,000 km supports continent-scale selections. */
export const MAX_SIDE_METERS = 10_000_000;

/** Side length at which auto zoom uses max vector tile detail (zoom 14). */
export const REF_SIDE_METERS = 2500;

/** Render input.jpg at this multiple of stripe height for sharper globe projection. */
export const INPUT_SUPERSAMPLE = 2;

export function clampTileZoom(zoom: number): number {
	return Math.min(VECTOR_TILE_MAX_ZOOM, Math.max(1, Math.round(zoom)));
}
