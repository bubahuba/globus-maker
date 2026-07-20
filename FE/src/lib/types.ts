export interface LatLng {
	lat: number;
	lng: number;
}

export type MapLayerKey = 'water' | 'streets' | 'streetNames' | 'buildings' | 'landForest';

export interface MapLayerSettings {
	enabled: boolean;
	color: string;
}

export type MapLayerStyle = Record<MapLayerKey, MapLayerSettings>;

/** Map = square export only; Globe = prewarp + JPEG stripes via slize.pl. */
export type JobMode = 'map' | 'globe';

/** Artifact format for the square map (Map mode) or forced jpg for Globe stripes. */
export type OutputFormat = 'jpg' | 'svg';

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
	| 'queued'
	| 'fetching_tiles'
	| 'stitching'
	| 'projecting'
	| 'packaging'
	| 'complete'
	| 'failed';

export type StepUnit = 'tile' | 'row' | 'stripe' | 'file';

export interface EstimateResponse {
	zoom: number;
	tileCount: number;
	outputSizePx: number;
	targetOutputPx: number;
	stripeHeightPx: number;
	stripeWidthPx: number;
	bounds: {
		north: number;
		south: number;
		east: number;
		west: number;
	};
}

export interface JobResponse {
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
	/** Previewable filenames ready for GET /api/jobs/:id/files/:name (SVG + preview JPEG). */
	files?: string[];
	/** False after download or TTL purge — zip/previews removed from the server. */
	artifactsAvailable?: boolean;
	/** Bumps when progress/files change — use to cache-bust preview URLs. */
	updatedAt?: string;
	downloadUrl?: string | null;
	downloadFilename?: string | null;
	/** Original request fields (for restoring UI from ?job=). */
	placeName?: string;
	center?: LatLng;
	sideMeters?: number;
	mode?: JobMode;
	squareSidePx?: number;
	stripes?: number;
	diameterCm?: number;
	outputFormat?: OutputFormat;
}

export interface CreateJobResponse {
	jobId: string;
	status: JobStatus;
	manifest: {
		zoom: number;
		tileCount: number;
		outputSizePx: number;
		stripeHeightPx: number;
		stripeWidthPx: number;
	};
}
