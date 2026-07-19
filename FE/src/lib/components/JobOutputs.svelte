<script lang="ts">
	import { jobFileUrl } from '@lib/api/jobs';
	import DistortedPanoramaViewer from '@lib/components/DistortedPanoramaViewer.svelte';
	import type { JobStatus } from '@lib/types';

	interface Props {
		jobId: string | null;
		files: string[];
		stripeCount: number;
		status?: JobStatus | null;
		/** Cache-bust preview URLs when uploads are replaced. */
		revision?: string | null;
		/** False after download/TTL — server deleted preview files. */
		artifactsAvailable?: boolean;
		visible: boolean;
	}

	let {
		jobId,
		files,
		stripeCount,
		status = null,
		revision = null,
		artifactsAvailable = true,
		visible
	}: Props = $props();

	const MAP_SLOTS = [
		{ filename: 'input.jpg', label: 'Stitched map' },
		{ filename: 'input-distorted.jpg', label: 'Prewarped map' }
	] as const;

	const readyMaps = $derived.by(() => {
		const set = new Set(files.map((f) => f.toLowerCase()));
		return MAP_SLOTS.map((slot) => ({
			...slot,
			ready: set.has(slot.filename.toLowerCase())
		}));
	});

	const distortedReady = $derived(
		files.some((f) => f.toLowerCase() === 'input-distorted.jpg')
	);

	/** slize.pl writes out-00.jpg … out-(n-1).jpg */
	const readyStripes = $derived.by(() => {
		return files
			.map((filename) => {
				const match = /^out-(\d+)\.jpg$/i.exec(filename);
				if (!match) return null;
				return { filename, index: Number(match[1]) };
			})
			.filter((item): item is { filename: string; index: number } => item != null)
			.sort((a, b) => a.index - b.index);
	});

	const showPlaceholders = $derived(
		status !== 'complete' && status !== 'packaging' && status !== 'failed'
	);

	const stripeSlots = $derived.by(() => {
		const ready = readyStripes;
		const expected = Math.max(0, Number(stripeCount) || 0);
		const slots: Array<{ key: string; filename: string | null }> = ready.map((item) => ({
			key: item.filename,
			filename: item.filename
		}));

		if (showPlaceholders) {
			const total = Math.max(expected, ready.length);
			for (let i = ready.length; i < total; i++) {
				slots.push({ key: `pending-${i}`, filename: null });
			}
		}

		return slots;
	});

	const stripeColumns = $derived(Math.max(1, stripeSlots.length || Number(stripeCount) || 1));

	const showPreviews = $derived(artifactsAvailable || files.length > 0);
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
					Preview images appear here as each file finishes processing.
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

			{#if jobId && distortedReady}
				<div class="space-y-2">
					<h3 class="text-base font-medium text-stone-900">Sphere preview</h3>
					<p class="text-sm text-stone-500">
						Globe view of the prewarped map (input-distorted.jpg). Loads once — not refreshed
						when stripes finish.
					</p>
					<!-- Stable URL (no revision) so stripe uploads don't remount the globe. -->
					<DistortedPanoramaViewer src={jobFileUrl(jobId, 'input-distorted.jpg')} />
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
