<script lang="ts">
	interface Props {
		/** Object URL or data URL of the uploaded square map. */
		src: string;
		filename?: string | null;
		onclear: () => void;
	}

	let { src, filename = null, onclear }: Props = $props();
</script>

<div
	class="group relative aspect-square w-full overflow-hidden rounded-xl border border-stone-300 bg-stone-100 shadow-inner"
>
	<img
		{src}
		alt={filename ? `Uploaded map: ${filename}` : 'Uploaded map'}
		class="h-full w-full object-cover"
	/>
	<button
		type="button"
		onclick={onclear}
		class="absolute top-3 right-3 flex h-9 w-9 items-center justify-center rounded-full bg-stone-900/75 text-white opacity-0 shadow-md ring-1 ring-white/20 transition group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
		aria-label="Remove uploaded map"
		title="Remove uploaded map"
	>
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 20 20"
			fill="currentColor"
			class="h-4 w-4"
			aria-hidden="true"
		>
			<path
				fill-rule="evenodd"
				d="M8.75 1a.75.75 0 0 0-.75.75V3H4.5a.75.75 0 0 0 0 1.5h.58l.7 11.2A1.75 1.75 0 0 0 7.52 17h4.96a1.75 1.75 0 0 0 1.74-1.3l.7-11.2h.58a.75.75 0 0 0 0-1.5H12V1.75A.75.75 0 0 0 11.25 1h-2.5ZM10 5.5c.28 0 .52.2.57.47l.75 8.5a.58.58 0 0 1-1.15.1l-.75-8.5A.58.58 0 0 1 10 5.5Zm-2.2.47a.58.58 0 0 0-1.14.1l.75 8.5a.58.58 0 1 0 1.15-.1l-.76-8.5Zm5.54 0a.58.58 0 0 1 .57.47l-.75 8.5a.58.58 0 1 1-1.15-.1l.75-8.5c.05-.27.29-.47.58-.47Z"
				clip-rule="evenodd"
			/>
		</svg>
	</button>
	{#if filename}
		<p
			class="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-stone-900/70 to-transparent px-3 pt-8 pb-2 text-xs text-white opacity-0 transition group-hover:opacity-100"
		>
			{filename}
		</p>
	{/if}
</div>
