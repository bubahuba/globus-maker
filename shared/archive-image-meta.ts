/**
 * Globe-preview archive image metadata.
 *
 * GD re-encodes strip EXIF, so we inject a JPEG COM (comment) segment after save:
 *   `GM1:{"placeName":"…","lat":…,"lng":…,"sideMeters":…}`
 */

export const ARCHIVE_META_PREFIX = 'GM1:';

export type ArchiveImageMeta = {
	placeName?: string;
	lat?: number;
	lng?: number;
	sideMeters?: number;
};

export function archiveMetaFromJob(job: {
	placeName?: string | null;
	center?: { lat?: number | null; lng?: number | null } | null;
	sideMeters?: number | null;
}): ArchiveImageMeta | null {
	const placeName = job.placeName != null ? String(job.placeName).trim() : '';
	const lat = Number(job.center?.lat);
	const lng = Number(job.center?.lng);
	const sideMeters = Number(job.sideMeters);
	const meta: ArchiveImageMeta = {};
	if (placeName) meta.placeName = placeName.slice(0, 120);
	if (Number.isFinite(lat)) meta.lat = lat;
	if (Number.isFinite(lng)) meta.lng = lng;
	if (Number.isFinite(sideMeters) && sideMeters > 0) meta.sideMeters = Math.round(sideMeters);
	return Object.keys(meta).length > 0 ? meta : null;
}

export function serializeArchiveMeta(meta: ArchiveImageMeta | null | undefined): string | null {
	if (!meta) return null;
	const out: ArchiveImageMeta = {};
	if (meta.placeName) out.placeName = String(meta.placeName).trim().slice(0, 120);
	if (meta.lat != null && Number.isFinite(Number(meta.lat))) out.lat = Number(meta.lat);
	if (meta.lng != null && Number.isFinite(Number(meta.lng))) out.lng = Number(meta.lng);
	if (meta.sideMeters != null && Number.isFinite(Number(meta.sideMeters)) && Number(meta.sideMeters) > 0) {
		out.sideMeters = Math.round(Number(meta.sideMeters));
	}
	if (Object.keys(out).length === 0) return null;
	return ARCHIVE_META_PREFIX + JSON.stringify(out);
}

export function parseArchiveMetaComment(text: string): ArchiveImageMeta | null {
	const raw = String(text || '').trim();
	if (!raw.startsWith(ARCHIVE_META_PREFIX)) return null;
	try {
		const data = JSON.parse(raw.slice(ARCHIVE_META_PREFIX.length)) as unknown;
		if (!data || typeof data !== 'object') return null;
		const obj = data as Record<string, unknown>;
		const meta: ArchiveImageMeta = {};
		if (typeof obj.placeName === 'string' && obj.placeName.trim()) {
			meta.placeName = obj.placeName.trim().slice(0, 120);
		}
		const lat = Number(obj.lat);
		const lng = Number(obj.lng);
		const sideMeters = Number(obj.sideMeters);
		if (Number.isFinite(lat)) meta.lat = lat;
		if (Number.isFinite(lng)) meta.lng = lng;
		if (Number.isFinite(sideMeters) && sideMeters > 0) meta.sideMeters = Math.round(sideMeters);
		return Object.keys(meta).length > 0 ? meta : null;
	} catch {
		return null;
	}
}

/** Read first GM1: JPEG COM payload from image bytes. */
export function parseArchiveImageMeta(buffer: ArrayBuffer | Uint8Array): ArchiveImageMeta | null {
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

	let i = 2;
	while (i + 3 < bytes.length) {
		if (bytes[i] !== 0xff) {
			i += 1;
			continue;
		}
		const marker = bytes[i + 1];
		if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS
		if (marker === 0x00 || marker === 0xff) {
			i += 1;
			continue;
		}
		// Standalone markers without length
		if (marker >= 0xd0 && marker <= 0xd7) {
			i += 2;
			continue;
		}
		if (i + 3 >= bytes.length) break;
		const len = (bytes[i + 2] << 8) | bytes[i + 3];
		if (len < 2 || i + 2 + len > bytes.length) break;
		if (marker === 0xfe) {
			const start = i + 4;
			const end = i + 2 + len;
			const text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(
				bytes.subarray(start, end)
			);
			const meta = parseArchiveMetaComment(text.replace(/\0+$/g, ''));
			if (meta) return meta;
		}
		i += 2 + len;
	}
	return null;
}

/** Insert/replace GM1: COM segment right after SOI (before other markers). */
export function injectArchiveImageMeta(
	buffer: ArrayBuffer | Uint8Array,
	meta: ArchiveImageMeta | null | undefined
): Uint8Array {
	const payload = serializeArchiveMeta(meta);
	const src = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	if (!payload || src.length < 2 || src[0] !== 0xff || src[1] !== 0xd8) {
		return src.slice();
	}

	const commentBytes = new TextEncoder().encode(payload);
	if (commentBytes.length > 65533) return src.slice();

	const stripped = stripArchiveMetaComments(src);
	const com = new Uint8Array(4 + commentBytes.length);
	com[0] = 0xff;
	com[1] = 0xfe;
	const segLen = commentBytes.length + 2;
	com[2] = (segLen >> 8) & 0xff;
	com[3] = segLen & 0xff;
	com.set(commentBytes, 4);

	const out = new Uint8Array(stripped.length + com.length);
	out[0] = 0xff;
	out[1] = 0xd8;
	out.set(com, 2);
	out.set(stripped.subarray(2), 2 + com.length);
	return out;
}

