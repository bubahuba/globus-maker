<script lang="ts">
	import {
		createDefaultMapLayers,
		MAP_LAYER_KEYS,
		MAP_LAYER_LABELS,
		type MapLayerKey,
		type MapLayerStyle
	} from '@shared/map-style';

	interface Props {
		value?: MapLayerStyle;
	}

	let { value = $bindable(createDefaultMapLayers()) }: Props = $props();

	function updateLayer(key: MapLayerKey, patch: Partial<MapLayerStyle[MapLayerKey]>) {
		value = {
			...value,
			[key]: { ...value[key], ...patch }
		};
	}
</script>

<div class="space-y-3">
	<h3 class="text-sm font-medium text-stone-900">Map layers</h3>
	<p class="text-xs text-stone-500">
		Only these layers are rendered in the preview and downloaded map. Toggle or recolor each one.
		Labels include streets, cities, states, regions, rivers, and parks.
	</p>

	{#each MAP_LAYER_KEYS as key (key)}
		<div class="rounded-xl border border-stone-200 p-3">
			<div class="mb-2 flex items-center justify-between gap-3">
				<label class="flex items-center gap-2 text-sm text-stone-700">
					<input
						type="checkbox"
						checked={value[key].enabled}
						onchange={(event) =>
							updateLayer(key, { enabled: (event.currentTarget as HTMLInputElement).checked })}
						class="accent-amber-700"
					/>
					{MAP_LAYER_LABELS[key]}
				</label>
				<input
					type="color"
					value={value[key].color}
					disabled={!value[key].enabled}
					oninput={(event) =>
						updateLayer(key, { color: (event.currentTarget as HTMLInputElement).value })}
					class="h-8 w-12 cursor-pointer rounded border border-stone-300 bg-white p-0.5 disabled:cursor-not-allowed disabled:opacity-40"
					aria-label="{MAP_LAYER_LABELS[key]} color"
				/>
			</div>
		</div>
	{/each}
</div>
