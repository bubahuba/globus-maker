<script lang="ts">
	import '../app.css';
	import 'leaflet/dist/leaflet.css';
	import 'maplibre-gl/dist/maplibre-gl.css';
	import AppNav from '@lib/components/AppNav.svelte';

	let { children } = $props();
</script>

<div class="min-h-screen">
	<AppNav />
	{@render children()}
</div>