function stripArchiveMetaComments(bytes: Uint8Array): Uint8Array {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes.slice();
	const parts: Uint8Array[] = [bytes.subarray(0, 2)];
	let i = 2;
	while (i < bytes.length) {
		if (bytes[i] !== 0xff) {
			parts.push(bytes.subarray(i));
			break;
		}
		if (i + 1 >= bytes.length) {
			parts.push(bytes.subarray(i));
			break;
		}
		const marker = bytes[i + 1];
		if (marker === 0xd9 || marker === 0xda) {
			parts.push(bytes.subarray(i));
			break;
		}
		if (marker === 0x00 || marker === 0xff) {
			parts.push(bytes.subarray(i, i + 1));
			i += 1;
			continue;
		}
		if (marker >= 0xd0 && marker <= 0xd7) {
			parts.push(bytes.subarray(i, i + 2));
			i += 2;
			continue;
		}
		if (i + 3 >= bytes.length) {
			parts.push(bytes.subarray(i));
			break;
		}
		const len = (bytes[i + 2] << 8) | bytes[i + 3];
		if (len < 2 || i + 2 + len > bytes.length) {
			parts.push(bytes.subarray(i));
			break;
		}
		const seg = bytes.subarray(i, i + 2 + len);
		if (marker === 0xfe) {
			const text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(
				seg.subarray(4)
			);
			if (text.replace(/\0+$/g, '').trim().startsWith(ARCHIVE_META_PREFIX)) {
				i += 2 + len;
				continue;
			}
		}
		parts.push(seg);
		i += 2 + len;
	}
	let total = 0;
	for (const p of parts) total += p.length;
	const out = new Uint8Array(total);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

export function archiveMetaQuery(meta: ArchiveImageMeta | null | undefined): string {
	if (!meta) return '';
	const params = new URLSearchParams();
	if (meta.placeName) params.set('placeName', meta.placeName);
	if (meta.lat != null && Number.isFinite(meta.lat)) params.set('lat', String(meta.lat));
	if (meta.lng != null && Number.isFinite(meta.lng)) params.set('lng', String(meta.lng));
	if (meta.sideMeters != null && Number.isFinite(meta.sideMeters)) {
		params.set('sideMeters', String(meta.sideMeters));
	}
	const q = params.toString();
	return q ? `&${q}` : '';
}

export function archiveMetaFromQuery(
	params: URLSearchParams | Record<string, string | null | undefined>
): ArchiveImageMeta | null {
	const get = (key: string): string => {
		if (params instanceof URLSearchParams) return params.get(key) ?? '';
		const v = params[key];
		return v == null ? '' : String(v);
	};
	return archiveMetaFromJob({
		placeName: get('placeName') || null,
		center: {
			lat: get('lat') ? Number(get('lat')) : null,
			lng: get('lng') ? Number(get('lng')) : null
		},
		sideMeters: get('sideMeters') ? Number(get('sideMeters')) : null
	});
}

export function formatArchiveMetaTooltip(meta: ArchiveImageMeta | null | undefined): string {
	if (!meta) return '';
	const lines: string[] = [];
	if (meta.placeName) lines.push(meta.placeName);
	if (meta.lat != null && meta.lng != null) {
		lines.push(`${formatCoord(meta.lat)}, ${formatCoord(meta.lng)}`);
	}
	if (meta.sideMeters != null) {
		lines.push(`${meta.sideMeters.toLocaleString('en-US')} m`);
	}
	return lines.join('\n');
}

function formatCoord(n: number): string {
	const abs = Math.abs(n);
	const digits = abs >= 100 ? 2 : abs >= 10 ? 3 : 4;
	return n.toFixed(digits);
}

export function archiveLabelFromMeta(
	meta: ArchiveImageMeta | null | undefined,
	filenameFallback: string
): string {
	const place = meta?.placeName?.trim();
	return place || filenameFallback;
}

export type RecreateSelectionInput = {
	mode?: 'map' | 'globe';
	placeName?: string | null;
	lat?: number | null;
	lng?: number | null;
	sideMeters?: number | null;
};

/**
 * Query for the home page: `?mode=globe&latlng=lat,lng&sideMeters=…&placeName=…`
 * Prefills mode switch, map pin, and square-size slider.
 */
export function buildRecreateSelectionSearch(input: RecreateSelectionInput): string {
	const params = new URLSearchParams();
	params.set('mode', input.mode === 'map' ? 'map' : 'globe');
	const lat = Number(input.lat);
	const lng = Number(input.lng);
	if (Number.isFinite(lat) && Number.isFinite(lng)) {
		params.set('latlng', `${lat},${lng}`);
	}
	const side = Number(input.sideMeters);
	if (Number.isFinite(side) && side > 0) {
		params.set('sideMeters', String(Math.round(side)));
	}
	const place = input.placeName != null ? String(input.placeName).trim() : '';
	if (place) params.set('placeName', place.slice(0, 120));
	return `?${params.toString()}`;
}

/** Relative (`/…`) or absolute href; null when lat/lng are missing. */
export function recreateSelectionHrefFromMeta(
	meta: ArchiveImageMeta | null | undefined,
	origin = ''
): string | null {
	if (meta?.lat == null || meta?.lng == null) return null;
	if (!Number.isFinite(meta.lat) || !Number.isFinite(meta.lng)) return null;
	const search = buildRecreateSelectionSearch({
		mode: 'globe',
		placeName: meta.placeName,
		lat: meta.lat,
		lng: meta.lng,
		sideMeters: meta.sideMeters
	});
	const base = origin.replace(/\/$/, '');
	return base ? `${base}/${search}` : `/${search}`;
}
