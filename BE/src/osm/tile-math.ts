import type { JobMode, JobRequest, LatLng, TileCoord, TileManifest } from "../types";
import {
  MAX_SIDE_METERS,
  REF_SIDE_METERS,
  VECTOR_TILE_MAX_ZOOM,
  clampTileZoom,
} from "../../../shared/tile-constants";

const TILE_SIZE = 256;
const TARGET_PX = 4500;
/** Cap on native tile-cover size when picking zoom (not map export max). */
const MAX_PX = 6000;
const MIN_SQUARE_SIDE_PX = 500;
/** Map-mode square export edge max (may upscale beyond native tile size). */
const MAX_SQUARE_SIDE_PX = 10000;
const MAX_TILE_COUNT = 400;
const METERS_PER_DEG_LAT = 111_320;

export { MIN_SQUARE_SIDE_PX, MAX_SQUARE_SIDE_PX };

export function normalizeJobMode(mode: unknown): JobMode {
  return mode === "map" ? "map" : "globe";
}

export function stripeHeightPx(diameterCm: number): number {
  return Math.round(diameterCm * 160);
}

export function stripeWidthPx(stripeHeightPx: number, stripes: number): number {
  const dx = 0.09 * (12 / stripes);
  return Math.round(2 * dx * stripeHeightPx);
}

