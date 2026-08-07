/**
 * Browser copy of shared/archive-image-meta.ts for static monitor deploy (rgb.sk).
 * Keep in sync when changing the GM1: JPEG COM payload shape.
 */

export const ARCHIVE_META_PREFIX = 'GM1:';

export function archiveMetaFromJob(job) {
	const placeName = job?.placeName != null ? String(job.placeName).trim() : '';
	const lat = Number(job?.center?.lat);
	const lng = Number(job?.center?.lng);
	const sideMeters = Number(job?.sideMeters);
	const meta = {};
	if (placeName) meta.placeName = placeName.slice(0, 120);
	if (Number.isFinite(lat)) meta.lat = lat;
	if (Number.isFinite(lng)) meta.lng = lng;
	if (Number.isFinite(sideMeters) && sideMeters > 0) meta.sideMeters = Math.round(sideMeters);
	return Object.keys(meta).length > 0 ? meta : null;
}

export function archiveMetaQuery(meta) {
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

export function parseArchiveMetaComment(text) {
	const raw = String(text || '').trim();
	if (!raw.startsWith(ARCHIVE_META_PREFIX)) return null;
	try {
		const data = JSON.parse(raw.slice(ARCHIVE_META_PREFIX.length));
		if (!data || typeof data !== 'object') return null;
		const meta = {};
		if (typeof data.placeName === 'string' && data.placeName.trim()) {
			meta.placeName = data.placeName.trim().slice(0, 120);
		}
		const lat = Number(data.lat);
		const lng = Number(data.lng);
		const sideMeters = Number(data.sideMeters);
		if (Number.isFinite(lat)) meta.lat = lat;
		if (Number.isFinite(lng)) meta.lng = lng;
		if (Number.isFinite(sideMeters) && sideMeters > 0) meta.sideMeters = Math.round(sideMeters);
		return Object.keys(meta).length > 0 ? meta : null;
	} catch {
		return null;
	}
}

export function parseArchiveImageMeta(buffer) {
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

	let i = 2;
	while (i + 3 < bytes.length) {
		if (bytes[i] !== 0xff) {
			i += 1;
			continue;
		}
		const marker = bytes[i + 1];
		if (marker === 0xd9 || marker === 0xda) break;
		if (marker === 0x00 || marker === 0xff) {
			i += 1;
			continue;
		}
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
			const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(start, end));
			const meta = parseArchiveMetaComment(text.replace(/\0+$/g, ''));
			if (meta) return meta;
		}
		i += 2 + len;
	}
	return null;
}

export function formatArchiveMetaTooltip(meta) {
	if (!meta) return '';
	const lines = [];
	if (meta.placeName) lines.push(meta.placeName);
	if (meta.lat != null && meta.lng != null) {
		lines.push(`${formatCoord(meta.lat)}, ${formatCoord(meta.lng)}`);
	}
	if (meta.sideMeters != null) {
		lines.push(`${meta.sideMeters.toLocaleString('en-US')} m`);
	}
	return lines.join('\n');
}

function formatCoord(n) {
	const abs = Math.abs(n);
	const digits = abs >= 100 ? 2 : abs >= 10 ? 3 : 4;
	return n.toFixed(digits);
}

export function archiveLabelFromMeta(meta, filenameFallback) {
	const place = meta?.placeName?.trim();
	return place || filenameFallback;
}
