/** Same-origin proxy to monitor PHP archive APIs (`MONITOR_ORIGIN` / rgb.sk). */

const IMAGE_NAME_RE = /\.(jpe?g|png|webp)$/i;
const THUMB_NAME_RE = /-thumb\.(jpe?g|png|webp)$/i;

export function isThumbFilename(name: string): boolean {
	return THUMB_NAME_RE.test(name);
}

export function thumbNameFor(filename: string): string {
	return String(filename).replace(IMAGE_NAME_RE, '-thumb.jpg');
}

export function archiveFileUrl(filename: string): string {
	return `/api/globe-preview/${encodeURIComponent(filename)}`;
}

export function sanitizeArchiveName(raw: string): string {
	const base = String(raw || 'globe')
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-zA-Z0-9._-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^[-.]+|[-.]+$/g, '')
		.slice(0, 80);
	const stem = base || 'globe';
	return IMAGE_NAME_RE.test(stem) ? stem : `${stem}.jpg`;
}

export function archiveNameForJob(job: { placeName?: string | null; id?: string | null }): string {
	const place = job.placeName ? String(job.placeName) : 'globe';
	const id = job.id ? String(job.id).slice(0, 12) : String(Date.now());
	return sanitizeArchiveName(`${place}-${id}.jpg`);
}

/** Gallery label: drop extension and trailing job-id / timestamp suffix. */
export function archiveDisplayLabel(filename: string): string {
	const stem = String(filename || '')
		.replace(THUMB_NAME_RE, '')
		.replace(IMAGE_NAME_RE, '');
	const withoutId = stem.replace(/-(?:[0-9a-f]{8}-[0-9a-f]{3}|\d{10,})$/i, '');
	return withoutId || stem || filename;
}

export async function listArchivedPreviews(): Promise<string[]> {
	const response = await fetch(`/api/globe-preview/list?t=${Date.now()}`, {
		cache: 'no-store',
		headers: { Accept: 'application/json, text/plain, */*' }
	});
	if (!response.ok) throw new Error(`Archive list failed (${response.status})`);
	const data: unknown = await response.json();
	if (!Array.isArray(data)) return [];
	return data
		.map((name) => String(name))
		.filter((name) => IMAGE_NAME_RE.test(name))
		.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

async function headExists(filename: string): Promise<boolean> {
	const head = await fetch(archiveFileUrl(filename), { method: 'HEAD', cache: 'no-store' }).catch(
		() => null
	);
	return !!head?.ok;
}

export async function saveArchivedPreview(filename: string, blob: Blob): Promise<boolean> {
	const response = await fetch(
		`/api/globe-preview/save?name=${encodeURIComponent(filename)}`,
		{
			method: 'POST',
			body: blob,
			headers: { 'Content-Type': blob.type || 'image/jpeg' }
		}
	);
	return response.ok || response.status === 201 || response.status === 204;
}

/**
 * Persist equirect texture (+ optional canvas thumb) via monitor PHP save API.
 * Skips work when both files already exist.
 */
export async function archiveLivePreview(opts: {
	filename: string;
	sourceUrl: string;
	captureThumb: () => Promise<Blob | null>;
	knownNames?: string[];
}): Promise<string[]> {
	const { filename, sourceUrl, captureThumb, knownNames = [] } = opts;
	if (!filename || !sourceUrl) return knownNames;

	const thumbName = thumbNameFor(filename);
	const names = new Set(knownNames);
	const hasTexture = names.has(filename) || (await headExists(filename));
	const hasThumb = names.has(thumbName) || (await headExists(thumbName));

	if (hasTexture && hasThumb) {
		names.add(filename);
		names.add(thumbName);
		return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
	}

	if (!hasTexture) {
		const imageRes = await fetch(sourceUrl, { cache: 'no-store' });
		if (!imageRes.ok) return [...names];
		const blob = await imageRes.blob();
		const ok = await saveArchivedPreview(filename, blob);
		if (!ok) return [...names];
		names.add(filename);
	}

	if (!hasThumb) {
		try {
			const thumbBlob = await captureThumb();
			if (thumbBlob) {
				const ok = await saveArchivedPreview(thumbName, thumbBlob);
				if (ok) names.add(thumbName);
			}
		} catch (err) {
			console.warn('Could not capture globe thumb', err);
		}
	}

	return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
