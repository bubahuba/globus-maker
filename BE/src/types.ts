import type { RenderPalette } from "../../shared/map-style";

export type { RenderPalette };

export interface LatLng {
  lat: number;
  lng: number;
}

export type MapLayerKey = "water" | "streets" | "streetNames" | "buildings" | "landForest";

export interface MapLayerSettings {
  enabled: boolean;
  color: string;
}

export type MapLayerStyle = Record<MapLayerKey, MapLayerSettings>;

export interface JobRequest {
  center: LatLng;
  sideMeters: number;
  stripes: number;
  diameterCm: number;
  mapLayers?: MapLayerStyle;
}

export type JobStatus =
  | "queued"
  | "fetching_tiles"
  | "stitching"
  | "projecting"
  | "packaging"
  | "complete"
  | "failed";

export type StepUnit = "tile" | "row" | "stripe" | "file";

export interface JobRecord {
  id: string;
  status: JobStatus;
  progress: number;
  error?: string;
  stripeCount?: number;
  stripeHeightPx?: number;
  stripeWidthPx?: number;
  stepCurrent?: number;
  stepTotal?: number;
  stepUnit?: StepUnit;
  createdAt: string;
  updatedAt: string;
  request: JobRequest;
}

export interface TileCoord {
  x: number;
  y: number;
}

export interface CropBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TileManifest {
  zoom: number;
  tiles: TileCoord[];
  tileCols: number;
  tileRows: number;
  cropBox: CropBox;
  bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
  outputSizePx: number;
  /** Desired stitched map size; processor may upscale via renderScale when native tiles are smaller. */
  targetOutputPx: number;
}

export interface ProcessPayload {
  jobId: string;
  callbackUrl: string;
  manifest: TileManifest;
  stripes: number;
  diameterCm: number;
  stripeHeightPx: number;
  mapLayers: MapLayerStyle;
  mapStyle: Record<string, unknown>;
  renderPalette: RenderPalette;
}

export interface ProgressUpdate {
  status: JobStatus;
  progress: number;
  error?: string;
  stripeCount?: number;
  stepCurrent?: number;
  stepTotal?: number;
  stepUnit?: StepUnit;
}
