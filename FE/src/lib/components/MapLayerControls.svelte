<script lang="ts">
	import {
		createDefaultMapLayers,
		getBaseFillLayer,
		getLandFillLayer,
		layerZoomHint,
		MAP_LAYER_GROUPS,
		MAP_LAYER_KEYS,
		MAP_LAYER_LABELS,
		withBaseFillLayer,
		withLandFillLayer,
		type MapLayerKey,
		type MapLayerStyle
	} from '@shared/map-style';

	interface Props {
		value?: MapLayerStyle;
		emptyFillOnly?: boolean;
	}

	let {
		value = $bindable(createDefaultMapLayers()),
		emptyFillOnly = false
	}: Props = $props();

	const emptyFill = $derived(getBaseFillLayer(value));
	const landFill = $derived(getLandFillLayer(value));

	function updateColor(key: MapLayerKey, color: string) {
		value = {
			...value,
			[key]: { ...value[key], color }
		};
	}

	function selectEmptyFill(key: string) {
		value = withBaseFillLayer(value, key as MapLayerKey);
	}

	function selectLandFill(key: string) {
		value = withLandFillLayer(value, key as MapLayerKey);
	}

	function onVisibilityToggle(key: MapLayerKey, checked: boolean) {
		value = {
			...value,
			[key]: { ...value[key], enabled: checked }
		};
	}
</script>

<div class="space-y-4">
	<div class="space-y-1">
		<h3 class="text-sm font-medium text-ink">Map layers</h3>
		{#if emptyFillOnly}
			<p class="text-xs text-ink-subtle">Empty fill color for stripe gaps.</p>
		{:else}
			<p class="text-xs text-ink-subtle">
				Empty fill is stripe gaps (and seas when Water is off). Base land fill is continents /
				shore. Neither has to be a drawn layer.
			</p>
		{/if}
	</div>

	<label class="block space-y-2 rounded-xl border border-line p-3">
		<span class="text-sm font-medium text-ink-secondary">Empty fill</span>
		<select
			class="w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm text-ink accent-accent"
			value={emptyFill}
			onchange={(event) => selectEmptyFill(event.currentTarget.value)}
			aria-label="Empty fill layer"
		>
			{#each MAP_LAYER_KEYS as key (key)}
				<option value={key}>{MAP_LAYER_LABELS[key]}</option>
			{/each}
		</select>
		{#if !emptyFillOnly}
			<p class="text-xs text-ink-subtle">
				Stripe / projection empty space. When Water is off, seas use this color too (default: land).
			</p>
		{/if}
	</label>

	{#if emptyFillOnly}
		<div class="rounded-xl border border-line p-3">
			<div class="flex items-center justify-between gap-3">
				<span class="text-sm text-ink-secondary">{MAP_LAYER_LABELS[emptyFill]}</span>
				<input
					type="color"
					value={value[emptyFill].color}
					oninput={(event) =>
						updateColor(emptyFill, (event.currentTarget as HTMLInputElement).value)}
					class="h-8 w-12 cursor-pointer rounded border border-line-strong bg-panel p-0.5"
					aria-label="{MAP_LAYER_LABELS[emptyFill]} color"
				/>
			</div>
		</div>
	{:else}
		<label class="block space-y-2 rounded-xl border border-line p-3">
			<span class="text-sm font-medium text-ink-secondary">Base land fill</span>
			<select
				class="w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm text-ink accent-accent"
				value={landFill}
				onchange={(event) => selectLandFill(event.currentTarget.value)}
				aria-label="Base land fill layer"
			>
				{#each MAP_LAYER_KEYS as key (key)}
					<option value={key}>{MAP_LAYER_LABELS[key]}</option>
				{/each}
			</select>
			<p class="text-xs text-ink-subtle">
				Map land color from the shore (preview background while land is on, open landcover, globe
				silhouette).
			</p>
		</label>

		{#each MAP_LAYER_GROUPS as group (group.id)}
			<section class="space-y-2">
				<h4 class="text-xs font-medium uppercase tracking-wide text-ink-subtle">{group.label}</h4>
				{#each group.keys as key (key)}
					{@const hint = layerZoomHint(key)}
					<div class="rounded-xl border border-line p-3">
						<div class="flex items-center justify-between gap-3">
							<label class="flex items-center gap-2 text-sm text-ink-secondary">
								<input
									type="checkbox"
									checked={value[key].enabled}
									onchange={(event) =>
										onVisibilityToggle(
											key,
											(event.currentTarget as HTMLInputElement).checked
										)}
									class="accent-accent"
								/>
								{MAP_LAYER_LABELS[key]}
								{#if emptyFill === key}
									<span class="text-xs font-normal text-accent-ink">(empty fill)</span>
								{/if}
								{#if landFill === key}
									<span class="text-xs font-normal text-accent-ink">(land fill)</span>
								{/if}
							</label>
							<input
								type="color"
								value={value[key].color}
								disabled={!value[key].enabled && emptyFill !== key && landFill !== key}
								oninput={(event) =>
									updateColor(key, (event.currentTarget as HTMLInputElement).value)}
								class="h-8 w-12 cursor-pointer rounded border border-line-strong bg-panel p-0.5 disabled:cursor-not-allowed disabled:opacity-40"
								aria-label="{MAP_LAYER_LABELS[key]} color"
							/>
						</div>
						{#if hint}
							<p class="mt-1.5 text-xs text-ink-subtle">{hint}</p>
						{/if}
					</div>
				{/each}
			</section>
		{/each}
	{/if}
</div>
