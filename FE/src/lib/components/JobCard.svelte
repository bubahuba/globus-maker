<script lang="ts">
	import {
		downloadJobMapSvg,
		downloadJobZip,
		mapSvgFilenameFromZip,
		withDownloadExtension
	} from '@lib/api/jobs';
	import PaypalCheckoutDialog from '@lib/components/PaypalCheckoutDialog.svelte';
	import type {
		CreateJobResponse,
		GlobeDownloadFormat,
		JobMode,
		JobStatus,
		StepUnit
	} from '@lib/types';
	import { clampTileZoom } from '@shared/tile-constants';

	type Manifest = CreateJobResponse['manifest'];

	const statusLabels: Record<JobStatus, string> = {
		queued: 'Queued',
		fetching_tiles: 'Rendering map tiles',
		stitching: 'Stitching map image',
		projecting: 'Cutting globe stripes',
		packaging: 'Packaging download',
		complete: 'Complete',
		failed: 'Failed'
	};

	const stepUnitLabels: Record<StepUnit, string> = {
		tile: 'tiles',
		row: 'rows',
		stripe: 'stripes',
		file: 'files'
	};

	const stepUnitVerbs: Record<StepUnit, string> = {
		tile: 'Rendered',
		row: 'Stitched',
		stripe: 'Cut',
		file: 'Packed'
	};

	interface ProcessingStep {
		status: JobStatus;
		label: string;
	}

	interface Props {
		jobId?: string | null;
		status: JobStatus;
		progress: number;
		manifest: Manifest;
		mode?: JobMode;
		stripeCount: number;
		error?: string | null;
		stepCurrent?: number;
		stepTotal?: number;
		stepUnit?: StepUnit;
		queuePosition?: number;
		queueLength?: number;
		downloadFilename?: string | null;
		/** Globe paid download packaging (zip default). */
		globeDownloadFormat?: GlobeDownloadFormat;
		/** Globe diameter used for PayPal price (€2 at 20 cm → €6 at 60 cm). */
		diameterCm?: number;
		/** False after zip was downloaded or server TTL purged files. */
		artifactsAvailable?: boolean;
		/** Globe zip unlocked after PayPal capture. */
		paid?: boolean;
		onpaid?: () => void;
		ondownloaded?: () => void;
	}

	let {
		jobId = null,
		status,
		progress,
		manifest,
		mode = 'globe',
		stripeCount,
		error = null,
		stepCurrent,
		stepTotal,
		stepUnit,
		queuePosition,
		queueLength,
		downloadFilename = null,
		globeDownloadFormat = 'zip',
		diameterCm,
		artifactsAvailable = true,
		paid = false,
		onpaid,
		ondownloaded
	}: Props = $props();

	const paidDownloadName = $derived(
		mode === 'globe'
			? withDownloadExtension(downloadFilename, globeDownloadFormat)
			: downloadFilename
	);

	let downloading = $state(false);
	let downloadError = $state<string | null>(null);
	let paypalDialogOpen = $state(false);

	function onDownloadClick() {
		if (!jobId || downloading) return;
		if (mode === 'globe' && !paid) {
			paypalDialogOpen = true;
			return;
		}
		void runDownload();
	}

	async function runDownload() {
		if (!jobId || downloading) return;
		downloading = true;
		downloadError = null;
		try {
			const format = mode === 'globe' ? globeDownloadFormat : 'zip';
			await downloadJobZip(jobId, paidDownloadName, format);
			ondownloaded?.();
		} catch (err) {
			downloadError = err instanceof Error ? err.message : 'Download failed';
		} finally {
			downloading = false;
		}
	}

	async function runPaidDownload() {
		onpaid?.();
		await runDownload();
	}

	/** Free path: stitched map SVG only; leave zip/previews on the server. */
	async function runFreeMapSvgDownload() {
		if (!jobId || downloading) return;
		downloading = true;
		downloadError = null;
		try {
			await downloadJobMapSvg(jobId, mapSvgFilenameFromZip(downloadFilename));
		} catch (err) {
			downloadError = err instanceof Error ? err.message : 'Download failed';
		} finally {
			downloading = false;
		}
	}

	const processingFlow = $derived.by((): JobStatus[] =>
		mode === 'map'
			? ['queued', 'fetching_tiles', 'stitching', 'packaging', 'complete']
			: ['queued', 'fetching_tiles', 'stitching', 'projecting', 'packaging', 'complete']
	);

	const steps = $derived.by((): ProcessingStep[] =>
		mode === 'map'
			? [
					{ status: 'queued', label: 'Queued' },
					{ status: 'fetching_tiles', label: 'Tiles' },
					{ status: 'stitching', label: 'Stitch' },
					{ status: 'packaging', label: 'Package' }
				]
			: [
					{ status: 'queued', label: 'Queued' },
					{ status: 'fetching_tiles', label: 'Tiles' },
					{ status: 'stitching', label: 'Stitch' },
					{ status: 'projecting', label: 'Stripes' },
					{ status: 'packaging', label: 'Package' }
				]
	);

	const isProcessing = $derived(status !== 'complete' && status !== 'failed');

	const stepPercent = $derived.by(() => {
		if (stepCurrent == null || stepTotal == null || stepTotal < 1) return null;
		return Math.min(100, Math.round((stepCurrent / stepTotal) * 100));
	});

	const queueTag = $derived.by(() => {
		if (status !== 'queued') return null;
		if (queuePosition != null && queueLength != null) {
			return `#${queuePosition} of ${queueLength}`;
		}
		if (queuePosition != null) {
			return `#${queuePosition}`;
		}
		return null;
	});

	const stepDetail = $derived.by(() => {
		if (!isProcessing) return null;

		if (status === 'queued') {
			if (queuePosition != null && queuePosition > 1) {
				const ahead = queuePosition - 1;
				return ahead === 1
					? '1 job ahead of you in the processor queue…'
					: `${ahead} jobs ahead of you in the processor queue…`;
			}
			return 'Waiting for the processor to start…';
		}

		if (stepCurrent != null && stepTotal != null && stepUnit) {
			const unit = stepUnitLabels[stepUnit];
			const verb = stepUnitVerbs[stepUnit];

			if (stepCurrent < 1) {
				if (stepUnit === 'tile') {
					const tileCount = Math.floor(stepTotal / 2);
					return `Preparing ${tileCount.toLocaleString()} vector tiles at zoom ${clampTileZoom(manifest.zoom)}…`;
				}
				if (stepUnit === 'row') {
					return `Combining ${stepTotal} tile ${unit} into one map image…`;
				}
				if (stepUnit === 'stripe') {
					return `Projecting map into ${stepTotal} meridian ${unit} (${manifest.stripeWidthPx} × ${manifest.stripeHeightPx} px)…`;
				}
				return `Preparing ${stepTotal} ${unit}…`;
			}

			if (stepUnit === 'tile' && stepTotal > 1) {
				const tileCount = Math.floor(stepTotal / 2);
				const half = tileCount;
				if (stepCurrent <= half) {
					const pct = Math.min(100, Math.round((stepCurrent / half) * 100));
					return `Downloaded ${stepCurrent.toLocaleString()} of ${half.toLocaleString()} tiles (${pct}%)`;
				}
				const rendered = stepCurrent - half;
				const pct = Math.min(100, Math.round((rendered / half) * 100));
				return `Rendered ${rendered.toLocaleString()} of ${half.toLocaleString()} tiles (${pct}%)`;
			}

			return `${verb} ${stepCurrent.toLocaleString()} of ${stepTotal.toLocaleString()} ${unit} (${stepPercent}%)`;
		}

		const fallback: Record<JobStatus, string> = {
			queued: 'Waiting for the processor to start…',
			fetching_tiles: `Rendering ${manifest.tileCount.toLocaleString()} vector tiles at zoom ${clampTileZoom(manifest.zoom)}.`,
			stitching: `Building a ~${manifest.outputSizePx.toLocaleString()} px square map image.`,
			projecting: `Cutting ${stripeCount} stripes for your globe.`,
			packaging:
				mode === 'map'
					? 'Creating the zip with your map.'
					: 'Creating the zip with the map, pole caps, and stripe images.',
			complete: 'Processing finished.',
			failed: 'Processing stopped before completion.'
		};
		return fallback[status];
	});

	function stepState(stepStatus: JobStatus): 'done' | 'active' | 'pending' | 'failed' {
		if (status === 'failed') {
			const failedAt =
				progress >= 85
					? 'packaging'
					: mode === 'globe' && progress >= 60
						? 'projecting'
						: progress >= 50
							? 'stitching'
							: progress >= 10
								? 'fetching_tiles'
								: 'queued';
			const failedIdx = processingFlow.indexOf(failedAt);
			const stepIdx = processingFlow.indexOf(stepStatus);
			if (stepIdx < failedIdx) return 'done';
			if (stepIdx === failedIdx) return 'failed';
			return 'pending';
		}

		const currentStatus = status === 'complete' ? 'complete' : status;
		// Map jobs skip projecting; treat it as stitching if it ever appears.
		const normalized =
			mode === 'map' && currentStatus === 'projecting' ? 'stitching' : currentStatus;
		const currentIdx = processingFlow.indexOf(normalized);
		const stepIdx = processingFlow.indexOf(stepStatus);

		if (stepIdx < currentIdx) return 'done';
		if (stepIdx === currentIdx) return 'active';
		return 'pending';
	}
