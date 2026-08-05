<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { getLatestGlobe } from '@lib/api/jobs';
	import DistortedPanoramaViewer from '@lib/components/DistortedPanoramaViewer.svelte';
	import SeoHead from '@lib/components/SeoHead.svelte';
	import { HOME_OG_IMAGES, SITE_NAME } from '@lib/seo';

	const POLL_MS = 60_000;

	let previewUrl = $state<string | null>(null);
	let placeName = $state<string | null>(null);
	let fallback = $state(false);
	let emptyFill = $state('#808080');
	let error = $state<string | null>(null);

	let pollId: ReturnType<typeof setInterval> | undefined;

	async function refresh() {
		try {
			const job = await getLatestGlobe();
			const nextUrl = job.fallback ? '/rip.jpeg' : job.spherePreviewUrl;
			if (!nextUrl) throw new Error('No sphere preview URL');
			previewUrl = nextUrl;
			placeName = job.placeName?.trim() || null;
			fallback = job.fallback === true;
			emptyFill = job.emptyFillColor || '#808080';
			error = null;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not load latest globe.';
		}
	}

	onMount(() => {
		void refresh();
		pollId = setInterval(() => void refresh(), POLL_MS);
	});

	onDestroy(() => {
		if (pollId != null) clearInterval(pollId);
	});
</script>

<SeoHead
	title={`Latest planet — ${SITE_NAME}`}
	description="Watch the most recently generated Globus Maker globe, with stars, sun, and atmosphere."
	images={HOME_OG_IMAGES}
/>

<main class="relative h-[calc(100dvh-3.75rem)] w-full overflow-hidden bg-black">
	{#if previewUrl}
		<DistortedPanoramaViewer
			src={previewUrl}
			title={placeName ?? 'Latest planet'}
			variant="stage"
			depolarSquare={fallback}
			emptyFillColor={emptyFill}
		/>
		{#if placeName}
			<p
				class="pointer-events-none absolute top-4 left-4 z-30 rounded-md bg-black/45 px-2.5 py-1 text-xs font-medium tracking-wide text-stone-200/90 backdrop-blur-sm"
			>
				{placeName}
			</p>
		{/if}
	{:else if error}
		<p class="flex h-full items-center justify-center px-4 text-center text-sm text-stone-300">
			{error}
		</p>
	{:else}
		<p class="flex h-full items-center justify-center px-4 text-center text-sm text-stone-300">
			Loading latest globe…
		</p>
	{/if}
</main>
