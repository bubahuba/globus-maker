<script lang="ts">
	/** `?url` → real stylesheet link (Vite otherwise inlines CSS into HTML during SSR/dev). */
	import appCss from '../app.css?url';
	import AppNav from '@lib/components/AppNav.svelte';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="stylesheet" href={appCss} />
	<title>Globe Maker</title>
</svelte:head>

<div class="min-h-screen">
	<AppNav />
	{@render children()}
</div>
