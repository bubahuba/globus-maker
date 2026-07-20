import type { RenderPalette } from "../../shared/map-style";

export type { RenderPalette };

export interface LatLng {
  lat: number;
  lng: number;
}

export type MapLayerKey =
  | "water"
  | "streets"
  | "streetNames"
  | "buildings"
  | "landForest"
  | "snow"
  | "sand"
  | "rock"
  | "wetland"
  | "rail";

export interface MapLayerSettings {
  enabled: boolean;
  color: string;
}

export type MapLayerStyle = {
  baseFill: MapLayerKey;
  landFill: MapLayerKey;
} & Record<MapLayerKey, MapLayerSettings>;

/** Map = square export; Globe = prewarp + JPEG stripes via slize.pl (+ sphere from input.svg). */
export type JobMode = "map" | "globe";

/** Artifact format for the square map (Map mode) or forced jpg for Globe stripes. */
export type OutputFormat = "jpg" | "svg";

export interface JobRequest {
  center: LatLng;
  sideMeters: number;
  /** Job pipeline mode. Missing/legacy requests are treated as globe. */
  mode?: JobMode;
  /** Map-mode target edge length in pixels (500–10000). */
  squareSidePx?: number;
  /** Globe-mode stripe count (4–36). */
  stripes?: number;
  /** Globe-mode diameter in cm (10–60, one decimal); drives stripe height. */
  diameterCm?: number;
  /** Map mode: jpg|svg. Globe mode: always jpg. */
  outputFormat?: OutputFormat;
  /** Short place label for download naming (e.g. city from geocode). */
  placeName?: string;
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
  /** 1-based place in the processor queue (includes the running job). */
  queuePosition?: number;
  /** Total jobs in the processor line (waiting + running). */
  queueLength?: number;
  /** Previewable filenames uploaded so far (input.jpg/svg, out-00.*, preview JPEG, …). */
  files?: string[];
  /**
   * False after zip download or TTL purge — zip/previews are gone.
   * Undefined/true means artifacts may still be available.
   */
  artifactsAvailable?: boolean;
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
  mode: JobMode;
  stripes: number;
  diameterCm: number;
  stripeHeightPx: number;
  outputFormat: OutputFormat;
  placeName?: string;
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
  queuePosition?: number;
  queueLength?: number;
}
