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

	let rootEl: HTMLDivElement | undefined = $state();
	let mapEl: HTMLDivElement | undefined = $state();
	let map: import('leaflet').Map | undefined = $state();
	let baseLayer: ReturnType<typeof initMap>['baseLayer'] | undefined = $state();
	let square: import('leaflet').Rectangle | undefined;
	let marker: import('leaflet').Marker | undefined;
	/** Skip re-fitting while the user drags the center marker. */
	let draggingMarker = false;
	let isFullscreen = $state(false);
	/** Assume supported; hide only if the API is clearly missing after mount. */
	let fullscreenSupported = $state(true);

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

	function syncFullscreenState() {
		isFullscreen = document.fullscreenElement === rootEl;
	}

	async function toggleFullscreen() {
		if (!rootEl) return;
		try {
			if (document.fullscreenElement === rootEl) {
				await document.exitFullscreen();
			} else if (typeof rootEl.requestFullscreen === 'function') {
				await rootEl.requestFullscreen();
			}
		} catch {
			// Fullscreen request may be denied by the browser; ignore.
		}
		queueMicrotask(() => {
			map?.invalidateSize();
			baseLayer?.getMaplibreMap().resize();
		});
	}

	onMount(() => {
		if (!mapEl) return;
		const el = mapEl;

		fullscreenSupported =
			!!document.fullscreenEnabled &&
			!!(rootEl && typeof rootEl.requestFullscreen === 'function');
		document.addEventListener('fullscreenchange', syncFullscreenState);
		syncFullscreenState();

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
			// Do not re-fit here — it fights free pan and stalls MapLibre tile loads.
		};
		requestAnimationFrame(resizeMap);

		const ro = new ResizeObserver(() => resizeMap());
		ro.observe(el);

		return () => {
			document.removeEventListener('fullscreenchange', syncFullscreenState);
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

<div
	bind:this={rootEl}
	class="relative z-1 h-full w-full {isFullscreen ? 'bg-stone-900' : 'bg-stone-100'}"
>
	<!-- z-0 isolates Leaflet/MapLibre pane z-indexes so overlays stay clickable -->
	<div bind:this={mapEl} class="absolute inset-0 z-0"></div>

	{#if !center}
		<div
			class="pointer-events-none absolute inset-0 z-[500] flex items-center justify-center rounded-xl bg-stone-900/10 px-6 text-center"
		>
			<p class="rounded-lg bg-white/95 px-4 py-2 text-sm text-stone-700 shadow-sm">
				Search for a place or click the map to select your region
			</p>
		</div>
	{/if}

	{#if fullscreenSupported}
		<div class="pointer-events-none absolute inset-0 z-[1100]">
			<button
				type="button"
				onclick={toggleFullscreen}
				aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
				title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
				class="pointer-events-auto absolute top-3 right-3 flex h-9 w-9 items-center justify-center rounded-lg bg-white text-stone-700 shadow-md ring-1 ring-stone-300 transition hover:bg-stone-50"
			>
				{#if isFullscreen}
					<svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						class="h-4 w-4"
						aria-hidden="true"
					>
						<path d="M8 3v3a2 2 0 0 1-2 2H3" />
						<path d="M21 8h-3a2 2 0 0 1-2-2V3" />
						<path d="M3 16h3a2 2 0 0 1 2 2v3" />
						<path d="M16 21v-3a2 2 0 0 1 2-2h3" />
					</svg>
				{:else}
					<svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						class="h-4 w-4"
						aria-hidden="true"
					>
						<path d="M8 3H5a2 2 0 0 0-2 2v3" />
						<path d="M21 8V5a2 2 0 0 0-2-2h-3" />
						<path d="M3 16v3a2 2 0 0 0 2 2h3" />
						<path d="M16 21h3a2 2 0 0 0 2-2v-3" />
					</svg>
				{/if}
			</button>
		</div>
	{/if}
</div>
