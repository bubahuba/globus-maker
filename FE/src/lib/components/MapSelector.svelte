<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type { MaplibreGlLayer, MapSelection } from '@lib/map/leaflet';
	import {
		adjustSideMetersBySliderStep,
		adjustSideMetersFromWheel,
		sideToSlider
	} from '@lib/map/selection-size';
	import { MAP_LAYER_KEYS, type MapLayerStyle } from '@shared/map-style';
	import leafletCss from 'leaflet/dist/leaflet.css?url';
	import maplibreCss from 'maplibre-gl/dist/maplibre-gl.css?url';

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
	let baseLayer: MaplibreGlLayer | undefined = $state();
	let square: import('leaflet').Rectangle | undefined;
	let marker: import('leaflet').Marker | undefined;
	/** Skip re-fitting while the user drags the center marker. */
	let draggingMarker = false;
	let isFullscreen = $state(false);
	/** Assume supported; hide only if the API is clearly missing after mount. */
	let fullscreenSupported = $state(true);

	/** Leaflet helpers — loaded only in the browser (Leaflet touches `window` at import). */
	let leaflet: typeof import('@lib/map/leaflet') | undefined;

	function selectionCenter(): { lat: number; lng: number } | null {
		if (marker) {
			const ll = marker.getLatLng();
			return { lat: ll.lat, lng: ll.lng };
		}
		return center;
	}

	function frameSelection(animate: boolean) {
		if (!map || !leaflet || draggingMarker) return;
		const c = selectionCenter();
		if (!c) return;
		leaflet.fitSelectionInView(map, c, sideMeters, { animate });
	}

	/**
	 * @param emit - When false, sync from parent `center` prop without echoing
	 *   onchange (echoing was overwriting a new search pick with the old pin).
	 */
	function setCenterAt(lat: number, lng: number, fly = true, emit = true) {
		if (!map || !leaflet) return;

		if (!marker) {
			marker = leaflet.createCenterMarker({ lat, lng });
			marker.addTo(map);
			marker.on('dragstart', () => {
				draggingMarker = true;
			});
			marker.on('drag', () => {
				updateSquare(true);
			});
			marker.on('dragend', () => {
				draggingMarker = false;
				updateSquare(true);
				frameSelection(true);
			});
		} else {
			marker.setLatLng([lat, lng]);
		}

		updateSquare(emit);
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

	function updateSquare(emit = true) {
		if (!map || !marker || !leaflet) return;
		const latlng = marker.getLatLng();
		const bounds = leaflet.squareBounds({ lat: latlng.lat, lng: latlng.lng }, sideMeters);
		if (square) {
			square.setBounds(bounds);
		} else {
			square = leaflet.createSquareLayer(bounds);
			square.addTo(map);
		}
		if (emit) emitChange();
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

	const canShrinkSide = $derived(sideToSlider(sideMeters) > 0);
	const canGrowSide = $derived(sideToSlider(sideMeters) < 100);

	function nudgeSideMeters(steps: number) {
		const next = adjustSideMetersBySliderStep(sideMeters, steps);
		if (next === sideMeters) return;
		sideMeters = next;
	}

	onMount(() => {
		if (!mapEl) return;
		const el = mapEl;
		let disposed = false;
		let onWheel: ((event: WheelEvent) => void) | undefined;
		let ro: ResizeObserver | undefined;
		let mapInstance: import('leaflet').Map | undefined;

		fullscreenSupported =
			!!document.fullscreenEnabled &&
			!!(rootEl && typeof rootEl.requestFullscreen === 'function');
		document.addEventListener('fullscreenchange', syncFullscreenState);
		syncFullscreenState();

		void (async () => {
			const api = await import('@lib/map/leaflet');
			if (disposed) return;
			leaflet = api;

			const initialized = api.initMap(el, center, mapLayers);
			if (disposed) {
				initialized.map.remove();
				return;
			}
			mapInstance = initialized.map;
			map = initialized.map;
			baseLayer = initialized.baseLayer;
			if (center) setCenterAt(center.lat, center.lng, false, false);

			map.on('click', (event) => {
				setCenterAt(event.latlng.lat, event.latlng.lng, true, true);
			});

			onWheel = (event: WheelEvent) => {
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

			ro = new ResizeObserver(() => resizeMap());
			ro.observe(el);

			if (disposed) {
				el.removeEventListener('wheel', onWheel);
				ro.disconnect();
				mapInstance.remove();
			}
		})();

		return () => {
			disposed = true;
			document.removeEventListener('fullscreenchange', syncFullscreenState);
			if (onWheel) el.removeEventListener('wheel', onWheel);
			ro?.disconnect();
			mapInstance?.remove();
		};
	});

	$effect(() => {
		// Only react to sideMeters — not marker/map reads inside updateSquare/frameSelection.
		sideMeters;
		untrack(() => {
			updateSquare(true);
			frameSelection(false);
		});
	});

	$effect(() => {
		mapLayers.baseFill;
		mapLayers.landFill;
		for (const key of MAP_LAYER_KEYS) {
			mapLayers[key].enabled;
			mapLayers[key].color;
		}
		if (baseLayer && leaflet) leaflet.updateMapStyle(baseLayer, mapLayers);
	});

	$effect(() => {
		if (!map) return;

		if (!center) {
			untrack(() => clearSelection());
			return;
		}

		const lat = center.lat;
		const lng = center.lng;
		const current = untrack(() => marker?.getLatLng());
		const changed =
			!current ||
			Math.abs(current.lat - lat) > 0.000001 ||
			Math.abs(current.lng - lng) > 0.000001;

		if (changed) {
			// Prop → map only. Do not emit or parent search picks get overwritten.
			untrack(() => setCenterAt(lat, lng, true, false));
		}
	});
</script>

<svelte:head>
	<link rel="stylesheet" href={leafletCss} />
	<link rel="stylesheet" href={maplibreCss} />
</svelte:head>

<div
	bind:this={rootEl}
	class="relative z-1 h-full w-full {isFullscreen ? 'bg-black' : 'bg-panel-muted'}"
>
	<!-- z-0 isolates Leaflet/MapLibre pane z-indexes so overlays stay clickable -->
	<div bind:this={mapEl} class="absolute inset-0 z-0"></div>

	{#if !center}
		<div
			class="pointer-events-none absolute inset-0 z-[500] flex items-center justify-center rounded-xl bg-ink/10 px-6 text-center"
		>
			<p class="rounded-lg bg-panel/95 px-4 py-2 text-sm text-ink-secondary shadow-sm">
				Search for a place or click the map to select your region
			</p>
		</div>
	{/if}

	<div
		class="pointer-events-none absolute inset-0 z-[1100] flex flex-col items-end gap-2 p-3"
	>
		{#if fullscreenSupported}
			<button
				type="button"
				onclick={toggleFullscreen}
				aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
				title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
				class="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-lg bg-panel text-ink-secondary shadow-md ring-1 ring-line-strong transition hover:bg-panel-muted"
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
		{/if}

		<button
			type="button"
			onclick={() => nudgeSideMeters(-1)}
			disabled={!canShrinkSide}
			aria-label="Zoom in"
			title="Zoom in"
			class="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-lg bg-panel text-ink-secondary shadow-md ring-1 ring-line-strong transition hover:bg-panel-muted disabled:cursor-not-allowed disabled:opacity-40"
		>
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
				<path d="M12 5v14" />
				<path d="M5 12h14" />
			</svg>
		</button>
		<button
			type="button"
			onclick={() => nudgeSideMeters(1)}
			disabled={!canGrowSide}
			aria-label="Zoom out"
			title="Zoom out"
			class="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-lg bg-panel text-ink-secondary shadow-md ring-1 ring-line-strong transition hover:bg-panel-muted disabled:cursor-not-allowed disabled:opacity-40"
		>
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
				<path d="M5 12h14" />
			</svg>
		</button>
	</div>
</div>
