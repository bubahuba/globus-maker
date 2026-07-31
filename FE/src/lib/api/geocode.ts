export interface GeocodeResult {
	placeId: number;
	displayName: string;
	/** Short label at the requested zoom level (suburb/city/region/…). */
	label?: string;
	lat: number;
	lng: number;
}

/** Prefer API `label`, else first comma-separated segment of display name. */
export function placeLabelFromDisplayName(displayName: string, label?: string): string {
	const fromLabel = label?.trim();
	if (fromLabel) return fromLabel;
	return displayName.split(',')[0]?.trim() || displayName;
}

export async function searchPlaces(query: string): Promise<GeocodeResult[]> {
	const trimmed = query.trim();
	if (trimmed.length < 2) return [];

	const params = new URLSearchParams({ q: trimmed });
	const response = await fetch(`/api/geocode?${params}`);

	if (!response.ok) {
		if (response.status === 502 || response.status === 503) {
			throw new Error('API server not running — start it with: npm run dev:api');
		}
		const body = await response.json().catch(() => ({ error: 'Place search failed' }));
		throw new Error((body as { error?: string }).error ?? 'Place search failed');
	}

	const results = (await response.json()) as GeocodeResult[];
	return results.filter(
		(item) =>
			Number.isFinite(item.lat) &&
			Number.isFinite(item.lng) &&
			typeof item.displayName === 'string'
	);
}

export async function reverseGeocode(
	lat: number,
	lng: number,
	zoom?: number
): Promise<GeocodeResult | null> {
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

	const params = new URLSearchParams({
		lat: String(lat),
		lng: String(lng)
	});
	if (zoom != null && Number.isFinite(zoom)) {
		params.set('zoom', String(Math.round(zoom)));
	}
	const response = await fetch(`/api/reverse-geocode?${params}`);

	if (!response.ok) {
		if (response.status === 502 || response.status === 503) {
			throw new Error('API server not running — start it with: npm run dev:api');
		}
		const body = await response.json().catch(() => ({ error: 'Reverse geocode failed' }));
		throw new Error((body as { error?: string }).error ?? 'Reverse geocode failed');
	}

	const result = (await response.json()) as GeocodeResult | null;
	if (
		!result ||
		!Number.isFinite(result.lat) ||
		!Number.isFinite(result.lng) ||
		typeof result.displayName !== 'string'
	) {
		return null;
	}
	return result;
}
