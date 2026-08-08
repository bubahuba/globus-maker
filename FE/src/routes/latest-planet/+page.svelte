<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { resolve } from '$app/paths';
	import { getLatestGlobe } from '@lib/api/jobs';
	import {
		archiveDirectFileUrl,
		archiveDisplayLabel,
		archiveFileUrl,
		archiveLabelFromMeta,
		archiveLivePreview,
		archiveMetaFromJob,
		archiveNameForJob,
		buildRecreateSelectionSearch,
		formatArchiveMetaTooltip,
		isThumbFilename,
		listArchivedPreviews,
		loadArchiveMetaMap,
		thumbNameFor,
		type ArchiveImageMeta
	} from '@lib/api/globe-preview';
	import DistortedPanoramaViewer from '@lib/components/DistortedPanoramaViewer.svelte';
	import SeoHead from '@lib/components/SeoHead.svelte';
	import { HOME_OG_IMAGES, SITE_NAME } from '@lib/seo';

	const POLL_MS = 60_000;

	type TextureOpts = { depolarSquare?: boolean; emptyFillColor?: string };

	type ViewerHandle = {
		captureThumbBlob: (type?: string, quality?: number) => Promise<Blob | null>;
		focusOrCreatePlanet: (id: string, url: string, opts?: TextureOpts) => Promise<void>;
		updatePlanetTexture: (id: string, url: string, opts?: TextureOpts) => Promise<void>;
	};

	/** Live job preview URL — drives stage bootstrap via `src`; archive clicks use the imperative API. */
	let liveUrl = $state<string | null>(null);
	let placeName = $state<string | null>(null);
	/** Place chip for the live planet (kept while viewing archives). */
	let livePlaceName = $state<string | null>(null);
	let liveJobId = $state<string | null>(null);
	let liveDisplayName = $state('Latest');
	let fallback = $state(false);
	let emptyFill = $state('#808080');
	let error = $state<string | null>(null);

	/** Empty = follow live API; otherwise a filename under /api/globe-preview/. */
	let selectedArchive = $state('');
	let archivedNames = $state<string[]>([]);
	let archiveMetaByName = $state<Record<string, ArchiveImageMeta>>({});
	let archivePaneOpen = $state(false);

	let viewer = $state<ViewerHandle | undefined>();
	let stageEl = $state<HTMLElement | undefined>();
	let isFullscreen = $state(false);
	let fullscreenSupported = $state(false);
	let pollId: ReturnType<typeof setInterval> | undefined;
	/** True once the live planet has been created/focused at least once. */
	let livePlanetReady = $state(false);

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
			void refreshLive();
		}, POLL_MS);
	}

	function liveTextureOpts(): TextureOpts {
		return { depolarSquare: fallback, emptyFillColor: emptyFill };
	}

	async function refreshArchiveMeta(names: string[] = archivedNames) {
		const textures = names.filter((name) => !isThumbFilename(name));
		if (textures.length === 0) {
			archiveMetaByName = {};
			return;
		}
		try {
			archiveMetaByName = await loadArchiveMetaMap(textures, names);
		} catch (err) {
			console.warn('Could not load archive image metadata', err);
		}
	}

	async function refreshArchiveList() {
		try {
			archivedNames = await listArchivedPreviews();
			await refreshArchiveMeta(archivedNames);
		} catch (err) {
			console.warn('Could not list archived globes', err);
		}
	}

	function labelForArchive(name: string): string {
		return archiveLabelFromMeta(archiveMetaByName[name], archiveDisplayLabel(name));
	}

	function recreateHrefForArchive(name: string): string | null {
		const meta = archiveMetaByName[name];
		if (meta?.lat == null || meta?.lng == null) return null;
		if (!Number.isFinite(meta.lat) || !Number.isFinite(meta.lng)) return null;
		const search = buildRecreateSelectionSearch({
			mode: 'globe',
			placeName: meta.placeName,
			lat: meta.lat,
			lng: meta.lng,
			sideMeters: meta.sideMeters
		});
		// search is `?mode=…`; resolve('/') keeps base-path correctness.
		return `${resolve('/')}${search}`;
	}

	const archivePlaceLabel = $derived(
		selectedArchive ? labelForArchive(selectedArchive) : ''
	);
	const archiveRecreateHref = $derived(
		selectedArchive ? recreateHrefForArchive(selectedArchive) : null
	);
	const liveJobHref = $derived(
		liveJobId ? (`${resolve('/')}?job=${encodeURIComponent(liveJobId)}` as const) : null
	);
	const newGlobeHref = $derived(`${resolve('/')}${buildRecreateSelectionSearch({ mode: 'globe' })}`);

	const placeChipClass =
		'absolute top-4 left-4 z-30 inline-flex max-w-[min(18rem,calc(100vw-7rem))] items-center gap-1 rounded-md bg-black/45 px-2.5 py-1 text-xs font-medium tracking-wide text-white backdrop-blur-sm';
	const placeChipLinkClass = `${placeChipClass} transition hover:bg-black/55 hover:underline`;

	async function refreshLive() {
		try {
			const job = await getLatestGlobe();
			const nextUrl = job.fallback ? '/rip.jpeg' : job.spherePreviewUrl;
			if (!nextUrl) throw new Error('No sphere preview URL');
			liveUrl = nextUrl;
			liveJobId = job.fallback !== true && job.id ? job.id : null;
			const nextPlace = job.placeName?.trim() || null;
			livePlaceName = nextPlace;
			liveDisplayName = nextPlace || (job.fallback ? 'Unavailable' : 'Globe');
			fallback = job.fallback === true;
			emptyFill = job.emptyFillColor || '#808080';
			error = null;

			if (!selectedArchive) {
				placeName = nextPlace;
			}

			await tick();
			if (viewer) {
				const opts = liveTextureOpts();
				if (!selectedArchive && !livePlanetReady) {
					await viewer.focusOrCreatePlanet('live', nextUrl, opts);
					livePlanetReady = true;
				} else {
					await viewer.updatePlanetTexture('live', nextUrl, opts);
					if (!livePlanetReady) livePlanetReady = true;
				}
			}

			if (job.fallback !== true && job.id && !selectedArchive) {
				archivedNames = await archiveLivePreview({
					filename: archiveNameForJob(job),
					sourceUrl: nextUrl,
					knownNames: archivedNames,
					meta: archiveMetaFromJob(job),
					captureThumb: async () => (viewer ? viewer.captureThumbBlob() : null)
				});
				await refreshArchiveMeta(archivedNames);
			}
		} catch (err) {
			if (!liveUrl) {
				error = err instanceof Error ? err.message : 'Could not load latest globe.';
			} else {
				console.warn('Live globe refresh failed', err);
			}
		}
	}

	async function selectArchive(filename: string) {
		selectedArchive = filename || '';
		error = null;
		await tick();
		if (!viewer) return;

		try {
			if (selectedArchive) {
				placeName = labelForArchive(selectedArchive);
				await viewer.focusOrCreatePlanet(selectedArchive, archiveFileUrl(selectedArchive), {
					depolarSquare: false,
					emptyFillColor: '#808080'
				});
				return;
			}
			placeName = livePlaceName;
			if (liveUrl) {
				await viewer.focusOrCreatePlanet('live', liveUrl, liveTextureOpts());
				livePlanetReady = true;
			} else {
				await refreshLive();
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not open globe.';
		}
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
	description="Watch the most recently generated Globe Maker globe, with stars, sun, and atmosphere."
	images={HOME_OG_IMAGES}
/>

{#snippet placeLinkIcon()}
	<svg
		xmlns="http://www.w3.org/2000/svg"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
		class="h-3 w-3 shrink-0 opacity-80"
		aria-hidden="true"
	>
		<path d="M15 3h6v6" />
		<path d="M10 14 21 3" />
		<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
	</svg>
{/snippet}

<main
	bind:this={stageEl}
	class="relative w-full overflow-hidden bg-black {isFullscreen
		? 'h-screen'
		: 'h-[calc(100dvh-3.75rem)]'}"
>
	<DistortedPanoramaViewer
		bind:this={viewer}
		src={liveUrl ?? ''}
		title={placeName ?? 'Latest planet'}
		variant="stage"
		depolarSquare={fallback}
		emptyFillColor={emptyFill}
		hideFullscreenButton={true}
		onPlanetFocus={(id) => void selectArchive(id === 'live' ? '' : id)}
	/>
	{#if placeName && !selectedArchive && liveUrl}
		{#if liveJobHref}
			<a href={liveJobHref} class={placeChipLinkClass} title="Open job">
				<span class="min-w-0 truncate">{placeName}</span>
				{@render placeLinkIcon()}
			</a>
		{:else}
			<p class="pointer-events-none {placeChipClass}">
				<span class="min-w-0 truncate">{placeName}</span>
			</p>
		{/if}
	{:else if selectedArchive}
		{#if archiveRecreateHref}
			<a href={archiveRecreateHref} class={placeChipLinkClass} title="Recreate in Globe Maker">
				<span class="min-w-0 truncate">{archivePlaceLabel}</span>
				{@render placeLinkIcon()}
			</a>
		{:else}
			<p class="pointer-events-none {placeChipClass}">
				<span class="min-w-0 truncate">{archivePlaceLabel}</span>
			</p>
		{/if}
	{/if}
	{#if error && !liveUrl}
		<p
			class="pointer-events-none absolute inset-0 z-20 flex items-center justify-center px-4 text-center text-sm text-ink-subtle"
		>
			{error}
		</p>
	{/if}

	<div
		class="absolute top-3 z-40 flex items-center gap-2 transition-[right] duration-200 ease-out"
		style:right={controlsRight}
	>
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
	</div>

	<aside
		id="archive-pane"
		class="absolute top-0 right-0 z-[35] flex h-full w-[min(20rem,85vw)] flex-col border-l border-line bg-panel/95 shadow-xl backdrop-blur-md transition-transform duration-200 ease-out {archivePaneOpen
			? 'translate-x-0 pointer-events-auto'
			: 'translate-x-full pointer-events-none'}"
		aria-label="Saved globes"
		aria-hidden={!archivePaneOpen}
	>
		<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2.5">
			<button
				type="button"
				class="mb-1.5 flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-ink transition hover:bg-ink/5 {selectedArchive
					? ''
					: 'bg-ink/10 ring-2 ring-line-strong'}"
				aria-current={!selectedArchive ? 'true' : 'false'}
				onclick={() => void selectArchive('')}
			>
				<span
					class="flex h-[4.5rem] w-[4.5rem] shrink-0 items-center justify-center rounded-md bg-canvas text-[0.65rem] text-ink-subtle"
				>
					LIVE
				</span>
				<span class="min-w-0 flex-1 truncate text-sm font-medium">{liveDisplayName}</span>
			</button>

			<ul class="grid grid-cols-3 gap-1.5">
				<li>
					<a
						href={newGlobeHref}
						class="flex w-full flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-ink no-underline transition hover:bg-ink/5"
						title="Create a globe"
						aria-label="Create a globe"
					>
						<span
							class="flex aspect-square w-full items-center justify-center rounded-[22%] border border-dashed border-line-strong/70 bg-transparent text-2xl font-light leading-none text-ink-subtle"
							aria-hidden="true"
						>
							+
						</span>
						<span
							class="line-clamp-2 w-full text-center text-[0.65rem] leading-tight font-medium break-words text-ink-subtle"
						>
							New
						</span>
					</a>
				</li>
				{#each textureNames as name (name)}
					<li>
						<button
							type="button"
							class="flex w-full flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-ink transition hover:bg-ink/5 {selectedArchive ===
							name
								? 'bg-ink/10 ring-2 ring-line-strong'
								: ''}"
							aria-current={selectedArchive === name ? 'true' : 'false'}
							title={formatArchiveMetaTooltip(archiveMetaByName[name]) ||
								labelForArchive(name)}
							onclick={() => void selectArchive(name)}
						>
							{#if archivedNames.includes(thumbNameFor(name))}
								<img
									class="aspect-square w-full rounded-[22%] object-cover"
									src={`${archiveDirectFileUrl(thumbNameFor(name))}?v=2`}
									alt=""
									loading="lazy"
								/>
							{:else}
								<span
									class="flex aspect-square w-full items-center justify-center rounded-[22%] bg-canvas text-[0.6rem] text-ink-subtle"
								>
									MAP
								</span>
							{/if}
							<span
								class="line-clamp-2 w-full text-center text-[0.65rem] leading-tight font-medium break-words"
							>
								{labelForArchive(name)}
							</span>
						</button>
					</li>
				{/each}
			</ul>
		</div>
	</aside>
</main>
