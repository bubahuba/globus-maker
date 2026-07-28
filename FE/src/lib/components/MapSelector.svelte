<script lang="ts">
	import { onMount } from 'svelte';
	import {
		createCenterMarker,
		createSquareLayer,
		fitSelectionInView,
		initMap,
		squareBounds,
		updateMapStyle,
		type MapSelection
	} from '@lib/map/leaflet';
	import { adjustSideMetersFromWheel } from '@lib/map/selection-size';
	import { MAP_LAYER_KEYS, type MapLayerStyle } from '@shared/map-style';

	interface Props {
		center?: { lat: number; lng: number } | null;
		sideMeters?: number;
		mapLayers: MapLayerStyle;
		onchange?: (selection: MapSelection) => void;
	}

	let {
		center = null,
		sideMeters = $bindable(2500),
		mapLayers,
		onchange
	}: Props = $props();

	let mapEl: HTMLDivElement | undefined = $state();
	let map: import('leaflet').Map | undefined = $state();
	let baseLayer: ReturnType<typeof initMap>['baseLayer'] | undefined = $state();
	let square: import('leaflet').Rectangle | undefined;
	let marker: import('leaflet').Marker | undefined;
	/** Skip re-fitting while the user drags the center marker. */
	let draggingMarker = false;

	function selectionCenter(): { lat: number; lng: number } | null {
		if (marker) {
			const ll = marker.getLatLng();
			return { lat: ll.lat, lng: ll.lng };
		}
		return center;
	}

	function frameSelection(animate: boolean) {
		if (!map || draggingMarker) return;
		const c = selectionCenter();
		if (!c) return;
		fitSelectionInView(map, c, sideMeters, { animate });
	}

	function setCenterAt(lat: number, lng: number, fly = true) {
		if (!map) return;

		if (!marker) {
			marker = createCenterMarker({ lat, lng });
			marker.addTo(map);
			marker.on('dragstart', () => {
				draggingMarker = true;
			});
			marker.on('drag', () => {
				updateSquare();
			});
			marker.on('dragend', () => {
				draggingMarker = false;
				updateSquare();
				frameSelection(true);
			});
		} else {
			marker.setLatLng([lat, lng]);
		}

		updateSquare();
		frameSelection(fly);
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
		const el = mapEl;

		const initialized = initMap(el, center, mapLayers);
		map = initialized.map;
		baseLayer = initialized.baseLayer;
		if (center) setCenterAt(center.lat, center.lng, false);

		map.on('click', (event) => {
			setCenterAt(event.latlng.lat, event.latlng.lng);
		});

		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			const next = adjustSideMetersFromWheel(sideMeters, event.deltaY);
			if (next === sideMeters) return;
			sideMeters = next;
			updateSquare();
			frameSelection(false);
		};
		el.addEventListener('wheel', onWheel, { passive: false });

		const resizeMap = () => {
			map?.invalidateSize();
			baseLayer?.getMaplibreMap().resize();
			frameSelection(false);
		};
		requestAnimationFrame(resizeMap);

		const ro = new ResizeObserver(() => resizeMap());
		ro.observe(el);

		return () => {
			el.removeEventListener('wheel', onWheel);
			ro.disconnect();
			map?.remove();
		};
	});

	$effect(() => {
		sideMeters;
		updateSquare();
		// Instant fit so the range slider feels live while dragging.
		frameSelection(false);
	});

	$effect(() => {
		mapLayers.baseFill;
		mapLayers.landFill;
		for (const key of MAP_LAYER_KEYS) {
			mapLayers[key].enabled;
			mapLayers[key].color;
		}
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

<div class="relative z-1 h-full w-full">
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
