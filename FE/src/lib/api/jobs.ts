import type { CreateJobResponse, EstimateResponse, JobRequest, JobResponse } from '../types';

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

export async function createJob(request: JobRequest): Promise<CreateJobResponse> {
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

export function downloadUrl(jobId: string): string {
	return `/api/jobs/${jobId}/download`;
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

/** Fetch zip, trigger browser save, then resolve (server purges artifacts after download). */
export async function downloadJobZip(jobId: string, filename?: string | null): Promise<void> {
	const response = await fetch(downloadUrl(jobId));
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error || `Download failed (${response.status})`);
	}
	await triggerBrowserDownload(await response.blob(), filename?.trim() || 'globus-stripes.zip');
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
