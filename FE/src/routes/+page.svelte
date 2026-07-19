<script lang="ts">
	import { tick } from 'svelte';
	import MapSelector from '@lib/components/MapSelector.svelte';
	import MapLayerControls from '@lib/components/MapLayerControls.svelte';
	import PlaceSearch from '@lib/components/PlaceSearch.svelte';
	import JobCard from '@lib/components/JobCard.svelte';
	import { createJob, estimateJob, pollJob } from '@lib/api/jobs';
	import type { GeocodeResult } from '@lib/api/geocode';
	import type {
		CreateJobResponse,
		EstimateResponse,
		JobRequest,
		JobStatus,
		LatLng,
		StepUnit
	} from '@lib/types';
	import { createDefaultMapLayers } from '@shared/map-style';
	import { clampTileZoom, INPUT_SUPERSAMPLE, MAX_SIDE_METERS } from '@shared/tile-constants';

	const MIN_SIDE_METERS = 500;

	function sideToSlider(meters: number): number {
		return (100 * Math.log(meters / MIN_SIDE_METERS)) / Math.log(MAX_SIDE_METERS / MIN_SIDE_METERS);
	}

	function sliderToSide(position: number): number {
		return Math.round(
			MIN_SIDE_METERS * (MAX_SIDE_METERS / MIN_SIDE_METERS) ** (position / 100)
		);
	}

	function formatSideMeters(meters: number): string {
		if (meters >= 1_000_000) return `${(meters / 1_000_000).toFixed(1)} Mm`;
		if (meters >= 10_000) return `${Math.round(meters / 1000).toLocaleString()} km`;
		if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
		return `${meters.toLocaleString()} m`;
	}

	let center = $state<LatLng | null>(null);
	let sideMeters = $state(2500);
	let stripes = $state(12);
	let diameterCm = $state(25);
	let mapLayers = $state(createDefaultMapLayers());

	let estimate = $state<EstimateResponse | null>(null);
	let estimateError = $state<string | null>(null);
	let estimateLoading = $state(false);

	let estimateSeq = 0;
	let estimateTimer: ReturnType<typeof setTimeout> | undefined;

	let jobId = $state<string | null>(null);
	let jobStatus = $state<JobStatus | null>(null);
	let jobProgress = $state(0);
	let jobError = $state<string | null>(null);
	let jobManifest = $state<CreateJobResponse['manifest'] | null>(null);
	let jobStepCurrent = $state<number | undefined>(undefined);
	let jobStepTotal = $state<number | undefined>(undefined);
	let jobStepUnit = $state<StepUnit | undefined>(undefined);
	let submitting = $state(false);

	function estimateToManifest(): CreateJobResponse['manifest'] | null {
		if (!estimate) return null;
		return {
			zoom: clampTileZoom(estimate.zoom),
			tileCount: estimate.tileCount,
			outputSizePx: estimate.targetOutputPx,
			stripeHeightPx: estimate.stripeHeightPx,
			stripeWidthPx: estimate.stripeWidthPx
		};
	}

	async function scrollToJobSection() {
		await tick();
		document.getElementById('job-section')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
	}

	async function refreshEstimate() {
		if (!center) {
			estimate = null;
			estimateError = null;
			estimateLoading = false;
			return;
		}

		const seq = ++estimateSeq;
		const request = currentRequest();
		estimateLoading = true;
		estimateError = null;

		try {
			const result = await estimateJob(request);
			if (seq !== estimateSeq) return;
			estimate = result;
		} catch (error) {
			if (seq !== estimateSeq) return;
			estimate = null;
			estimateError = error instanceof Error ? error.message : 'Could not estimate selection';
		} finally {
			if (seq === estimateSeq) estimateLoading = false;
		}
	}

	function scheduleEstimate() {
		clearTimeout(estimateTimer);
		estimateTimer = setTimeout(() => {
			void refreshEstimate();
		}, 200);
	}

	function currentRequest(): JobRequest {
		return {
			center: center!,
			sideMeters,
			stripes,
			diameterCm,
			mapLayers
		};
	}

	function onSelectionChange(selection: { center: LatLng; sideMeters: number }) {
		center = selection.center;
	}

	function onPlaceSelect(result: GeocodeResult) {
		center = { lat: result.lat, lng: result.lng };
	}

	$effect(() => {
		center?.lat;
		center?.lng;
		sideMeters;
		stripes;
		diameterCm;
		scheduleEstimate();
	});

	async function generateStripes() {
		if (!center) return;

		submitting = true;
		jobError = null;
		jobStatus = 'queued';
		jobProgress = 0;
		jobId = null;
		jobManifest = estimateToManifest();
		jobStepCurrent = undefined;
		jobStepTotal = undefined;
		jobStepUnit = undefined;
		void scrollToJobSection();

		try {
			const created = await createJob(currentRequest());
			jobId = created.jobId;
			jobStatus = created.status;
			jobManifest = created.manifest;

			await pollJob(
				created.jobId,
				(job) => {
					jobStatus = job.status;
					jobProgress = job.progress;
					jobError = job.error ?? null;
					jobStepCurrent = job.stepCurrent;
					jobStepTotal = job.stepTotal;
					jobStepUnit = job.stepUnit;
				},
				400
			);
		} catch (error) {
			jobError = error instanceof Error ? error.message : 'Failed to start job';
			jobStatus = 'failed';
		} finally {
			submitting = false;
		}
	}
