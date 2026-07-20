<script lang="ts">
	import { jobFileUrl } from '@lib/api/jobs';
	import DistortedPanoramaViewer from '@lib/components/DistortedPanoramaViewer.svelte';
	import type { JobStatus, OutputFormat } from '@lib/types';

	interface Props {
		jobId: string | null;
		files: string[];
		stripeCount: number;
		status?: JobStatus | null;
		/** Cache-bust preview URLs when uploads are replaced. */
		revision?: string | null;
		/** False after download/TTL — server deleted preview files. */
		artifactsAvailable?: boolean;
		/** Requested stripe format; inferred from filenames when absent. */
		outputFormat?: OutputFormat | null;
		visible: boolean;
	}

	let {
		jobId,
		files,
		stripeCount,
		status = null,
		revision = null,
		artifactsAvailable = true,
		outputFormat = null,
		visible
	}: Props = $props();

	const effectiveFormat = $derived.by((): OutputFormat => {
		if (outputFormat === 'jpg' || outputFormat === 'svg') return outputFormat;
		const lower = files.map((f) => f.toLowerCase());
		if (lower.some((f) => f === 'input.svg' || /^out-\d+\.svg$/.test(f))) return 'svg';
		return 'jpg';
	});

	const mapSlots = $derived.by(() => {
		if (effectiveFormat === 'jpg') {
			return [
				{ filename: 'input.jpg', label: 'Stitched map' },
				{ filename: 'input-distorted.jpg', label: 'Prewarped map' }
			] as const;
		}
		return [
			{ filename: 'input.svg', label: 'Stitched map' },
			{ filename: 'input-distorted.svg', label: 'Prewarped map' }
		] as const;
	});

	const readyMaps = $derived.by(() => {
		const set = new Set(files.map((f) => f.toLowerCase()));
		return mapSlots.map((slot) => ({
			...slot,
			ready: set.has(slot.filename.toLowerCase())
		}));
	});

	/** Processor writes out-00.{jpg|svg} … — UI shows highest index first. */
	const readyStripes = $derived.by(() => {
		const pattern =
			effectiveFormat === 'jpg' ? /^out-(\d+)\.jpe?g$/i : /^out-(\d+)\.svg$/i;
		return files
			.map((filename) => {
				const match = pattern.exec(filename);
				if (!match) return null;
				return { filename, index: Number(match[1]) };
			})
			.filter((item): item is { filename: string; index: number } => item != null)
			.sort((a, b) => b.index - a.index);
	});

	const spherePreviewFile = $derived(
		files.some((f) => f.toLowerCase() === 'input-distorted-preview.jpg')
			? 'input-distorted-preview.jpg'
			: null
	);

	const distortedReady = $derived(
		files.some((f) => {
			const n = f.toLowerCase();
			return n === 'input-distorted.jpg' || n === 'input-distorted.svg';
		})
	);

	const showPlaceholders = $derived(
		status !== 'complete' && status !== 'packaging' && status !== 'failed'
	);

	const stripeSlots = $derived.by(() => {
		const readyByIndex = new Map(readyStripes.map((item) => [item.index, item.filename]));
		const expected = Math.max(0, Number(stripeCount) || 0);
		const maxReady = readyStripes.reduce((max, item) => Math.max(max, item.index), -1);
		const total = showPlaceholders
			? Math.max(expected, maxReady + 1)
			: Math.max(0, maxReady + 1);

		const slots: Array<{ key: string; filename: string | null }> = [];
		for (let i = total - 1; i >= 0; i--) {
			const filename = readyByIndex.get(i) ?? null;
			if (filename) {
				slots.push({ key: filename, filename });
			} else if (showPlaceholders) {
				slots.push({ key: `pending-${i}`, filename: null });
			}
		}
		return slots;
	});

	const stripeColumns = $derived(Math.max(1, stripeSlots.length || Number(stripeCount) || 1));

	const showPreviews = $derived(artifactsAvailable || files.length > 0);

	const previewHelperText = $derived(
		effectiveFormat === 'jpg'
			? 'JPEG previews appear here as each file finishes processing.'
			: 'Distorted SVG previews appear here as each file finishes processing.'
	);

	let sphereRevision = $state<string | null>(null);
	let sphereRevisionJobId = $state<string | null>(null);

	$effect(() => {
		if (jobId !== sphereRevisionJobId) {
			sphereRevisionJobId = jobId;
			sphereRevision = null;
		}
		if (spherePreviewFile && sphereRevision == null && revision) {
			sphereRevision = revision;
		}
	});

