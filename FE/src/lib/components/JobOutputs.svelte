<script lang="ts">
	import { jobFileUrl } from '@lib/api/jobs';
	import DistortedPanoramaViewer from '@lib/components/DistortedPanoramaViewer.svelte';
	import type { JobMode, JobStatus, OutputFormat } from '@lib/types';
	import { formatStripePrintSizeCm } from '@shared/tile-constants';

	interface Props {
		jobId: string | null;
		files: string[];
		stripeCount: number;
		/** Stripe JPEG width in px (globe print size at 160 px/cm). */
		stripeWidthPx?: number;
		/** Stripe JPEG height in px (pole-to-pole at 160 px/cm). */
		stripeHeightPx?: number;
		status?: JobStatus | null;
		/** Cache-bust preview URLs when uploads are replaced. */
		revision?: string | null;
		/** False after download/TTL — server deleted preview files. */
		artifactsAvailable?: boolean;
		/** map = square only; globe = stitched map SVG + JPEG stripes. */
		mode?: JobMode | null;
		/** Map-mode format; Globe maps are always SVG. */
		outputFormat?: OutputFormat | null;
		/** SVG / map image letterbox (land canvas). */
		mapCanvasColor?: string | null;
		visible: boolean;
	}

	let {
		jobId,
		files,
		stripeCount,
		stripeWidthPx = 0,
		stripeHeightPx = 0,
		status = null,
		revision = null,
		artifactsAvailable = true,
		mode = null,
		outputFormat = null,
		mapCanvasColor = null,
		visible
	}: Props = $props();

	const effectiveMode = $derived.by((): JobMode => {
		if (mode === 'map' || mode === 'globe') return mode;
		// Prewarped SVG / stripes prove globe; map jobs only ship the square export.
		const lower = files.map((f) => f.toLowerCase());
		if (
			lower.some((f) => /^out-\d+\.jpe?g$/.test(f)) ||
			lower.includes('input-distorted.svg') ||
			lower.includes('input-distorted-preview.jpg') ||
			lower.includes('pole-caps.jpg')
		) {
			return 'globe';
		}
		return 'map';
	});

	const mapSlots = $derived.by(() => {
		// Prefer whatever the job actually produced (upload → input.jpg; OSM stitch → input.svg).
		const lower = files.map((f) => f.toLowerCase());
		const jpgName = lower.find((f) => f === 'input.jpg' || f === 'input.jpeg');
		const hasUploadedSource = lower.some((f) => f.startsWith('source-map.'));
		// If the expected format is missing but the other map file exists (e.g. zip
		// hydrate brought input.jpg while UI still expected svg), show what's available.
		const mapFile = jpgName
			? (files.find((f) => f.toLowerCase() === jpgName) ?? jpgName)
			: lower.includes('input.svg')
				? 'input.svg'
				: hasUploadedSource
					? 'input.jpg'
					: effectiveMode === 'globe' || outputFormat === 'svg'
						? 'input.svg'
						: 'input.jpg';
		return [
			{
				filename: mapFile,
				label: effectiveMode === 'globe' ? 'Your square map' : 'Stitched map'
			}
		] as const;
	});

	const readyMaps = $derived.by(() => {
		const set = new Set(files.map((f) => f.toLowerCase()));
		return mapSlots.map((slot) => ({
			...slot,
			ready: set.has(slot.filename.toLowerCase())
		}));
	});

	/** Globe stripes are always JPEG from slize.pl. */
	const readyStripes = $derived.by(() => {
		if (effectiveMode !== 'globe') return [];
		return files
			.map((filename) => {
				const match = /^out-(\d+)\.jpe?g$/i.exec(filename);
				if (!match) return null;
				return { filename, index: Number(match[1]) };
			})
			.filter((item): item is { filename: string; index: number } => item != null)
			.sort((a, b) => b.index - a.index);
	});

	const spherePreviewFile = $derived(
		effectiveMode === 'globe' &&
			files.some((f) => f.toLowerCase() === 'input-distorted-preview.jpg')
			? 'input-distorted-preview.jpg'
			: null
	);

	const poleCapsFile = $derived(
		effectiveMode === 'globe'
			? (files.find((f) => f.toLowerCase() === 'pole-caps.jpg') ?? null)
			: null
	);

	const stitchedReady = $derived(
		effectiveMode === 'globe' && readyMaps.some((slot) => slot.ready)
	);

	const showPlaceholders = $derived(
		status !== 'complete' && status !== 'packaging' && status !== 'failed'
	);

	const fileSet = $derived(new Set(files.map((f) => f.toLowerCase())));

	/** Only the pipeline step currently running gets the shimmer; others stay static gray. */
	const activePlaceholder = $derived.by(():
		| { kind: 'map'; filename: string }
		| { kind: 'sphere' }
		| { kind: 'pole-caps' }
		| { kind: 'stripe'; index: number }
		| null => {
		if (!showPlaceholders) return null;

		if (effectiveMode === 'map') {
			const mapFile = mapSlots[0]?.filename;
			if (mapFile && !fileSet.has(mapFile.toLowerCase())) {
				return { kind: 'map', filename: mapFile };
			}
			return null;
		}

		// Globe: stitch → sphere → pole caps → stripes (in order).
		const stitchedMapFile = mapSlots[0]?.filename;
		if (stitchedMapFile && !fileSet.has(stitchedMapFile.toLowerCase())) {
			return { kind: 'map', filename: stitchedMapFile };
		}
		if (!fileSet.has('input-distorted-preview.jpg')) {
			return { kind: 'sphere' };
		}
		if (!fileSet.has('pole-caps.jpg')) {
			return { kind: 'pole-caps' };
		}

		const expected = Math.max(0, Number(stripeCount) || 0);
		const maxReady = readyStripes.reduce((max, item) => Math.max(max, item.index), -1);
		const next = maxReady + 1;
		if (expected > 0 && next < expected) {
			return { kind: 'stripe', index: next };
		}
		return null;
	});

	const stripeSlots = $derived.by(() => {
		if (effectiveMode !== 'globe') return [];
		const readyByIndex = new Map(readyStripes.map((item) => [item.index, item.filename]));
		const expected = Math.max(0, Number(stripeCount) || 0);
		const maxReady = readyStripes.reduce((max, item) => Math.max(max, item.index), -1);
		const total = showPlaceholders
			? Math.max(expected, maxReady + 1)
			: Math.max(0, maxReady + 1);

		// Key by stripe index so placeholder → image swaps in place (no column remount).
		const slots: Array<{ key: string; index: number; filename: string | null }> = [];
		for (let i = total - 1; i >= 0; i--) {
			const filename = readyByIndex.get(i) ?? null;
			if (filename || showPlaceholders) {
				slots.push({ key: `stripe-${i}`, index: i, filename });
			}
		}
		return slots;
	});

	const stripeColumns = $derived(Math.max(1, stripeSlots.length || Number(stripeCount) || 1));

	const showPoleCapsSlot = $derived(
		effectiveMode === 'globe' &&
			(Boolean(poleCapsFile) ||
				(showPlaceholders &&
					(fileSet.has('input-distorted-preview.jpg') || stitchedReady)))
	);

	const showPreviews = $derived(artifactsAvailable || files.length > 0);

	function placeholderClass(active: boolean): string {
		return active ? 'loading-shimmer' : 'loading-placeholder';
	}

	const stripePrintSizeCm = $derived(formatStripePrintSizeCm(stripeWidthPx, stripeHeightPx));

	const previewHelperText = $derived(
		effectiveMode === 'map'
			? 'Your map shows up here when it is ready.'
			: 'Files appear as we go — square map, a globe preview, pole caps, then the printable strips.'
	);

	/** Per-filename cache-bust frozen when the file first appears; reset on jobId change. */
	let fileRevisions = $state<Record<string, string>>({});
	let fileRevisionsJobId = $state<string | null>(null);

	let sphereRevision = $state<string | null>(null);
	let sphereRevisionJobId = $state<string | null>(null);

	$effect(() => {
		if (jobId !== fileRevisionsJobId) {
			fileRevisionsJobId = jobId;
			fileRevisions = {};
		}
		if (!revision) return;
		let next: Record<string, string> | null = null;
		for (const filename of files) {
			if (fileRevisions[filename] == null) {
				next ??= { ...fileRevisions };
				next[filename] = revision;
			}
		}
		if (next) fileRevisions = next;
	});

	$effect(() => {
		if (jobId !== sphereRevisionJobId) {
			sphereRevisionJobId = jobId;
			sphereRevision = null;
		}
		if (spherePreviewFile && sphereRevision == null && revision) {
			sphereRevision = revision;
		}
	});

	function urlFor(filename: string): string {
		if (!jobId) return '';
		const frozen = fileRevisions[filename] ?? revision ?? undefined;
		return jobFileUrl(jobId, filename, frozen);
	}