</script>

<div
	class="rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 shadow-sm"
	id="job-section"
	aria-live="polite"
>
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div class="min-w-0 flex-1">
			<div class="flex flex-wrap items-center gap-2">
				<h2 class="text-sm font-semibold text-stone-900">{statusLabels[status]}</h2>
				{#if status === 'queued' && queueTag}
					<span
						class="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-900 ring-1 ring-sky-200"
					>
						Queue {queueTag}
					</span>
				{:else if status === 'queued'}
					<span
						class="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-900 ring-1 ring-sky-200"
					>
						Waiting
					</span>
				{:else if isProcessing}
					<span
						class="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 ring-1 ring-amber-200"
					>
						{progress}%
					</span>
				{:else if status === 'complete'}
					<span
						class="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200"
					>
						Done
					</span>
				{:else if status === 'failed'}
					<span
						class="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 ring-1 ring-red-200"
					>
						{error === 'Cancelled' ? 'Cancelled' : 'Failed'}
					</span>
				{/if}
			</div>
			{#if stepDetail}
				<p class="mt-1 text-sm text-stone-700">{stepDetail}</p>
			{/if}
			{#if status === 'queued'}
				<p class="mt-2 rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-950 ring-1 ring-sky-100">
					Keep this tab open while you are in the queue. Closing, reloading, or leaving this page
					removes your job from the processor queue.
				</p>
			{/if}
			<p class="mt-1 font-mono text-[11px] text-stone-500">
				{#if jobId}
					<a href="?job={jobId}" class="underline decoration-stone-300 hover:text-stone-800">
						{jobId}
					</a>
				{:else}
					Starting…
				{/if}
			</p>
		</div>

		{#if status === 'complete' && jobId && artifactsAvailable}
			<button
				type="button"
				onclick={onDownloadClick}
				disabled={downloading}
				class="shrink-0 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-400"
			>
				{downloading ? 'Downloading…' : `Download ${paidDownloadName ?? 'zip'}`}
			</button>
		{:else if status === 'complete' && jobId && !artifactsAvailable}
			<p class="shrink-0 text-sm text-stone-500">Server files removed after download.</p>
		{/if}
	</div>

	{#if downloadError}
		<p class="mt-2 text-sm text-red-700">{downloadError}</p>
	{/if}

	<div class="mt-3 space-y-2">
		<div>
			<div class="mb-1 flex items-center justify-between text-[11px] text-stone-500">
				<span>Overall progress</span>
				<span>{progress}%</span>
			</div>
			<div class="h-2 overflow-hidden rounded-full bg-stone-200">
				<div
					class="h-full rounded-full bg-amber-700 transition-all duration-300"
					style:width="{progress}%"
				></div>
			</div>
		</div>

		{#if isProcessing && stepPercent != null}
			<div>
				<div class="mb-1 flex items-center justify-between text-[11px] text-stone-500">
					<span>Current step</span>
					<span>{stepPercent}%</span>
				</div>
				<div class="h-1.5 overflow-hidden rounded-full bg-stone-200">
					<div
						class="h-full rounded-full bg-amber-500 transition-all duration-300"
						style:width="{stepPercent}%"
					></div>
				</div>
			</div>
		{/if}
	</div>

	{#if isProcessing || status === 'failed'}
		<ol
			class="mt-3 flex flex-wrap gap-2"
			aria-label="Processing steps"
		>
			{#each steps as step (step.status)}
				{@const state = stepState(step.status)}
				<li>
					<span
						class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium {state ===
						'done'
							? 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200'
							: state === 'active'
								? 'bg-amber-100 text-amber-900 ring-1 ring-amber-300'
								: state === 'failed'
									? 'bg-red-100 text-red-800 ring-1 ring-red-200'
									: 'bg-white text-stone-500 ring-1 ring-stone-200'}"
					>
						{#if state === 'done'}
							<span aria-hidden="true">✓</span>
						{:else if state === 'failed'}
							<span aria-hidden="true">!</span>
						{:else if state === 'active'}
							<span class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-700" aria-hidden="true"></span>
						{/if}
						{step.label}
						{#if state === 'active' && step.status === 'queued' && queueTag}
							<span class="text-[10px] opacity-80">{queueTag}</span>
						{:else if state === 'active' && step.status === status && stepCurrent != null && stepTotal != null}
							<span class="text-[10px] opacity-80">{stepCurrent}/{stepTotal}</span>
						{/if}
					</span>
				</li>
			{/each}
		</ol>
	{/if}

	{#if error}
		<p
			class="mt-3 rounded-lg px-3 py-2 text-sm ring-1 {error === 'Cancelled'
				? 'bg-stone-100 text-stone-700 ring-stone-200'
				: 'bg-red-50 text-red-700 ring-red-100'}"
		>
			{error === 'Cancelled'
				? 'Removed from the processor queue (tab closed or cancelled).'
				: error}
		</p>
	{/if}
</div>

{#if mode === 'globe' && jobId && !paid}
	<PaypalCheckoutDialog
		bind:open={paypalDialogOpen}
		{jobId}
		filename={paidDownloadName}
		{diameterCm}
		downloadFormat={globeDownloadFormat}
		ondownload={runPaidDownload}
		onfreeDownload={runFreeMapSvgDownload}
	/>
{/if}
