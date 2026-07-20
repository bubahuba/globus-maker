<script lang="ts">
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import MapSelector from '@lib/components/MapSelector.svelte';
	import MapLayerControls from '@lib/components/MapLayerControls.svelte';
	import PlaceSearch from '@lib/components/PlaceSearch.svelte';
	import JobCard from '@lib/components/JobCard.svelte';
	import JobOutputs from '@lib/components/JobOutputs.svelte';
	import { cancelJob, createJob, estimateJob, getJob, pollJob } from '@lib/api/jobs';
	import type { GeocodeResult } from '@lib/api/geocode';
	import type {
		CreateJobResponse,
		EstimateResponse,
		JobMode,
		JobRequest,
		JobResponse,
		JobStatus,
		LatLng,
		OutputFormat,
		StepUnit
	} from '@lib/types';
	import { loadMapLayers, saveMapLayers } from '@lib/map/layers-storage';
	import { getBaseFillColor, getMapCanvasColor } from '@shared/map-style';
	import { clampTileZoom, MAX_SIDE_METERS } from '@shared/tile-constants';

	const MIN_SIDE_METERS = 500;
	const MIN_SQUARE_SIDE_PX = 500;
	const MAX_SQUARE_SIDE_PX = 10000;
	const DEFAULT_SQUARE_SIDE_PX = 4000;

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

	function roundCm1(value: number): number {
		return Math.round(Number(value) * 10) / 10;
	}

	function circumferenceFromDiameter(diameter: number): number {
		return roundCm1(Number(diameter) * Math.PI);
	}

	function diameterFromCircumference(circumference: number): number {
		const next = roundCm1(Number(circumference) / Math.PI);
		if (!Number.isFinite(next)) return diameterCm;
		return Math.min(60, Math.max(10, next));
	}

	let center = $state<LatLng | null>(null);
	let placeName = $state<string | null>(null);
	let sideMeters = $state(2500);
	let mode = $state<JobMode>('map');
	/** Actual mode of the open job (UI `mode` can switch for globe preview). */
	let jobMode = $state<JobMode | null>(null);
	let squareSidePx = $state(DEFAULT_SQUARE_SIDE_PX);
	let stripes = $state(12);
	let diameterCm = $state(25);
	let outputFormat = $state<OutputFormat>('jpg');
	let mapLayers = $state(loadMapLayers());
	let downloadFilename = $state<string | null>(null);

	let estimate = $state<EstimateResponse | null>(null);
	let estimateError = $state<string | null>(null);
	let estimateLoading = $state(false);

	let estimateSeq = 0;
	let estimateTimer: ReturnType<typeof setTimeout> | undefined;

	let jobId = $state<string | null>(null);
	let jobStatus = $state<JobStatus | null>(null);
	let jobProgress = $state(0);
	let jobError = $state<string | null>(null);
	let jobFiles = $state<string[]>([]);
	let artifactsAvailable = $state(true);
	let jobPaid = $state(false);
	let jobUpdatedAt = $state<string | null>(null);
	let jobManifest = $state<CreateJobResponse['manifest'] | null>(null);
	let jobStepCurrent = $state<number | undefined>(undefined);
	let jobStepTotal = $state<number | undefined>(undefined);
	let jobStepUnit = $state<StepUnit | undefined>(undefined);
	let jobQueuePosition = $state<number | undefined>(undefined);
	let jobQueueLength = $state<number | undefined>(undefined);
	let submitting = $state(false);
	let openingJob = $state(false);

	/** Bumps to abort an in-flight poll when switching jobs. */
	let pollEpoch = 0;

	const jobActive = $derived(
		!!jobId && jobStatus != null && jobStatus !== 'complete' && jobStatus !== 'failed'
	);

	const generateButtonLabel = $derived(
		submitting
			? 'Generating…'
			: !center
				? 'Select a place first'
				: mode === 'map'
					? 'Generate map'
					: 'Generate globe stripes'
	);

	function setJobInUrl(id: string | null) {
		const url = new URL(page.url);
		if (id) url.searchParams.set('job', id);
		else url.searchParams.delete('job');
		const next = `${url.pathname}${url.search}${url.hash}`;
		const current = `${page.url.pathname}${page.url.search}${page.url.hash}`;
		if (next === current) return;
		void goto(next, { replaceState: true, keepFocus: true, noScroll: true });
	}

	function applyJobSnapshot(job: JobResponse, options?: { syncMode?: boolean }) {
		jobId = job.id;
		jobStatus = job.status;
		jobProgress = job.progress;
		jobError = job.error ?? null;
		jobStepCurrent = job.stepCurrent;
		jobStepTotal = job.stepTotal;
		jobStepUnit = job.stepUnit;
		jobQueuePosition = job.queuePosition;
		jobQueueLength = job.queueLength;
		jobFiles = job.files ?? [];
		artifactsAvailable = job.artifactsAvailable !== false;
		jobPaid = job.paid === true;
		if (job.updatedAt) jobUpdatedAt = job.updatedAt;
		if (job.downloadFilename) downloadFilename = job.downloadFilename;
		else if (job.status === 'complete' && !artifactsAvailable) downloadFilename = null;

		if (job.mode === 'map' || job.mode === 'globe') {
			jobMode = job.mode;
			// Sync UI mode when opening a job; skip on poll so Map→Globe preview works.
			if (options?.syncMode) mode = job.mode;
		}
		if (job.squareSidePx != null) squareSidePx = job.squareSidePx;
		if (job.stripeCount != null) stripes = job.stripeCount;
		if (job.stripes != null) stripes = job.stripes;
		if (job.diameterCm != null) diameterCm = job.diameterCm;
		if (job.outputFormat === 'jpg' || job.outputFormat === 'svg') outputFormat = job.outputFormat;
		if (job.sideMeters != null) sideMeters = job.sideMeters;
		if (job.center) center = job.center;
		if (job.placeName) placeName = job.placeName;

		if (job.mode === 'map') {
			jobManifest = {
				zoom: estimate?.zoom ?? 14,
				tileCount: estimate?.tileCount ?? 0,
				outputSizePx:
					estimate?.targetOutputPx ?? job.squareSidePx ?? DEFAULT_SQUARE_SIDE_PX,
				stripeHeightPx: 0,
				stripeWidthPx: 0
			};
		} else if (job.stripeHeightPx != null && job.stripeWidthPx != null) {
			jobManifest = {
				zoom: estimate?.zoom ?? 14,
				tileCount: estimate?.tileCount ?? 0,
				outputSizePx: estimate?.targetOutputPx ?? job.stripeHeightPx,
				stripeHeightPx: job.stripeHeightPx,
				stripeWidthPx: job.stripeWidthPx
			};
		}
	}

	async function openJob(id: string, options?: { scroll?: boolean }) {
		const jobKey = id.trim();
		if (!jobKey) return;

		const epoch = ++pollEpoch;
		openingJob = true;
		jobError = null;
		setJobInUrl(jobKey);

		try {
			const job = await getJob(jobKey);
			if (epoch !== pollEpoch) return;
			applyJobSnapshot(job, { syncMode: true });
			if (options?.scroll !== false) {
				if (job.files?.length) void scrollToJobOutputs();
				else void scrollToJobSection();
			}

			if (job.status !== 'complete' && job.status !== 'failed') {
				submitting = true;
				try {
					await pollJob(
						jobKey,
						(update) => {
							if (epoch !== pollEpoch) return;
							const prevFileCount = jobFiles.length;
							applyJobSnapshot(update);
							if (prevFileCount === 0 && (update.files?.length ?? 0) > 0) {
								void scrollToJobOutputs();
							}
						},
						400
					);
				} finally {
					if (epoch === pollEpoch) submitting = false;
				}
			}
		} catch (error) {
			if (epoch !== pollEpoch) return;
			jobId = jobKey;
			jobStatus = 'failed';
			jobError = error instanceof Error ? error.message : 'Job not found';
			jobManifest = jobManifest ?? {
				zoom: 14,
				tileCount: 0,
				outputSizePx: 0,
				stripeHeightPx: 0,
				stripeWidthPx: 0
			};
		} finally {
			if (epoch === pollEpoch) openingJob = false;
		}
	}

	function estimateToManifest(): CreateJobResponse['manifest'] | null {
		if (!estimate) return null;
		return {
			zoom: clampTileZoom(estimate.zoom),
			tileCount: estimate.tileCount,
			outputSizePx: estimate.targetOutputPx,
			stripeHeightPx: mode === 'globe' ? estimate.stripeHeightPx : 0,
			stripeWidthPx: mode === 'globe' ? estimate.stripeWidthPx : 0
		};
	}

	async function scrollToJobSection() {
		await tick();
		document.getElementById('job-section')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
	}

	async function scrollToJobOutputs() {
		await tick();
		document.getElementById('job-outputs')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
		const base: JobRequest = {
			center: center!,
			sideMeters,
			mode,
			...(placeName ? { placeName } : {}),
			mapLayers
		};
		if (mode === 'map') {
			return {
				...base,
				squareSidePx: Math.round(Number(squareSidePx)),
				outputFormat
			};
		}
		return {
			...base,
			stripes: Math.round(Number(stripes)),
			diameterCm: roundCm1(diameterCm),
			outputFormat: 'jpg'
		};
	}

	function onSelectionChange(selection: { center: LatLng; sideMeters: number }) {
		center = selection.center;
	}

	function onPlaceSelect(result: GeocodeResult) {
		center = { lat: result.lat, lng: result.lng };
		placeName = result.displayName.split(',')[0]?.trim() || result.displayName;
	}

	$effect(() => {
		center?.lat;
		center?.lng;
		sideMeters;
		mode;
		if (mode === 'map') {
			squareSidePx;
		} else {
			stripes;
			diameterCm;
		}
		scheduleEstimate();
	});

	$effect(() => {
		saveMapLayers(mapLayers);
	});

	$effect(() => {
		if (!jobActive || !jobId) return;
		const activeJobId = jobId;

		const onPageHide = () => {
			cancelJob(activeJobId);
		};
		const onBeforeUnload = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = '';
		};

		window.addEventListener('pagehide', onPageHide);
		window.addEventListener('beforeunload', onBeforeUnload);
		return () => {
			window.removeEventListener('pagehide', onPageHide);
			window.removeEventListener('beforeunload', onBeforeUnload);
		};
	});

	// Restore job from ?job=<id> (once per distinct id in the URL).
	$effect(() => {
		const fromUrl = page.url.searchParams.get('job')?.trim() ?? '';
		if (!fromUrl || fromUrl === jobId || openingJob || submitting) return;
		void openJob(fromUrl);
	});

	async function generateStripes() {
		if (!center) return;

		if (jobId && jobStatus && jobStatus !== 'complete' && jobStatus !== 'failed') {
			cancelJob(jobId);
		}

		const epoch = ++pollEpoch;
		submitting = true;
		jobError = null;
		jobStatus = 'queued';
		jobProgress = 0;
		jobId = null;
		jobFiles = [];
		jobMode = mode;
		artifactsAvailable = true;
		jobPaid = false;
		jobUpdatedAt = null;
		downloadFilename = null;
		jobManifest = estimateToManifest();
		jobStepCurrent = undefined;
		jobStepTotal = undefined;
		jobStepUnit = undefined;
		jobQueuePosition = undefined;
		jobQueueLength = undefined;
		void scrollToJobSection();

		try {
			const created = await createJob(currentRequest());
			if (epoch !== pollEpoch) return;
			jobId = created.jobId;
			jobStatus = created.status;
			jobManifest = created.manifest;
			setJobInUrl(created.jobId);

			await pollJob(
				created.jobId,
				(job) => {
					if (epoch !== pollEpoch) return;
					const prevFileCount = jobFiles.length;
					applyJobSnapshot(job);
					if (prevFileCount === 0 && (job.files?.length ?? 0) > 0) {
						void scrollToJobOutputs();
					}
				},
				400
			);
		} catch (error) {
			if (epoch !== pollEpoch) return;
			jobError = error instanceof Error ? error.message : 'Failed to start job';
			jobStatus = 'failed';
		} finally {
			if (epoch === pollEpoch) submitting = false;
		}
	}
