<script lang="ts">
	import { page } from '$app/state';
	import { env } from '$env/dynamic/public';
	import {
		SITE_NAME,
		absoluteUrl,
		type OgImage
	} from '@lib/seo';

	interface Props {
		title: string;
		description: string;
		images?: readonly OgImage[];
		type?: 'website' | 'article';
	}

	let {
		title,
		description,
		images = [],
		type = 'website'
	}: Props = $props();

	const origin = $derived(
		(env.PUBLIC_SITE_ORIGIN?.replace(/\/$/, '') || page.url.origin).replace(/\/$/, '')
	);
	const canonical = $derived(absoluteUrl(origin, page.url.pathname || '/'));
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content={description} />
	<link rel="canonical" href={canonical} />

	<meta property="og:type" content={type} />
	<meta property="og:site_name" content={SITE_NAME} />
	<meta property="og:locale" content="en_US" />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={canonical} />

	{#each images as image (image.path)}
		<meta property="og:image" content={absoluteUrl(origin, image.path)} />
		<meta property="og:image:secure_url" content={absoluteUrl(origin, image.path)} />
		<meta property="og:image:type" content={image.type ?? 'image/png'} />
		<meta property="og:image:width" content={String(image.width)} />
		<meta property="og:image:height" content={String(image.height)} />
		<meta property="og:image:alt" content={image.alt} />
	{/each}

	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={title} />
	<meta name="twitter:description" content={description} />
	{#if images[0]}
		<meta name="twitter:image" content={absoluteUrl(origin, images[0].path)} />
		<meta name="twitter:image:alt" content={images[0].alt} />
	{/if}
</svelte:head>