</script>

{#if visible && jobId}
	<section
		id="job-outputs"
		class="w-full space-y-5 rounded-2xl bg-panel p-5 shadow-sm ring-1 ring-line"
	>
		<div class="space-y-1">
			<h2 class="text-lg font-medium text-ink">
				{effectiveMode === 'globe' ? 'Your globe files' : 'Generated files'}
			</h2>
			<p class="text-sm text-ink-subtle">
				{#if !artifactsAvailable && status === 'complete'}
					Server copies were removed after download to free disk space. Your download is on your
					device.
				{:else}
					{previewHelperText}
				{/if}
			</p>
		</div>

		{#if showPreviews}
			<div class="grid gap-4 md:grid-cols-2">
				{#each readyMaps as slot (`${jobId}-${slot.filename}`)}
					<div class="space-y-2">
						<p class="text-sm font-medium text-ink-secondary">{slot.label}</p>
						{#if slot.ready}
							<img
								src={urlFor(slot.filename)}
								alt={slot.label}
								class="w-full max-h-[min(70vh,36rem)] rounded-lg object-contain ring-1 ring-line {mapCanvasColor
									? ''
									: 'bg-panel-muted'}"
								style:background-color={mapCanvasColor ?? undefined}
							/>
							<p class="text-xs text-ink-subtle">{slot.filename}</p>
						{:else}
							<div
								class="{placeholderClass(
									activePlaceholder?.kind === 'map' &&
										activePlaceholder.filename === slot.filename
								)} flex h-[min(40vh,20rem)] items-center justify-center rounded-lg text-sm text-ink-subtle ring-1 ring-line"
								role="status"
								aria-label={status === 'complete' ? 'Map preview unavailable' : 'Waiting for map'}
								aria-busy={activePlaceholder?.kind === 'map' &&
									activePlaceholder.filename === slot.filename}
							>
								<span class="relative z-10">
									{status === 'complete' ? 'Preview unavailable' : 'Waiting…'}
								</span>
							</div>
						{/if}
					</div>
				{/each}
			</div>

			{#if effectiveMode === 'globe'}
				{#if spherePreviewFile && jobId}
					<div class="space-y-2">
						<h3 class="text-base font-medium text-ink">Globe preview</h3>
						<p class="text-sm text-ink-subtle">
							A rough idea of how your map wraps around a ball. The place you picked sits at the
							top.
						</p>
						<DistortedPanoramaViewer
							src={jobFileUrl(
								jobId,
								spherePreviewFile,
								sphereRevision ?? revision ?? undefined
							)}
						/>
					</div>
				{:else if (stitchedReady || readyStripes.length > 0) && status !== 'complete' && status !== 'failed'}
					<div class="space-y-2">
						<h3 class="text-base font-medium text-ink">Globe preview</h3>
						<p class="text-sm text-ink-subtle">Building a quick wrap-around preview…</p>
						<div
							class="{placeholderClass(activePlaceholder?.kind === 'sphere')} h-[min(40vh,20rem)] w-full rounded-lg ring-1 ring-line"
							role="status"
							aria-label="Waiting for sphere preview"
							aria-busy={activePlaceholder?.kind === 'sphere'}
						></div>
					</div>
				{/if}

				{#if showPoleCapsSlot}
					<div class="space-y-2">
						<h3 class="text-base font-medium text-ink">Pole caps</h3>
						<p class="text-sm text-ink-subtle">
							Two round pieces for the top and bottom of the globe. Cut along the yellow circle;
							the small dot marks the centre.
						</p>
						{#if poleCapsFile}
							<img
								src={urlFor(poleCapsFile)}
								alt="Pole caps"
								class="mx-auto w-full max-w-2xl max-h-[min(50vh,24rem)] rounded-lg bg-panel-muted object-contain ring-1 ring-line"
							/>
							<p class="text-xs text-ink-subtle">{poleCapsFile}</p>
						{:else}
							<div
								class="{placeholderClass(
									activePlaceholder?.kind === 'pole-caps'
								)} mx-auto h-[min(40vh,16rem)] w-full max-w-2xl rounded-lg ring-1 ring-line"
								role="status"
								aria-label="Waiting for pole caps"
								aria-busy={activePlaceholder?.kind === 'pole-caps'}
							></div>
						{/if}
					</div>
				{/if}

				{#if stripeSlots.length > 0}
					<div class="space-y-3">
						<div class="space-y-1">
							<h3 class="text-base font-medium text-ink">Printable strips</h3>
							{#if stripePrintSizeCm}
								<p class="text-sm text-ink-secondary">
									Each strip is about {stripePrintSizeCm} — the long side runs pole to pole (half
									the globe's circumference).
								</p>
							{/if}
							<p class="text-sm text-ink-subtle">
								Long pieces that wrap around the globe. Line up the wavy yellow edges when you
								glue neighbours together.
							</p>
						</div>
						<div
							class="grid w-full gap-2"
							style:grid-template-columns="repeat({stripeColumns}, minmax(0, 1fr))"
						>
							{#each stripeSlots as slot (`${jobId}-${slot.key}`)}
								{@const stripeActive =
									activePlaceholder?.kind === 'stripe' &&
									activePlaceholder.index === slot.index}
								<div class="flex min-w-0 flex-col items-center gap-1.5">
									{#if slot.filename}
										<img
											src={urlFor(slot.filename)}
											alt={slot.filename}
											class="h-auto max-h-[500px] w-full rounded-md bg-panel-muted object-contain ring-1 ring-line"
										/>
										<p class="w-full truncate text-center text-xs text-ink-subtle">
											{slot.filename}
										</p>
									{:else}
										<div
											class="{placeholderClass(
												stripeActive
											)} flex h-[min(40vw,460px)] w-full items-center justify-center rounded-md text-ink-subtle ring-1 ring-line"
											role="status"
											aria-label="Waiting for stripe"
											aria-busy={stripeActive}
										>
											<span class="relative z-10">…</span>
										</div>
										<p class="text-xs text-ink-subtle">Waiting…</p>
									{/if}
								</div>
							{/each}
						</div>
					</div>
				{/if}
			{/if}
		{/if}
	</section>
{/if}

<style>
	.loading-placeholder {
		background-color: var(--color-line);
	}

	.loading-shimmer {
		position: relative;
		overflow: hidden;
		background-color: var(--color-panel-muted);
		background-image: linear-gradient(
			110deg,
			var(--color-panel-muted) 0%,
			var(--color-panel-muted) 35%,
			var(--color-line) 50%,
			var(--color-line-strong) 55%,
			var(--color-line) 60%,
			var(--color-panel-muted) 75%,
			var(--color-panel-muted) 100%
		);
		background-size: 200% 100%;
		animation: shimmer 1.6s ease-in-out infinite;
	}

	@keyframes shimmer {
		0% {
			background-position: 100% 0;
		}
		100% {
			background-position: -100% 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.loading-shimmer {
			animation: none;
			background-image: none;
			background-color: var(--color-line);
		}
	}
</style>