</script>

{#if visible && jobId}
	<section
		id="job-outputs"
		class="w-full space-y-5 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-stone-200"
	>
		<div class="space-y-1">
			<h2 class="text-lg font-medium text-stone-900">Generated files</h2>
			<p class="text-sm text-stone-500">
				{#if !artifactsAvailable && status === 'complete'}
					Server copies were removed after download to free disk space. Your zip is on your
					device.
				{:else}
					{previewHelperText}
				{/if}
			</p>
		</div>

		{#if showPreviews}
			<div class="grid gap-4 md:grid-cols-2">
				{#each readyMaps as slot (slot.filename)}
					<div class="space-y-2">
						<p class="text-sm font-medium text-stone-700">{slot.label}</p>
						{#if slot.ready}
							<img
								src={jobFileUrl(jobId, slot.filename, revision ?? undefined)}
								alt={slot.label}
								class="w-full max-h-[min(70vh,36rem)] rounded-lg bg-stone-50 object-contain ring-1 ring-stone-200"
							/>
							<p class="text-xs text-stone-400">{slot.filename}</p>
						{:else}
							<div
								class="flex h-[min(40vh,20rem)] items-center justify-center rounded-lg bg-stone-50 text-sm text-stone-400 ring-1 ring-stone-200"
							>
								Waiting…
							</div>
						{/if}
					</div>
				{/each}
			</div>

			{#if spherePreviewFile && jobId}
				<div class="space-y-2">
					<h3 class="text-base font-medium text-stone-900">Sphere preview</h3>
					<p class="text-sm text-stone-500">
						Globe from an ImageMagick DePolar unwrap of the prewarped map. Map centre is the
						north pole.
					</p>
					<DistortedPanoramaViewer
						src={jobFileUrl(jobId, spherePreviewFile, sphereRevision ?? revision ?? undefined)}
					/>
				</div>
			{:else if (distortedReady || readyStripes.length > 0) && status !== 'complete' && status !== 'failed'}
				<div class="space-y-2">
					<h3 class="text-base font-medium text-stone-900">Sphere preview</h3>
					<p class="text-sm text-stone-500">Waiting for DePolar texture…</p>
				</div>
			{/if}

			<div class="space-y-3">
				<h3 class="text-base font-medium text-stone-900">Stripes</h3>
				<div
					class="grid w-full gap-2"
					style:grid-template-columns="repeat({stripeColumns}, minmax(0, 1fr))"
				>
					{#each stripeSlots as slot (slot.key)}
						<div class="flex min-w-0 flex-col items-center gap-1.5">
							{#if slot.filename}
								<img
									src={jobFileUrl(jobId, slot.filename, revision ?? undefined)}
									alt={slot.filename}
									class="h-auto max-h-[500px] w-full rounded-md bg-stone-50 object-contain ring-1 ring-stone-200"
								/>
								<p class="w-full truncate text-center text-xs text-stone-500">
									{slot.filename}
								</p>
							{:else}
								<div
									class="flex h-[min(40vw,500px)] w-full animate-pulse items-center justify-center rounded-md bg-stone-100 text-stone-400 ring-1 ring-stone-200"
								>
									…
								</div>
								<p class="text-xs text-stone-400">Waiting…</p>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</section>
{/if}
