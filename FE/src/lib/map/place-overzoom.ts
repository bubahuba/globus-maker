/**
 * Suburb/neighbourhood labels are missing from OpenMapTiles at z10, but
 * maplibre-gl-leaflet runs MapLibre at (LeafletZoom − 1). So Leaflet z11 loads
 * z10 tiles and borough names never appear. This module pulls place points from
 * z11 tiles into a GeoJSON source while MapLibre is at z10.
 */

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { PLACE_OVERZOOM_SOURCE } from '@shared/map-style';

const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const PLACE_CLASSES = new Set(['suburb', 'neighbourhood', 'quarter']);
/** MapLibre zoom band where z10 tiles lack suburbs but the UI is “zoom 11”. */
const OVERZOOM_ML_ZOOM = 10;
const FETCH_TILE_ZOOM = 11;

let tileUrlTemplate: string | null = null;
let inflight: AbortController | null = null;

async function resolveTileUrlTemplate(): Promise<string> {
	if (tileUrlTemplate) return tileUrlTemplate;
	const res = await fetch(TILEJSON_URL);
	if (!res.ok) throw new Error(`TileJSON ${res.status}`);
	const json = (await res.json()) as { tiles?: string[] };
	const template = json.tiles?.[0];
	if (!template) throw new Error('TileJSON missing tiles');
	tileUrlTemplate = template;
	return template;
}

function lngLatToTile(lng: number, lat: number, z: number): { x: number; y: number } {
	const n = 2 ** z;
	const x = Math.floor(((lng + 180) / 360) * n);
	const latRad = (lat * Math.PI) / 180;
	const y = Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n);
	return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

function featureName(props: Record<string, unknown>): string | null {
	for (const key of ['name', 'name:latin', 'name_en', 'name_int']) {
		const value = props[key];
		if (typeof value === 'string' && value.trim()) return value;
	}
	return null;
}

type GeoJsonFeature = {
	type: 'Feature';
	geometry: { type: 'Point'; coordinates: [number, number] };
	properties: { name: string; class: string; rank?: number };
};

async function loadSuburbFeatures(
	template: string,
	bounds: { west: number; south: number; east: number; north: number },
	signal: AbortSignal
): Promise<GeoJsonFeature[]> {
	const z = FETCH_TILE_ZOOM;
	const nw = lngLatToTile(bounds.west, bounds.north, z);
	const se = lngLatToTile(bounds.east, bounds.south, z);
	const features: GeoJsonFeature[] = [];
	const seen = new Set<string>();

	for (let x = nw.x; x <= se.x; x++) {
		for (let y = nw.y; y <= se.y; y++) {
			const url = template
				.replace('{z}', String(z))
				.replace('{x}', String(x))
				.replace('{y}', String(y));
			const res = await fetch(url, { signal });
			if (!res.ok) continue;
			const buf = new Uint8Array(await res.arrayBuffer());
			const tile = new VectorTile(new PbfReader(buf));
			const layer = tile.layers.place;
			if (!layer) continue;
			for (let i = 0; i < layer.length; i++) {
				const feat = layer.feature(i);
				const props = feat.properties as Record<string, unknown>;
				const placeClass = String(props.class ?? '');
				if (!PLACE_CLASSES.has(placeClass)) continue;
				const name = featureName(props);
				if (!name) continue;
				const gj = feat.toGeoJSON(x, y, z);
				if (gj.geometry.type !== 'Point') continue;
				const coordinates = gj.geometry.coordinates as [number, number];
				const key = `${name}|${coordinates[0].toFixed(5)}|${coordinates[1].toFixed(5)}`;
				if (seen.has(key)) continue;
				seen.add(key);
				features.push({
					type: 'Feature',
					geometry: { type: 'Point', coordinates },
					properties: {
						name,
						class: placeClass,
						rank: typeof props.rank === 'number' ? props.rank : undefined
					}
				});
			}
		}
	}
	return features;
}

function emptyCollection() {
	return { type: 'FeatureCollection' as const, features: [] as GeoJsonFeature[] };
}

/** Keep the GeoJSON suburb overlay in sync with the MapLibre view. */
export async function refreshPlaceOverzoom(map: MaplibreMap): Promise<void> {
	const source = map.getSource(PLACE_OVERZOOM_SOURCE) as
		| { setData: (data: unknown) => void }
		| undefined;
	if (!source) return;

	const zoom = map.getZoom();
	const band = Math.floor(zoom + 1e-6);
	if (band !== OVERZOOM_ML_ZOOM) {
		source.setData(emptyCollection());
		return;
	}

	inflight?.abort();
	const ac = new AbortController();
	inflight = ac;

	try {
		const template = await resolveTileUrlTemplate();
		const b = map.getBounds();
		const features = await loadSuburbFeatures(
			template,
			{
				west: b.getWest(),
				south: b.getSouth(),
				east: b.getEast(),
				north: b.getNorth()
			},
			ac.signal
		);
		if (ac.signal.aborted) return;
		source.setData({ type: 'FeatureCollection', features });
	} catch (err) {
		if ((err as { name?: string })?.name === 'AbortError') return;
		console.warn('[place-overzoom]', err);
		source.setData(emptyCollection());
	}
}

export function attachPlaceOverzoom(map: MaplibreMap): () => void {
	let timer: ReturnType<typeof setTimeout> | null = null;
	const schedule = () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			void refreshPlaceOverzoom(map);
		}, 180);
	};

	const onReady = () => {
		schedule();
	};
	if (map.isStyleLoaded()) onReady();
	else map.once('load', onReady);

	map.on('moveend', schedule);
	map.on('zoomend', schedule);
	map.on('styledata', schedule);

	return () => {
		if (timer) clearTimeout(timer);
		inflight?.abort();
		map.off('moveend', schedule);
		map.off('zoomend', schedule);
		map.off('styledata', schedule);
	};
}
