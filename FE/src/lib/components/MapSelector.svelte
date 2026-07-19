<script lang="ts">
	import { onMount } from 'svelte';
	import {
		createCenterMarker,
		createSquareLayer,
		flyToSelection,
		initMap,
		squareBounds,
		updateMapStyle,
		type MapSelection
	} from '@lib/map/leaflet';
	import type { MapLayerStyle } from '@shared/map-style';

	interface Props {
		center?: { lat: number; lng: number } | null;
		sideMeters?: number;
		mapLayers: MapLayerStyle;
		onchange?: (selection: MapSelection) => void;
	}

	let { center = null, sideMeters = 2500, mapLayers, onchange }: Props = $props();

	let mapEl: HTMLDivElement | undefined = $state();
	let map: import('leaflet').Map | undefined;
	let baseLayer: ReturnType<typeof initMap>['baseLayer'] | undefined;
	let square: import('leaflet').Rectangle | undefined;
	let marker: import('leaflet').Marker | undefined;

	function setCenterAt(lat: number, lng: number, fly = true) {
		if (!map) return;

		if (!marker) {
			marker = createCenterMarker({ lat, lng });
			marker.addTo(map);
			marker.on('drag', () => {
				updateSquare();
			});
		} else {
			marker.setLatLng([lat, lng]);
		}

		if (fly) flyToSelection(map, { lat, lng });
		updateSquare();
	}

	function emitChange() {
		if (!marker) return;
		const latlng = marker.getLatLng();
		onchange?.({
			center: { lat: latlng.lat, lng: latlng.lng },
			sideMeters
		});
	}

	function updateSquare() {
		if (!map || !marker) return;
		const latlng = marker.getLatLng();
		const bounds = squareBounds({ lat: latlng.lat, lng: latlng.lng }, sideMeters);
		if (square) {
			square.setBounds(bounds);
		} else {
			square = createSquareLayer(bounds);
			square.addTo(map);
		}
		emitChange();
	}

	function clearSelection() {
		if (marker) {
			marker.remove();
			marker = undefined;
		}
		if (square) {
			square.remove();
			square = undefined;
		}
	}

	onMount(() => {
		if (!mapEl) return;

		const initialized = initMap(mapEl, center, mapLayers);
		map = initialized.map;
		baseLayer = initialized.baseLayer;
		if (center) setCenterAt(center.lat, center.lng, false);

		map.on('click', (event) => {
			setCenterAt(event.latlng.lat, event.latlng.lng);
		});

		requestAnimationFrame(() => {
			map?.invalidateSize();
			baseLayer?.getMaplibreMap().resize();
		});

		return () => {
			map?.remove();
		};
	});

	$effect(() => {
		sideMeters;
		updateSquare();
	});

	$effect(() => {
		mapLayers;
		if (baseLayer) updateMapStyle(baseLayer, mapLayers);
	});

	$effect(() => {
		if (!map) return;

		if (!center) {
			clearSelection();
			return;
		}

		const current = marker?.getLatLng();
		const changed =
			!current ||
			Math.abs(current.lat - center.lat) > 0.000001 ||
			Math.abs(current.lng - center.lng) > 0.000001;

		if (changed) {
			setCenterAt(center.lat, center.lng);
		}
	});
</script>

<div class="relative h-full w-full z-1">
	<div bind:this={mapEl} class="absolute inset-0"></div>

	{#if !center}
		<div
			class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-stone-900/10 px-6 text-center"
		>
			<p class="rounded-lg bg-white/95 px-4 py-2 text-sm text-stone-700 shadow-sm">
				Search for a place or click the map to select your region
			</p>
		</div>
	{/if}
</div>
