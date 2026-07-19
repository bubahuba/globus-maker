<script lang="ts">
	import '../app.css';
	import 'leaflet/dist/leaflet.css';
	import 'maplibre-gl/dist/maplibre-gl.css';

	let { children } = $props();
</script>

<div class="min-h-screen">
	{@render children()}
</div>
