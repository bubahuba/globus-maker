<script lang="ts">
	import { placeLabelFromDisplayName, searchPlaces, type GeocodeResult } from '@lib/api/geocode';

	interface Props {
		value?: string | null;
		onselect?: (result: GeocodeResult) => void;
	}

	let { value = null, onselect }: Props = $props();

	/** Local input text. Synced from parent only when `value` changes externally. */
	let query = $state('');
	let lastExternalValue = $state<string | null>(null);

	let results = $state<GeocodeResult[]>([]);
	let searching = $state(false);
	let searchError = $state<string | null>(null);
	let open = $state(false);

	let debounceTimer: ReturnType<typeof setTimeout> | undefined;

	// Apply parent updates (reverse geocode / job open) without clobbering keystrokes.
	$effect(() => {
		const next = value?.trim() || null;
		if (next === lastExternalValue) return;
		lastExternalValue = next;
		if (next) query = next;
	});

	async function runSearch(searchValue: string) {
		searching = true;
		searchError = null;
		try {
			results = await searchPlaces(searchValue);
			open = results.length > 0;
			searchError = results.length === 0 ? 'No places found' : null;
		} catch (error) {
			results = [];
			open = false;
			searchError = error instanceof Error ? error.message : 'Search failed';
		} finally {
			searching = false;
		}
	}

	function onInput(event: Event) {
		const next = (event.currentTarget as HTMLInputElement).value;
		query = next;
		clearTimeout(debounceTimer);

		if (next.trim().length < 2) {
			results = [];
			open = false;
			searchError = null;
			return;
		}

		debounceTimer = setTimeout(() => runSearch(next), 350);
	}

	function pickResult(result: GeocodeResult) {
		const label = placeLabelFromDisplayName(result.displayName, result.label);
		query = label;
		lastExternalValue = label;
		open = false;
		results = [];
		onselect?.(result);
	}

	function onBlur() {
		setTimeout(() => {
			open = false;
		}, 150);
	}
</script>

<div class="relative z-30 isolate px-0.5 pt-0.5">
	<label class="block space-y-1" for="place-search">
		<span class="text-sm font-medium text-ink-secondary">Find a place</span>
		<div class="relative">
			<input
				id="place-search"
				type="search"
				placeholder="City, town, address…"
				value={query}
				oninput={onInput}
				onfocus={() => {
					if (results.length > 0) open = true;
				}}
				onblur={onBlur}
				autocomplete="off"
				class="relative z-10 w-full rounded-xl border border-line-strong bg-panel px-4 py-2.5 text-sm text-ink shadow-sm outline-none ring-accent/30 focus:ring-2"
			/>

			{#if open && results.length > 0}
				<ul
					id="place-search-results"
					class="absolute top-full right-0 left-0 z-20 mt-1 max-h-56 overflow-y-auto overscroll-contain rounded-xl border border-line bg-panel py-1 shadow-lg"
				>
					{#each results as result (result.placeId)}
						<li>
							<button
								type="button"
								class="w-full px-4 py-2 text-left text-sm text-ink hover:bg-accent-soft"
								onmousedown={(event) => {
									event.preventDefault();
									pickResult(result);
								}}
							>
								{result.displayName}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</label>

	<div class="min-h-5 pt-1" aria-live="polite">
		{#if searching}
			<p class="text-xs text-ink-subtle">Searching…</p>
		{:else if searchError}
			<p class="text-xs text-red-600">{searchError}</p>
		{/if}
	</div>
</div>