export function squareBounds(center: LatLng, sideMeters: number) {
  const half = sideMeters / 2;
  const dLat = half / METERS_PER_DEG_LAT;
  const cosLat = Math.cos((center.lat * Math.PI) / 180);
  const dLng = half / (METERS_PER_DEG_LAT * Math.max(cosLat, 0.01));

  return {
    north: center.lat + dLat,
    south: center.lat - dLat,
    east: center.lng + dLng,
    west: center.lng - dLng,
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
  bounds: { north: number; south: number; east: number; west: number },
  zoom: number,
): { width: number; height: number } {
  const x1 = lngToPixelX(bounds.west, zoom);
  const x2 = lngToPixelX(bounds.east, zoom);
  const y1 = latToPixelY(bounds.north, zoom);
  const y2 = latToPixelY(bounds.south, zoom);
  return {
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

export function tileCountForBounds(
  bounds: { north: number; south: number; east: number; west: number },
  zoom: number,
): number {
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

export function maxFeasibleZoom(
  bounds: { north: number; south: number; east: number; west: number },
): number {
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

export function pickZoom(
  bounds: ReturnType<typeof squareBounds>,
  targetPx = TARGET_PX,
  sideMeters?: number,
): number {
  const side =
    sideMeters ??
    Math.max(
      (bounds.north - bounds.south) * METERS_PER_DEG_LAT,
      (bounds.east - bounds.west) *
        METERS_PER_DEG_LAT *
        Math.cos((((bounds.north + bounds.south) / 2) * Math.PI) / 180),
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

/** Resolve the pixel target used for zoom + manifest (map squareSidePx or globe stripe height). */
export function resolveTargetOutputPx(input: {
  mode?: JobMode | string;
  squareSidePx?: number;
  diameterCm?: number;
}): number {
  const mode = normalizeJobMode(input.mode);
  if (mode === "map") {
    const px = Number(input.squareSidePx);
    if (Number.isFinite(px)) return Math.round(px);
    return TARGET_PX;
  }
  const diameter = Number(input.diameterCm);
  if (Number.isFinite(diameter)) return stripeHeightPx(diameter);
  return TARGET_PX;
}

export function buildTileManifest(
  center: LatLng,
  sideMeters: number,
  options?: { zoom?: number; diameterCm?: number; targetOutputPx?: number },
): TileManifest {
  if (sideMeters <= 0 || sideMeters > MAX_SIDE_METERS) {
    throw new Error(`sideMeters must be between 1 and ${MAX_SIDE_METERS}`);
  }

  const bounds = squareBounds(center, sideMeters);
  const targetPx =
    options?.targetOutputPx != null
      ? options.targetOutputPx
      : options?.diameterCm != null
        ? stripeHeightPx(options.diameterCm)
        : TARGET_PX;
  const zoom = clampTileZoom(options?.zoom ?? pickZoom(bounds, targetPx, sideMeters));
  const xMin = lngToPixelX(bounds.west, zoom);
  const xMax = lngToPixelX(bounds.east, zoom);
  const yMin = latToPixelY(bounds.north, zoom);
  const yMax = latToPixelY(bounds.south, zoom);

  const left = pixelToTile(Math.min(xMin, xMax));
  const right = pixelToTile(Math.max(xMin, xMax));
  const top = pixelToTile(Math.min(yMin, yMax));
  const bottom = pixelToTile(Math.max(yMin, yMax));

  const tileCols = right - left + 1;
  const tileRows = bottom - top + 1;
  const tileCount = tileCols * tileRows;

  if (tileCount > MAX_TILE_COUNT) {
    throw new Error(
      `Selection requires ${tileCount} tiles at zoom ${zoom}; max is ${MAX_TILE_COUNT}. Reduce area or move to a smaller region.`,
    );
  }

  const tiles: TileCoord[] = [];
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      tiles.push({ x, y });
    }
  }

  const canvasWidth = tileCols * TILE_SIZE;
  const canvasHeight = tileRows * TILE_SIZE;
  const cropLeft = Math.max(0, Math.round(Math.min(xMin, xMax) - left * TILE_SIZE));
  const cropTop = Math.max(0, Math.round(Math.min(yMin, yMax) - top * TILE_SIZE));
  const cropWidth = Math.round(Math.abs(xMax - xMin));
  const cropHeight = Math.round(Math.abs(yMax - yMin));
  const outputSizePx = Math.max(cropWidth, cropHeight);

  return {
    zoom,
    tiles,
    tileCols,
    tileRows,
    cropBox: {
      left: cropLeft,
      top: cropTop,
      width: Math.min(cropWidth, canvasWidth - cropLeft),
      height: Math.min(cropHeight, canvasHeight - cropTop),
    },
    bounds,
    outputSizePx,
    targetOutputPx: Math.max(outputSizePx, targetPx),
  };
}

export function resolveZoom(center: LatLng, sideMeters: number, targetPx: number): number {
  const bounds = squareBounds(center, sideMeters);
  return pickZoom(bounds, targetPx, sideMeters);
}

/** @deprecated Prefer resolveZoom(center, sideMeters, targetPx). Kept for call sites using diameter. */
export function resolveZoomFromDiameter(
  center: LatLng,
  sideMeters: number,
  diameterCm: number,
): number {
  return resolveZoom(center, sideMeters, stripeHeightPx(diameterCm));
}

export function validateJobInput(input: JobRequest): string | null {
  if (!Number.isFinite(input.center.lat) || input.center.lat < -85 || input.center.lat > 85) {
    return "Invalid latitude";
  }
  if (!Number.isFinite(input.center.lng) || input.center.lng < -180 || input.center.lng > 180) {
    return "Invalid longitude";
  }
  if (!Number.isFinite(input.sideMeters) || input.sideMeters < 100 || input.sideMeters > MAX_SIDE_METERS) {
    return `sideMeters must be between 100 and ${MAX_SIDE_METERS}`;
  }

  const mode = normalizeJobMode(input.mode);
  if (input.mode != null && input.mode !== "map" && input.mode !== "globe") {
    return "mode must be map or globe";
  }

  if (
    input.outputFormat != null &&
    input.outputFormat !== "jpg" &&
    input.outputFormat !== "svg"
  ) {
    return "outputFormat must be jpg or svg";
  }

  if (mode === "map") {
    const squareSidePx = Math.round(Number(input.squareSidePx));
    if (
      !Number.isFinite(squareSidePx) ||
      squareSidePx < MIN_SQUARE_SIDE_PX ||
      squareSidePx > MAX_SQUARE_SIDE_PX
    ) {
      return `squareSidePx must be an integer between ${MIN_SQUARE_SIDE_PX} and ${MAX_SQUARE_SIDE_PX}`;
    }
    try {
      buildTileManifest(input.center, input.sideMeters, { targetOutputPx: squareSidePx });
    } catch (error) {
      return error instanceof Error ? error.message : "Invalid map selection";
    }
    return null;
  }

  // Globe mode — coerce HTML/JSON number inputs (may arrive as strings).
  const stripes = Math.round(Number(input.stripes));
  if (!Number.isFinite(stripes) || stripes < 4 || stripes > 36) {
    return "stripes must be an integer between 4 and 36";
  }
  const diameterCm = Number(input.diameterCm);
  if (!Number.isFinite(diameterCm) || diameterCm < 10 || diameterCm > 60) {
    return "diameterCm must be between 10 and 60";
  }
  if (input.outputFormat === "svg") {
    return "Globe mode only supports JPEG stripe output";
  }
  try {
    buildTileManifest(input.center, input.sideMeters, { diameterCm });
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid map selection";
  }
  return null;
}
