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
