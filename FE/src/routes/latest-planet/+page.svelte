<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { getLatestGlobe } from '@lib/api/jobs';
	import {
		archiveDisplayLabel,
		archiveFileUrl,
		archiveLivePreview,
		archiveNameForJob,
		isThumbFilename,
		listArchivedPreviews,
		thumbNameFor
	} from '@lib/api/globe-preview';
	import DistortedPanoramaViewer from '@lib/components/DistortedPanoramaViewer.svelte';
	import SeoHead from '@lib/components/SeoHead.svelte';
	import { HOME_OG_IMAGES, SITE_NAME } from '@lib/seo';

	const POLL_MS = 60_000;

	type ViewerHandle = {
		captureThumbBlob: (type?: string, quality?: number) => Promise<Blob | null>;
	};

	let previewUrl = $state<string | null>(null);
	let placeName = $state<string | null>(null);
	let liveDisplayName = $state('Latest');
	let fallback = $state(false);
	let emptyFill = $state('#808080');
	let error = $state<string | null>(null);

	/** Empty = follow live API; otherwise a filename under /api/globe-preview/. */
	let selectedArchive = $state('');
	let archivedNames = $state<string[]>([]);
	let archivePaneOpen = $state(false);

	let viewer = $state<ViewerHandle | undefined>();
	let stageEl = $state<HTMLElement | undefined>();
	let isFullscreen = $state(false);
	let fullscreenSupported = $state(false);
	let pollId: ReturnType<typeof setInterval> | undefined;

	const textureNames = $derived(archivedNames.filter((name) => !isThumbFilename(name)));
	const controlsRight = $derived(
		archivePaneOpen
			? 'calc(min(20rem, 85vw) + 0.75rem)'
			: 'max(0.75rem, env(safe-area-inset-right))'
	);

	function stopPolling() {
		if (pollId != null) {
			clearInterval(pollId);
			pollId = undefined;
		}
	}

	function startPolling() {
		stopPolling();
		pollId = setInterval(() => {
			if (!selectedArchive) void refreshLive();
		}, POLL_MS);
	}

	async function refreshArchiveList() {
		try {
			archivedNames = await listArchivedPreviews();
		} catch (err) {
			console.warn('Could not list archived globes', err);
		}
	}

	async function refreshLive() {
		if (selectedArchive) return;
		try {
			const job = await getLatestGlobe();
			const nextUrl = job.fallback ? '/rip.jpeg' : job.spherePreviewUrl;
			if (!nextUrl) throw new Error('No sphere preview URL');
			previewUrl = nextUrl;
			placeName = job.placeName?.trim() || null;
			liveDisplayName = placeName || (job.fallback ? 'Unavailable' : 'Globe');
			fallback = job.fallback === true;
			emptyFill = job.emptyFillColor || '#808080';
			error = null;

			if (job.fallback !== true && job.id) {
				await tick();
				archivedNames = await archiveLivePreview({
					filename: archiveNameForJob(job),
					sourceUrl: nextUrl,
					knownNames: archivedNames,
					captureThumb: async () => (viewer ? viewer.captureThumbBlob() : null)
				});
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not load latest globe.';
		}
	}

	async function selectArchive(filename: string) {
		selectedArchive = filename || '';
		if (selectedArchive) {
			stopPolling();
			previewUrl = archiveFileUrl(selectedArchive);
			placeName = archiveDisplayLabel(selectedArchive);
			fallback = false;
			emptyFill = '#808080';
			error = null;
			return;
		}
		startPolling();
		await refreshLive();
	}

	function setArchivePaneOpen(open: boolean) {
		archivePaneOpen = open;
		if (open) void refreshArchiveList();
	}

	function syncFullscreenState() {
		isFullscreen = !!stageEl && document.fullscreenElement === stageEl;
	}

	async function toggleFullscreen() {
		if (!stageEl) return;
		try {
			if (document.fullscreenElement === stageEl) {
				await document.exitFullscreen();
			} else if (typeof stageEl.requestFullscreen === 'function') {
				await stageEl.requestFullscreen();
			}
		} catch {
			/* denied */
		}
	}

	onMount(() => {
		fullscreenSupported =
			!!document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === 'function';

		void (async () => {
			await refreshArchiveList();
			await refreshLive();
			startPolling();
		})();

		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && archivePaneOpen && !document.fullscreenElement) {
				setArchivePaneOpen(false);
			}
		};
		document.addEventListener('keydown', onKey);
		document.addEventListener('fullscreenchange', syncFullscreenState);
		syncFullscreenState();
		return () => {
			document.removeEventListener('keydown', onKey);
			document.removeEventListener('fullscreenchange', syncFullscreenState);
		};
	});

	onDestroy(() => {
		stopPolling();
	});
</script>

<SeoHead
	title={`Latest planet — ${SITE_NAME}`}
	description="Watch the most recently generated Globus Maker globe, with stars, sun, and atmosphere."
	images={HOME_OG_IMAGES}
/>

<main
	bind:this={stageEl}
	class="relative w-full overflow-hidden bg-black {isFullscreen
		? 'h-screen'
		: 'h-[calc(100dvh-3.75rem)]'}"
