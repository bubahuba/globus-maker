import {
	MAX_SIDE_METERS,
	REF_SIDE_METERS,
	VECTOR_TILE_MAX_ZOOM,
	clampTileZoom
} from './tile-constants';

const TILE_SIZE = 256;
/** Cap on native tile-cover size when picking zoom (not map export max). */
const MAX_PX = 6000;
const MAX_TILE_COUNT = 400;
const METERS_PER_DEG_LAT = 111_320;

export type ZoomBounds = {
	north: number;
	south: number;
	east: number;
	west: number;
};

export type ZoomLatLng = { lat: number; lng: number };

/** Geographic square bounds for a center + side length (meters). */
export function zoomSquareBounds(center: ZoomLatLng, sideMeters: number): ZoomBounds {
	const half = sideMeters / 2;
	const dLat = half / METERS_PER_DEG_LAT;
	const cosLat = Math.cos((center.lat * Math.PI) / 180);
	const dLng = half / (METERS_PER_DEG_LAT * Math.max(cosLat, 0.01));

	return {
		north: center.lat + dLat,
		south: center.lat - dLat,
		east: center.lng + dLng,
		west: center.lng - dLng
	};
}

export function lngToPixelX(lng: number, zoom: number): number {
	return ((lng + 180) / 360) * TILE_SIZE * 2 ** zoom;
}

export function latToPixelY(lat: number, zoom: number): number {
	const sin = Math.sin((lat * Math.PI) / 180);
	const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
	return y * TILE_SIZE * 2 ** zoom;
}

export function pixelToTile(pixel: number): number {
	return Math.floor(pixel / TILE_SIZE);
}

export function boundsPixelSize(
	bounds: ZoomBounds,
	zoom: number
): { width: number; height: number } {
	const x1 = lngToPixelX(bounds.west, zoom);
	const x2 = lngToPixelX(bounds.east, zoom);
	const y1 = latToPixelY(bounds.north, zoom);
	const y2 = latToPixelY(bounds.south, zoom);
	return {
		width: Math.abs(x2 - x1),
		height: Math.abs(y2 - y1)
	};
}

export function tileCountForBounds(bounds: ZoomBounds, zoom: number): number {
	const xMin = lngToPixelX(bounds.west, zoom);
	const xMax = lngToPixelX(bounds.east, zoom);
	const yMin = latToPixelY(bounds.north, zoom);
	const yMax = latToPixelY(bounds.south, zoom);

	const left = pixelToTile(Math.min(xMin, xMax));
	const right = pixelToTile(Math.max(xMin, xMax));
	const top = pixelToTile(Math.min(yMin, yMax));
	const bottom = pixelToTile(Math.max(yMin, yMax));

	return (right - left + 1) * (bottom - top + 1);
}

export function maxFeasibleZoom(bounds: ZoomBounds): number {
	for (let zoom = VECTOR_TILE_MAX_ZOOM; zoom >= 1; zoom--) {
		const { width, height } = boundsPixelSize(bounds, zoom);
		const size = Math.max(width, height);
		if (size > MAX_PX) continue;
		if (tileCountForBounds(bounds, zoom) <= MAX_TILE_COUNT) return zoom;
	}
	return 1;
}

/** Cap tile zoom by geographic extent — large areas use lower zoom levels. */
export function areaCapZoom(sideMeters: number): number {
	if (sideMeters <= REF_SIDE_METERS) return VECTOR_TILE_MAX_ZOOM;
	return clampTileZoom(VECTOR_TILE_MAX_ZOOM - Math.log2(sideMeters / REF_SIDE_METERS));
}

/**
 * Choose vector-tile zoom closest to targetPx, within area / tile / size caps.
 * Same formula the job estimate and processor use.
 */
export function pickZoom(
	bounds: ZoomBounds,
	targetPx: number,
	sideMeters?: number
): number {
	const side =
		sideMeters ??
		Math.max(
			(bounds.north - bounds.south) * METERS_PER_DEG_LAT,
			(bounds.east - bounds.west) *
				METERS_PER_DEG_LAT *
				Math.cos((((bounds.north + bounds.south) / 2) * Math.PI) / 180)
		);
	const zoomCap = areaCapZoom(side);

	let bestZoom = 1;
	let bestDiff = Number.POSITIVE_INFINITY;

	for (let zoom = 1; zoom <= zoomCap; zoom++) {
		const { width, height } = boundsPixelSize(bounds, zoom);
		const size = Math.max(width, height);
		if (size > MAX_PX) break;

		const tiles = tileCountForBounds(bounds, zoom);
		if (tiles > MAX_TILE_COUNT) continue;

		const diff = Math.abs(size - targetPx);
		if (diff < bestDiff) {
			bestDiff = diff;
			bestZoom = zoom;
		}
	}

	return clampTileZoom(bestZoom);
}

/** Resolve the MVT zoom used for a selection (preview + job). */
export function resolveZoom(center: ZoomLatLng, sideMeters: number, targetPx: number): number {
	if (!Number.isFinite(sideMeters) || sideMeters <= 0 || sideMeters > MAX_SIDE_METERS) {
		return VECTOR_TILE_MAX_ZOOM;
	}
	if (!Number.isFinite(targetPx) || targetPx <= 0) {
		return areaCapZoom(sideMeters);
	}
	const bounds = zoomSquareBounds(center, sideMeters);
	return pickZoom(bounds, targetPx, sideMeters);
}
