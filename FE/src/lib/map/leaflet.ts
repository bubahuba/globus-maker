import L from 'leaflet';
import '@maplibre/maplibre-gl-leaflet';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png?url';
import markerIcon from 'leaflet/dist/images/marker-icon.png?url';
import markerShadow from 'leaflet/dist/images/marker-shadow.png?url';
import { buildMapStyle, type MapLayerStyle } from '@shared/map-style';
import { SELECTION_ZOOM, WORLD_VIEW, WORLD_ZOOM } from './constants';
import { attachPlaceOverzoom } from './place-overzoom';

export interface MapSelection {
	center: { lat: number; lng: number };
	sideMeters: number;
}

const METERS_PER_DEG_LAT = 111_320;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
	iconRetinaUrl: markerIcon2x,
	iconUrl: markerIcon,
	shadowUrl: markerShadow
});

export function squareBounds(center: { lat: number; lng: number }, sideMeters: number): L.LatLngBounds {
	const half = sideMeters / 2;
	const dLat = half / METERS_PER_DEG_LAT;
	const cosLat = Math.cos((center.lat * Math.PI) / 180);
	const dLng = half / (METERS_PER_DEG_LAT * Math.max(cosLat, 0.01));

	return L.latLngBounds(
		[center.lat - dLat, center.lng - dLng],
		[center.lat + dLat, center.lng + dLng]
	);
}

type MaplibreGlLayer = L.Layer & {
	getMaplibreMap: () => import('maplibre-gl').Map;
};

export function initMap(
	container: HTMLElement,
	center: { lat: number; lng: number } | null,
	mapLayers: MapLayerStyle,
	zoom = center ? SELECTION_ZOOM : WORLD_ZOOM
): { map: L.Map; baseLayer: MaplibreGlLayer } {
	const view = center ?? WORLD_VIEW;
	const map = L.map(container, { zoomControl: true }).setView([view.lat, view.lng], zoom);

	const baseLayer = L.maplibreGL({
		style: buildMapStyle(mapLayers) as import('maplibre-gl').StyleSpecification
	}).addTo(map) as MaplibreGlLayer;

	const glMap = baseLayer.getMaplibreMap();
	const detachOverzoom = attachPlaceOverzoom(glMap);
	map.on('remove', () => detachOverzoom());

	L.control
		.attribution({
			prefix: false
		})
		.addAttribution(
			'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
		)
		.addTo(map);

	return { map, baseLayer };
}

export function updateMapStyle(baseLayer: MaplibreGlLayer, mapLayers: MapLayerStyle): void {
	const map = baseLayer.getMaplibreMap();
	const style = buildMapStyle(mapLayers) as import('maplibre-gl').StyleSpecification;
	const apply = () => {
		// Full replace (not diff): layer id/filter structure changes (e.g. split
		// place labels) are otherwise left half-applied with stale symbol layers.
		// buildMapStyle always emits explicit layout.visibility for toggles.
		map.setStyle(style, { diff: false });
	};
	if (map.isStyleLoaded()) apply();
	else map.once('load', apply);
}

export function createSquareLayer(bounds: L.LatLngBounds): L.Rectangle {
	return L.rectangle(bounds, {
		color: '#c45c26',
		weight: 2,
		fillColor: '#e8a87c',
		fillOpacity: 0.25
	});
}

export function createCenterMarker(center: { lat: number; lng: number }): L.Marker {
	return L.marker([center.lat, center.lng], { draggable: true });
}

export function flyToSelection(map: L.Map, center: { lat: number; lng: number }): void {
	map.flyTo([center.lat, center.lng], Math.max(map.getZoom(), SELECTION_ZOOM));
}