>
	{#if previewUrl}
		<DistortedPanoramaViewer
			bind:this={viewer}
			src={previewUrl}
			title={placeName ?? 'Latest planet'}
			variant="stage"
			depolarSquare={fallback}
			emptyFillColor={emptyFill}
			hideFullscreenButton={true}
		/>
		{#if placeName && !selectedArchive}
			<p
				class="pointer-events-none absolute top-4 left-4 z-30 rounded-md bg-black/45 px-2.5 py-1 text-xs font-medium tracking-wide text-ink/90 backdrop-blur-sm"
			>
				{placeName}
			</p>
		{:else if selectedArchive}
			<p
				class="pointer-events-none absolute top-4 left-4 z-30 rounded-md bg-black/45 px-2.5 py-1 text-xs font-medium tracking-wide text-ink/90 backdrop-blur-sm"
			>
				{archiveDisplayLabel(selectedArchive)}
			</p>
		{/if}
	{:else if error}
		<p class="flex h-full items-center justify-center px-4 text-center text-sm text-ink-subtle">
			{error}
		</p>
	{:else}
		<p class="flex h-full items-center justify-center px-4 text-center text-sm text-ink-subtle">
			Loading latest globe…
		</p>
	{/if}

	<div
		class="absolute top-3 z-40 flex items-center gap-2 transition-[right] duration-200 ease-out"
		style:right={controlsRight}
	>
		<button
			type="button"
			class="flex h-9 w-9 items-center justify-center rounded-lg bg-panel/90 text-ink-secondary shadow-md ring-1 ring-line-strong/80 backdrop-blur-sm transition hover:bg-panel"
			aria-label={archivePaneOpen ? 'Close saved globes' : 'Open saved globes'}
			aria-pressed={archivePaneOpen}
			aria-controls="archive-pane"
			title={archivePaneOpen ? 'Close saved globes' : 'Saved globes'}
			onclick={() => setArchivePaneOpen(!archivePaneOpen)}
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
				<rect width="7" height="7" x="3" y="3" rx="1" />
				<rect width="7" height="7" x="14" y="3" rx="1" />
				<rect width="7" height="7" x="14" y="14" rx="1" />
				<rect width="7" height="7" x="3" y="14" rx="1" />
			</svg>
		</button>
		{#if fullscreenSupported}
			<button
				type="button"
				class="flex h-9 w-9 items-center justify-center rounded-lg bg-panel/90 text-ink-secondary shadow-md ring-1 ring-line-strong/80 backdrop-blur-sm transition hover:bg-panel"
				aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
				aria-pressed={isFullscreen}
				title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
				onclick={() => void toggleFullscreen()}
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
	</div>

	<aside
		id="archive-pane"
		class="absolute top-0 right-0 z-[35] flex h-full w-[min(20rem,85vw)] flex-col border-l border-white/10 bg-stone-950/92 shadow-xl backdrop-blur-md transition-transform duration-200 ease-out {archivePaneOpen
			? 'translate-x-0 pointer-events-auto'
			: 'translate-x-full pointer-events-none'}"
		aria-label="Saved globes"
		aria-hidden={!archivePaneOpen}
	>
		<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2.5">
			<button
				type="button"
				class="mb-1.5 flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-ink transition hover:bg-white/5 {selectedArchive
					? ''
					: 'bg-white/10 ring-1 ring-white/15'}"
				aria-current={!selectedArchive ? 'true' : 'false'}
				onclick={() => void selectArchive('')}
			>
				<span
					class="flex h-[4.5rem] w-[4.5rem] shrink-0 items-center justify-center rounded-md bg-stone-900 text-[0.65rem] text-ink/35"
				>
					LIVE
				</span>
				<span class="min-w-0 flex-1 truncate text-sm font-medium">{liveDisplayName}</span>
			</button>

			{#if textureNames.length === 0}
				<p class="px-2 py-4 text-center text-xs text-ink/40">No saved globes yet</p>
			{:else}
				<ul class="flex flex-col gap-1">
					{#each textureNames as name (name)}
						<li>
							<button
								type="button"
								class="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-ink transition hover:bg-white/5 {selectedArchive ===
								name
									? 'bg-white/10 ring-1 ring-white/15'
									: ''}"
								aria-current={selectedArchive === name ? 'true' : 'false'}
								onclick={() => void selectArchive(name)}
							>
								{#if archivedNames.includes(thumbNameFor(name))}
									<img
										class="h-[4.5rem] w-[4.5rem] shrink-0 rounded-md object-cover"
										src={`${archiveFileUrl(thumbNameFor(name))}?v=1`}
										alt=""
										loading="lazy"
									/>
								{:else}
									<span
										class="flex h-[4.5rem] w-[4.5rem] shrink-0 items-center justify-center rounded-md bg-stone-900 text-[0.65rem] text-ink/35"
									>
										MAP
									</span>
								{/if}
								<span class="min-w-0 flex-1 truncate text-sm font-medium">
									{archiveDisplayLabel(name)}
								</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</aside>
</main>
