<script lang="ts">
	import {
		createDefaultMapLayers,
		getBaseFillLayer,
		isBaseFillLayer,
		layerZoomHint,
		MAP_LAYER_GROUPS,
		MAP_LAYER_LABELS,
		withBaseFillLayer,
		type BaseFillLayer,
		type MapLayerKey,
		type MapLayerStyle
	} from '@shared/map-style';

	interface Props {
		value?: MapLayerStyle;
	}

	let { value = $bindable(createDefaultMapLayers()) }: Props = $props();

	const baseFill = $derived(getBaseFillLayer(value));

	function updateColor(key: MapLayerKey, color: string) {
		value = {
			...value,
			[key]: { ...value[key], color }
		};
	}

	function selectBaseFill(key: BaseFillLayer) {
		value = withBaseFillLayer(value, key);
	}

	function onVisibilityToggle(key: MapLayerKey, checked: boolean) {
		if (isBaseFillLayer(key)) return;
		value = {
			...value,
			[key]: { ...value[key], enabled: checked }
		};
	}
</script>

<div class="space-y-4">
	<div class="space-y-1">
		<h3 class="text-sm font-medium text-stone-900">Map layers</h3>
		<p class="text-xs text-stone-500">
			Land and water stay on the map always. Their checkboxes only choose which color fills empty
			stripe space — exactly one must be selected (default: land). Other groups can be hidden or
			recolored. Labels include places, water, parks, and street names at progressive zoom levels.
		</p>
	</div>

	{#each MAP_LAYER_GROUPS as group (group.id)}
		<section class="space-y-2">
			<h4 class="text-xs font-medium uppercase tracking-wide text-stone-400">{group.label}</h4>
			{#each group.keys as key (key)}
				{@const hint = layerZoomHint(key)}
				{@const isBase = isBaseFillLayer(key)}
				<div class="rounded-xl border border-stone-200 p-3">
					<div class="flex items-center justify-between gap-3">
						<label class="flex items-center gap-2 text-sm text-stone-700">
							{#if isBase}
								<input
									type="checkbox"
									checked={baseFill === key}
									onchange={(event) => {
										selectBaseFill(key);
										// Clicking the active box unchecks it in the DOM; always keep
										// the chosen base fill checked (XOR with the other).
										event.currentTarget.checked = true;
									}}
									class="accent-amber-700"
									aria-label="Use {MAP_LAYER_LABELS[key]} as base fill"
								/>
							{:else}
								<input
									type="checkbox"
									checked={value[key].enabled}
									onchange={(event) =>
										onVisibilityToggle(
											key,
											(event.currentTarget as HTMLInputElement).checked
										)}
									class="accent-amber-700"
								/>
							{/if}
							{MAP_LAYER_LABELS[key]}
							{#if isBase && baseFill === key}
								<span class="text-xs font-normal text-amber-800">(base fill)</span>
							{/if}
						</label>
						<input
							type="color"
							value={value[key].color}
							disabled={!isBase && !value[key].enabled}
							oninput={(event) =>
								updateColor(key, (event.currentTarget as HTMLInputElement).value)}
							class="h-8 w-12 cursor-pointer rounded border border-stone-300 bg-white p-0.5 disabled:cursor-not-allowed disabled:opacity-40"
							aria-label="{MAP_LAYER_LABELS[key]} color"
						/>
					</div>
					{#if hint}
						<p class="mt-1.5 text-xs text-stone-400">{hint}</p>
					{/if}
				</div>
			{/each}
		</section>
	{/each}
</div>
