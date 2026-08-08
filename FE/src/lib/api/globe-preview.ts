/**
 * Archive list/save/meta go through the same-origin Worker proxy.
 * Thumbnail <img> URLs point at the monitor host directly (https://rgb.sk/…).
 */

import {
	archiveLabelFromMeta,
	archiveMetaFromJob,
	archiveMetaQuery,
	buildRecreateSelectionSearch,
	formatArchiveMetaTooltip,
	injectArchiveImageMeta,
	parseArchiveImageMeta,
	recreateSelectionHrefFromMeta,
	type ArchiveImageMeta
} from '@shared/archive-image-meta';

const IMAGE_NAME_RE = /\.(jpe?g|png|webp)$/i;
const THUMB_NAME_RE = /-thumb\.(jpe?g|png|webp)$/i;

/** Monitor host that serves static `/globe-preview/*` JPEGs (same as Worker `MONITOR_ORIGIN`). */
export const MONITOR_ARCHIVE_ORIGIN = 'https://rgb.sk';

export type { ArchiveImageMeta };
export {
	archiveLabelFromMeta,
	archiveMetaFromJob,
	buildRecreateSelectionSearch,
	formatArchiveMetaTooltip,
	recreateSelectionHrefFromMeta
};

export function isThumbFilename(name: string): boolean {
	return THUMB_NAME_RE.test(name);
}

export function thumbNameFor(filename: string): string {
	return String(filename).replace(IMAGE_NAME_RE, '-thumb.jpg');
}

/** Same-origin proxy — use for texture viewer, HEAD, meta fetch, etc. */
export function archiveFileUrl(filename: string): string {
	return `/api/globe-preview/${encodeURIComponent(filename)}`;
}

/** Full URL on rgb.sk for gallery thumbnails (and other static archive files). */
export function archiveDirectFileUrl(filename: string): string {
	const base = MONITOR_ARCHIVE_ORIGIN.replace(/\/$/, '');
	return `${base}/globe-preview/${encodeURIComponent(filename)}`;
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

/** Gallery label fallback: drop extension and trailing job-id / timestamp suffix. */
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

export async function saveArchivedPreview(
	filename: string,
	blob: Blob,
	meta?: ArchiveImageMeta | null
): Promise<boolean> {
	let body: Blob = blob;
	if (meta) {
		try {
			const injected = injectArchiveImageMeta(await blob.arrayBuffer(), meta);
			body = new Blob([Uint8Array.from(injected)], { type: 'image/jpeg' });
		} catch {
			body = blob;
		}
	}
	const response = await fetch(
		`/api/globe-preview/save?name=${encodeURIComponent(filename)}${archiveMetaQuery(meta)}`,
		{
			method: 'POST',
			body,
			headers: { 'Content-Type': 'image/jpeg' }
		}
	);
	return response.ok || response.status === 201 || response.status === 204;
}

/** Read GM1: JPEG COM metadata from an archived image (prefer thumbs). */
export async function fetchArchiveImageMeta(filename: string): Promise<ArchiveImageMeta | null> {
	try {
		const response = await fetch(`${archiveFileUrl(filename)}?meta=1`, { cache: 'no-store' });
		if (!response.ok) return null;
		const buffer = await response.arrayBuffer();
		return parseArchiveImageMeta(buffer);
	} catch {
		return null;
	}
}

/**
 * Load metadata for texture filenames from their `-thumb.jpg` (fallback: texture itself).
 */
export async function loadArchiveMetaMap(
	textureNames: string[],
	knownNames: string[] = textureNames
): Promise<Record<string, ArchiveImageMeta>> {
	const names = new Set(knownNames);
	const entries = await Promise.all(
		textureNames.map(async (name) => {
			const thumb = thumbNameFor(name);
			const source = names.has(thumb) ? thumb : name;
			const meta = await fetchArchiveImageMeta(source);
			return [name, meta] as const;
		})
	);
	const out: Record<string, ArchiveImageMeta> = {};
	for (const [name, meta] of entries) {
		if (meta) out[name] = meta;
	}
	return out;
}

async function fetchArchivedBlob(filename: string): Promise<Blob | null> {
	try {
		const response = await fetch(archiveFileUrl(filename), { cache: 'no-store' });
		if (!response.ok) return null;
		return await response.blob();
	} catch {
		return null;
	}
}

/**
 * Persist equirect texture (+ optional canvas thumb) via monitor PHP save API.
 * Skips when both files exist and already carry GM1 metadata (or no meta to write).
 * If the monitor archived first without meta, re-POSTs with meta from the latest-globe job.
 */
export async function archiveLivePreview(opts: {
	filename: string;
	sourceUrl: string;
	captureThumb: () => Promise<Blob | null>;
	knownNames?: string[];
	meta?: ArchiveImageMeta | null;
}): Promise<string[]> {
	const { filename, sourceUrl, captureThumb, knownNames = [], meta = null } = opts;
	if (!filename || !sourceUrl) return knownNames;

	const thumbName = thumbNameFor(filename);
	const names = new Set(knownNames);
	const hasTexture = names.has(filename) || (await headExists(filename));
	const hasThumb = names.has(thumbName) || (await headExists(thumbName));

	let needsMeta = false;
	if (meta && (hasTexture || hasThumb)) {
		const probe = hasThumb ? thumbName : filename;
		needsMeta = (await fetchArchiveImageMeta(probe)) == null;
	}

	if (hasTexture && hasThumb && !needsMeta) {
		names.add(filename);
		names.add(thumbName);
		return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
	}

	if (!hasTexture || needsMeta) {
		let blob: Blob | null = null;
		if (!hasTexture) {
			const imageRes = await fetch(sourceUrl, { cache: 'no-store' });
			if (imageRes.ok) blob = await imageRes.blob();
		} else {
			blob = await fetchArchivedBlob(filename);
		}
		if (!blob && !hasTexture) return [...names];
		if (blob) {
			const ok = await saveArchivedPreview(filename, blob, meta);
			if (!ok && !hasTexture) return [...names];
			if (ok) names.add(filename);
		}
	} else {
		names.add(filename);
	}

	if (!hasThumb || needsMeta) {
		try {
			let thumbBlob: Blob | null = null;
			if (!hasThumb) {
				thumbBlob = await captureThumb();
			} else {
				thumbBlob = (await captureThumb()) || (await fetchArchivedBlob(thumbName));
			}
			if (thumbBlob) {
				const ok = await saveArchivedPreview(thumbName, thumbBlob, meta);
				if (ok) names.add(thumbName);
			}
		} catch (err) {
			console.warn('Could not capture globe thumb', err);
		}
	} else {
		names.add(thumbName);
	}

	return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
