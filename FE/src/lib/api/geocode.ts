export interface GeocodeResult {
	placeId: number;
	displayName: string;
	lat: number;
	lng: number;
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
