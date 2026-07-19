<script lang="ts">
	import { searchPlaces, type GeocodeResult } from '@lib/api/geocode';

	interface Props {
		onselect?: (result: GeocodeResult) => void;
	}

	let { onselect }: Props = $props();

	let query = $state('');
	let results = $state<GeocodeResult[]>([]);
	let searching = $state(false);
	let searchError = $state<string | null>(null);
	let open = $state(false);

	let debounceTimer: ReturnType<typeof setTimeout> | undefined;

	async function runSearch(value: string) {
		searching = true;
		searchError = null;
		try {
			results = await searchPlaces(value);
			open = results.length > 0;
			if (results.length === 0) {
				searchError = 'No places found';
			} else {
				searchError = null;
			}
		} catch (error) {
			results = [];
			open = false;
			searchError = error instanceof Error ? error.message : 'Search failed';
		} finally {
			searching = false;
		}
	}

	function onInput(event: Event) {
		const value = (event.currentTarget as HTMLInputElement).value;
		query = value;
		clearTimeout(debounceTimer);

		if (value.trim().length < 2) {
			results = [];
			open = false;
			searchError = null;
			return;
		}

		debounceTimer = setTimeout(() => runSearch(value), 350);
	}

	function pickResult(result: GeocodeResult) {
		query = result.displayName.split(',').slice(0, 2).join(', ');
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
		<span class="text-sm font-medium text-stone-700">Find a place</span>
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
				class="relative z-10 w-full rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm text-stone-900 shadow-sm outline-none ring-amber-700/30 focus:ring-2"
			/>

			{#if open && results.length > 0}
				<ul
					id="place-search-results"
					class="absolute top-full right-0 left-0 z-20 mt-1 max-h-56 overflow-y-auto overscroll-contain rounded-xl border border-stone-200 bg-white py-1 shadow-lg"
				>
					{#each results as result (result.placeId)}
						<li>
							<button
								type="button"
								class="w-full px-4 py-2 text-left text-sm text-stone-800 hover:bg-amber-50"
								onmousedown={() => pickResult(result)}
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
			<p class="text-xs text-stone-500">Searching…</p>
		{:else if searchError}
			<p class="text-xs text-red-600">{searchError}</p>
		{/if}
	</div>
</div>