</script>

<main class="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-8">
	<header class="space-y-2">
		<p class="text-sm font-medium tracking-wide text-amber-800 uppercase">Globus Maker</p>
		<h1 class="text-3xl font-semibold text-stone-900">Map a region, print globe stripes</h1>
		<p class="max-w-2xl text-stone-600">
			Search for any place or click the map to choose a square region, then download meridian strips
			for your globe.
		</p>
	</header>

	<div class="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
		<section class="space-y-3 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-stone-200">
			<PlaceSearch onselect={onPlaceSelect} />
			<div class="h-[420px] overflow-hidden rounded-xl border border-stone-300 shadow-inner">
				<MapSelector {center} {sideMeters} {mapLayers} onchange={onSelectionChange} />
			</div>

			{#if jobStatus && jobManifest}
				<JobCard
					{jobId}
					status={jobStatus}
					progress={jobProgress}
					manifest={jobManifest}
					stripeCount={stripes}
					error={jobError}
					stepCurrent={jobStepCurrent}
					stepTotal={jobStepTotal}
					stepUnit={jobStepUnit}
				/>
			{/if}


		</section>

		<aside class="space-y-4">
			<div class="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-stone-200">
				<MapLayerControls bind:value={mapLayers} />
			</div>

			<div class="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-stone-200">
				<h2 class="mb-4 text-lg font-medium text-stone-900">Globe settings</h2>

				<label class="mb-4 block space-y-2">
					<span class="text-sm text-stone-600">Square side</span>
					<input
						type="range"
						min="0"
						max="100"
						step="0.5"
						value={sideToSlider(sideMeters)}
						oninput={(event) => {
							sideMeters = sliderToSide(Number(event.currentTarget.value));
						}}
						class="w-full accent-amber-700"
					/>
					<span class="text-sm font-medium text-stone-800">{formatSideMeters(sideMeters)}</span>
					<span class="block text-xs text-stone-400">
						{formatSideMeters(MIN_SIDE_METERS)} – {formatSideMeters(MAX_SIDE_METERS)}
					</span>
				</label>

				<label class="mb-4 block space-y-2">
					<span class="text-sm text-stone-600">Stripes</span>
					<input
						type="number"
						min="4"
						max="36"
						bind:value={stripes}
						class="w-full rounded-lg border border-stone-300 px-3 py-2"
					/>
				</label>

				<label class="mb-4 block space-y-2">
					<span class="text-sm text-stone-600">Globe diameter (cm)</span>
					<input
						type="number"
						min="10"
						max="60"
						step="1"
						bind:value={diameterCm}
						class="w-full rounded-lg border border-stone-300 px-3 py-2"
					/>
				</label>

				<button
					type="button"
					onclick={generateStripes}
					disabled={submitting || !!estimateError || !center}
					class="w-full rounded-xl bg-amber-800 px-4 py-3 text-sm font-semibold text-white transition hover:bg-amber-900 disabled:cursor-not-allowed disabled:bg-stone-300"
				>
					{submitting ? 'Generating…' : center ? 'Generate globe stripes' : 'Select a place first'}
				</button>
			</div>

			<div class="rounded-2xl bg-stone-900 p-5 text-stone-100 shadow-sm">
				<h2 class="mb-3 text-lg font-medium">Preview</h2>
				{#if !center}
					<p class="text-sm text-stone-400">Choose a location to see tile and stripe estimates.</p>
				{:else if estimateError}
					<p class="text-sm text-red-300">{estimateError}</p>
				{:else if estimateLoading && !estimate}
					<p class="text-sm text-stone-400">Calculating…</p>
				{:else if estimate}
					<dl class="space-y-2 text-sm">
						<div class="flex justify-between gap-4">
							<dt class="text-stone-400">Location</dt>
							<dd class="text-right">{center.lat.toFixed(4)}, {center.lng.toFixed(4)}</dd>
						</div>
						<div class="flex justify-between gap-4">
							<dt class="text-stone-400">Tile zoom</dt>
							<dd>{clampTileZoom(estimate.zoom)} (auto)</dd>
						</div>
						<div class="flex justify-between gap-4">
							<dt class="text-stone-400">Tiles</dt>
							<dd>{estimate.tileCount}</dd>
						</div>
						<div class="flex justify-between gap-4">
							<dt class="text-stone-400">Map image</dt>
							<dd>~{estimate.targetOutputPx * INPUT_SUPERSAMPLE}px square</dd>
						</div>
						<div class="flex justify-between gap-4">
							<dt class="text-stone-400">Stripe size</dt>
							<dd>{estimate.stripeWidthPx} × {estimate.stripeHeightPx} px</dd>
						</div>
					</dl>
				{:else}
					<p class="text-sm text-stone-400">Calculating…</p>
				{/if}
			</div>
		</aside>
	</div>
</main>
