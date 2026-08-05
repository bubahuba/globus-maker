import type {
	CreateJobResponse,
	EstimateResponse,
	JobRequest,
	JobResponse,
	LatestGlobeJobResponse
} from '../types';

export class EstimateFailure extends Error {
	maxZoom?: number;

	constructor(message: string, maxZoom?: number) {
		super(message);
		this.name = 'EstimateFailure';
		this.maxZoom = maxZoom;
	}
}

async function parseJson<T>(response: Response): Promise<T> {
	if (!response.ok) {
		if (response.status === 502 || response.status === 503) {
			throw new Error('API server not running — start it with: npm run dev:api');
		}
		const body = await response.json().catch(() => ({ error: response.statusText }));
		throw new Error((body as { error?: string }).error ?? 'Request failed');
	}
	return response.json() as Promise<T>;
}

export async function estimateJob(request: JobRequest): Promise<EstimateResponse> {
	const response = await fetch('/api/estimate', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(request)
	});
	const body = await response.json().catch(() => ({ error: response.statusText }));
	if (!response.ok) {
		if (response.status === 502 || response.status === 503) {
			throw new Error('API server not running — start it with: npm run dev:api');
		}
		throw new EstimateFailure(
			(body as { error?: string }).error ?? 'Could not estimate selection',
			(body as { maxZoom?: number }).maxZoom
		);
	}
	return body as EstimateResponse;
}

export async function createJob(
	request: JobRequest,
	sourceMap?: File | null
): Promise<CreateJobResponse> {
	if (sourceMap) {
		const form = new FormData();
		form.append('request', JSON.stringify(request));
		form.append('sourceMap', sourceMap, sourceMap.name);
		const response = await fetch('/api/jobs', {
			method: 'POST',
			body: form
		});
		return parseJson<CreateJobResponse>(response);
	}

	const response = await fetch('/api/jobs', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(request)
	});
	return parseJson<CreateJobResponse>(response);
}

export async function getJob(jobId: string): Promise<JobResponse> {
	const response = await fetch(`/api/jobs/${jobId}`);
	return parseJson<JobResponse>(response);
}

export async function getLatestGlobe(): Promise<LatestGlobeJobResponse> {
	const response = await fetch('/api/jobs/latest-globe');
	return parseJson<LatestGlobeJobResponse>(response);
}

export function downloadUrl(jobId: string, format: 'zip' | 'pdf' = 'zip'): string {
	if (format === 'zip') return `/api/jobs/${jobId}/download`;
	return `/api/jobs/${jobId}/download?format=${encodeURIComponent(format)}`;
}

async function triggerBrowserDownload(blob: Blob, filename: string): Promise<void> {
	const objectUrl = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = objectUrl;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(objectUrl);
}

/** Prefer Content-Disposition filename from the download response. */
function filenameFromContentDisposition(header: string | null): string | null {
	if (!header) return null;
	const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
	if (utf8?.[1]) {
		try {
			return decodeURIComponent(utf8[1].trim());
		} catch {
			return utf8[1].trim();
		}
	}
	const quoted = /filename="([^"]+)"/i.exec(header);
	if (quoted?.[1]) return quoted[1].trim();
	const plain = /filename=([^;]+)/i.exec(header);
	return plain?.[1]?.trim().replace(/^["']|["']$/g, '') || null;
}

/** Fetch zip/pdf, trigger browser save, then resolve (server purges artifacts after download). */
export async function downloadJobZip(
	jobId: string,
	filename?: string | null,
	format: 'zip' | 'pdf' = 'zip'
): Promise<void> {
	const response = await fetch(downloadUrl(jobId, format));
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error || `Download failed (${response.status})`);
	}
	const fromHeader = filenameFromContentDisposition(response.headers.get('Content-Disposition'));
	const fallback = format === 'pdf' ? 'globus-stripes.pdf' : 'globus-stripes.zip';
	const saveAs = fromHeader || filename?.trim() || fallback;
	await triggerBrowserDownload(await response.blob(), saveAs);
}

/** Swap `.zip` ↔ `.pdf` on a server-provided download basename. */
export function withDownloadExtension(
	filename: string | null | undefined,
	format: 'zip' | 'pdf'
): string | null {
	const name = filename?.trim();
	if (!name) return null;
	const base = name.replace(/\.(zip|pdf)$/i, '');
	return `${base}.${format}`;
}

/** Map SVG filename derived from a globe zip name (`place-25cm.zip` → `place.svg`). */
export function mapSvgFilenameFromZip(zipName?: string | null): string {
	const name = zipName?.trim();
	if (!name) return 'map.svg';
	return name.replace(/-\d+(\.\d+)?cm\.zip$/i, '.svg').replace(/\.zip$/i, '.svg');
}

/**
 * Download the stitched square map SVG only (preview file).
 * Does not hit `/download`, so the server keeps zip + previews.
 */
export async function downloadJobMapSvg(jobId: string, filename?: string | null): Promise<void> {
	const response = await fetch(jobFileUrl(jobId, 'input.svg'));
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error || `Map SVG download failed (${response.status})`);
	}
	await triggerBrowserDownload(
		await response.blob(),
		filename?.trim() || mapSvgFilenameFromZip(null)
	);
}

export function jobFileUrl(jobId: string, filename: string, cacheBust?: string | number): string {
	const base = `/api/jobs/${jobId}/files/${encodeURIComponent(filename)}`;
	if (cacheBust == null || cacheBust === '') return base;
	return `${base}?v=${encodeURIComponent(String(cacheBust))}`;
}

/** Cancel a queued/running job. Uses sendBeacon when possible (tab close). */
export function cancelJob(jobId: string): void {
	const url = `/api/jobs/${jobId}/cancel`;
	try {
		if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
			const ok = navigator.sendBeacon(url, new Blob(['{}'], { type: 'application/json' }));
			if (ok) return;
		}
	} catch {
		// fall through to fetch
	}
	void fetch(url, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' }, keepalive: true });
}

export async function pollJob(
	jobId: string,
	onUpdate: (job: JobResponse) => void,
	intervalMs = 2000
): Promise<JobResponse> {
	for (;;) {
		const job = await getJob(jobId);
		onUpdate(job);
		if (job.status === 'complete' || job.status === 'failed') {
			return job;
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}