</script>

<main class="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-8">
	<header class="space-y-2">
		<p class="text-sm font-medium tracking-wide text-amber-800 uppercase">Globus Maker</p>
		<h1 class="text-3xl font-semibold text-stone-900">Map a region, or print globe stripes</h1>
		<p class="max-w-2xl text-stone-600">
			Search for any place or click the map to choose a square region. Export a square map, or
			generate meridian stripes for your globe.
		</p>
	</header>

	<div class="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
		<div class="sticky top-4 self-start">
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
						mode={jobMode ?? mode}
						stripeCount={(jobMode ?? mode) === 'globe' ? stripes : 0}
						error={jobError}
						stepCurrent={jobStepCurrent}
						stepTotal={jobStepTotal}
						stepUnit={jobStepUnit}
						queuePosition={jobQueuePosition}
						queueLength={jobQueueLength}
						{downloadFilename}
						{artifactsAvailable}
						paid={jobPaid}
						onpaid={() => {
							jobPaid = true;
						}}
						ondownloaded={() => {
							artifactsAvailable = false;
							jobPaid = false;
							jobFiles = [];
							downloadFilename = null;
						}}
					/>
				{/if}
			</section>
		</div>

		<aside class="space-y-4">
			<div class="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-stone-200">
				<h2 class="mb-4 text-lg font-medium text-stone-900">Settings</h2>

				<fieldset class="mb-4 space-y-2">
					<legend class="text-sm text-stone-600">Mode</legend>
					<div class="grid grid-cols-2 gap-2">
						<label class="cursor-pointer">
							<input
								type="radio"
								name="jobMode"
								value="map"
								bind:group={mode}
								class="peer sr-only"
							/>
							<span
								class="flex items-center justify-center rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 transition peer-checked:border-amber-800 peer-checked:bg-amber-50 peer-checked:text-amber-900"
							>
								Map
							</span>
						</label>
						<label class="cursor-pointer">
							<input
								type="radio"
								name="jobMode"
								value="globe"
								bind:group={mode}
								class="peer sr-only"
							/>
							<span
								class="flex items-center justify-center rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 transition peer-checked:border-amber-800 peer-checked:bg-amber-50 peer-checked:text-amber-900"
							>
								Globe
							</span>
						</label>
					</div>
				</fieldset>

				<label class="mb-4 block space-y-2">
					<span class="text-sm text-stone-600">Square side map</span>
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

				{#if mode === 'map'}
					<label class="mb-4 block space-y-2">
						<span class="text-sm text-stone-600">Square side output</span>
						<input
							type="range"
							min={MIN_SQUARE_SIDE_PX}
							max={MAX_SQUARE_SIDE_PX}
							step="100"
							bind:value={squareSidePx}
							class="w-full accent-amber-700"
						/>
						<span class="text-sm font-medium text-stone-800"
							>{Math.round(Number(squareSidePx)).toLocaleString()} px</span
						>
						<span class="block text-xs text-stone-400">
							{MIN_SQUARE_SIDE_PX.toLocaleString()} – {MAX_SQUARE_SIDE_PX.toLocaleString()} px
						</span>
					</label>

					<fieldset class="mb-4 space-y-2">
						<legend class="text-sm text-stone-600">Output format</legend>
						<div class="grid grid-cols-2 gap-2">
							<label class="cursor-pointer">
								<input
									type="radio"
									name="outputFormat"
									value="jpg"
									bind:group={outputFormat}
									class="peer sr-only"
								/>
								<span
									class="flex items-center justify-center rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 transition peer-checked:border-amber-800 peer-checked:bg-amber-50 peer-checked:text-amber-900"
								>
									JPEG
								</span>
							</label>
							<label class="cursor-pointer">
								<input
									type="radio"
									name="outputFormat"
									value="svg"
									bind:group={outputFormat}
									class="peer sr-only"
								/>
								<span
									class="flex items-center justify-center rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 transition peer-checked:border-amber-800 peer-checked:bg-amber-50 peer-checked:text-amber-900"
								>
									SVG
								</span>
							</label>
						</div>
					</fieldset>
				{:else}
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
							step="0.1"
							bind:value={diameterCm}
							class="w-full rounded-lg border border-stone-300 px-3 py-2"
						/>
					</label>

					<label class="mb-4 block space-y-2">
						<span class="text-sm text-stone-600">Circumference (cm)</span>
						<input
							type="number"
							min={circumferenceFromDiameter(10)}
							max={circumferenceFromDiameter(60)}
							step="0.1"
							value={circumferenceFromDiameter(diameterCm)}
							oninput={(event) => {
								diameterCm = diameterFromCircumference(
									Number(event.currentTarget.value)
								);
							}}
							class="w-full rounded-lg border border-stone-300 px-3 py-2"
						/>
						<span class="block text-xs text-stone-400">
							π × diameter — informational; editing updates diameter
						</span>
					</label>
				{/if}

				<button
					type="button"
					onclick={generateStripes}
					disabled={submitting || !!estimateError || !center}
					class="w-full rounded-xl bg-amber-800 px-4 py-3 text-sm font-semibold text-white transition hover:bg-amber-900 disabled:cursor-not-allowed disabled:bg-stone-300"
				>
					{generateButtonLabel}
				</button>
			</div>

			<div class="rounded-2xl bg-stone-900 p-5 text-stone-100 shadow-sm">
				<h2 class="mb-3 text-lg font-medium">Preview</h2>
				{#if !center}
					<p class="text-sm text-stone-400">Choose a location to see tile estimates.</p>
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
							<dd>
								~{(mode === 'map'
									? Math.round(Number(squareSidePx))
									: estimate.targetOutputPx
								).toLocaleString()}px square
							</dd>
						</div>
						{#if mode === 'globe'}
							<div class="flex justify-between gap-4">
								<dt class="text-stone-400">Stripe size</dt>
								<dd>{estimate.stripeWidthPx} × {estimate.stripeHeightPx} px</dd>
							</div>
						{/if}
					</dl>
				{:else}
					<p class="text-sm text-stone-400">Calculating…</p>
				{/if}
			</div>

			<div class="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-stone-200">
				<MapLayerControls bind:value={mapLayers} />
			</div>
		</aside>
	</div>

	{#if jobId && (jobStatus === 'stitching' || jobStatus === 'projecting' || jobStatus === 'packaging' || jobStatus === 'complete' || jobFiles.length > 0)}
		<JobOutputs
			jobId={jobId}
			files={jobFiles}
			{mode}
			stripeCount={mode === 'globe' ? stripes : 0}
			status={jobStatus}
			revision={jobUpdatedAt}
			{artifactsAvailable}
			{outputFormat}
			mapCanvasColor={getMapCanvasColor(mapLayers)}
			emptyFillColor={getBaseFillColor(mapLayers)}
			visible={true}
		/>
	{/if}
</main>
