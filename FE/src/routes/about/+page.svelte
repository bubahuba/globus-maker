<script lang="ts">
	import AboutImageLightbox from '@lib/components/AboutImageLightbox.svelte';
	import SeoHead from '@lib/components/SeoHead.svelte';
	import { ABOUT_DESCRIPTION, ABOUT_OG_IMAGES, SITE_NAME } from '@lib/seo';

	type AboutImage = {
		slug: string;
		alt: string;
		caption: string;
	};

	const mapImages: readonly AboutImage[] = [
		{
			slug: 'map-mode-framed-wall-normal',
			alt: 'Framed city map print on a living-room wall in normal light',
			caption: 'Print & frame — a square city map for your wall'
		},
		{
			slug: 'map-mode-framed-wall-enlighted',
			alt: 'Backlit framed city map glowing on a living-room wall',
			caption: 'Lit print — the same map as a soft lightbox'
		},
		{
			slug: 'map-mode-artistic-saturated-normal',
			alt: 'Framed city map with magenta streets and teal land on a living-room wall',
			caption: 'Artistic layers — magenta streets, teal land, coral blocks'
		},
		{
			slug: 'map-mode-artistic-saturated-lit',
			alt: 'Backlit framed city map with cobalt, pink, and lime colors',
			caption: 'Neon lightbox — cobalt land, pink streets, lime parks'
		},
		{
			slug: 'map-mode-artistic-poster',
			alt: 'Framed mustard and burgundy artistic city map poster on a wall',
			caption: 'Poster vibe — mustard land, burgundy streets, aqua blocks'
		}
	];

	const globeImages: readonly AboutImage[] = [
		{
			slug: 'sphere-lamp-map-projection-hero',
			alt: 'City map sphere lamp projecting soft map light in a living room',
			caption: 'Sphere lamp — your city map wrapped on glass'
		},
		{
			slug: 'sphere-lamp-map-wrap-detail',
			alt: 'Close-up of transparent city map wrap on a glowing glass sphere',
			caption: 'Map wrap — streets and buildings on clear film'
		},
		{
			slug: 'sphere-lamp-room-projection-wide',
			alt: 'Wide view of a room lit by map projections from a sphere lamp',
			caption: 'Room glow — meridians cast softly on the walls'
		},
		{
			slug: 'globe-mode-artistic-sphere-hero',
			alt: 'Sphere lamp with violet, neon yellow, and fuchsia city map wrap',
			caption: 'Bold sphere — violet land, neon streets, fuchsia blocks'
		},
		{
			slug: 'globe-mode-artistic-wrap-detail',
			alt: 'Close-up of crimson and indigo artistic city map on glass sphere',
			caption: 'Color wrap — crimson streets, indigo blocks, chartreuse parks'
		},
		{
			slug: 'globe-mode-artistic-room-wide',
			alt: 'Room washed in colorful projections from an artistic city-map sphere lamp',
			caption: 'Color wash — tangerine land casting pink and teal light'
		},
		{
			slug: 'globe-mode-diy-stripe-assembly',
			alt: 'Aerial map stripes being glued onto a papier-mâché globe on a work table',
			caption: 'DIY assembly — map stripes glued onto a sphere'
		},
		{
			slug: 'globe-mode-diy-clear-coat',
			alt: 'Person spraying clear coat onto a finished aerial-map globe outdoors',
			caption: 'Clear coat — sealing the finished sphere'
		}
	];

	const THUMB_SRCSET = (slug: string) =>
		`/about/${slug}-640.webp 640w, /about/${slug}-960.webp 960w, /about/${slug}-1280.webp 1280w`;

	const THUMB_SRC = (slug: string) => `/about/${slug}-960.webp`;

	type Gallery = 'map' | 'globe';

	let lightboxGallery = $state<Gallery | null>(null);
	let lightboxIndex = $state<number | null>(null);

	const lightboxImages = $derived(
		lightboxGallery === 'map' ? mapImages : lightboxGallery === 'globe' ? globeImages : []
	);

	function openLightbox(gallery: Gallery, index: number) {
		lightboxGallery = gallery;
		lightboxIndex = index;
	}

	function closeLightbox() {
		lightboxGallery = null;
		lightboxIndex = null;
	}

	function navigateLightbox(index: number) {
		lightboxIndex = index;
	}
</script>

<SeoHead
	title={`About · ${SITE_NAME}`}
	description={ABOUT_DESCRIPTION}
	images={ABOUT_OG_IMAGES}
/>

<main class="mx-auto max-w-6xl px-4 py-10 sm:py-14">
	<header class="max-w-2xl space-y-3">
		<p class="text-sm font-medium tracking-wide text-accent-ink uppercase">About</p>
		<h1 class="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
			Your place, as a map or a globe
		</h1>
		<p class="text-lg leading-relaxed text-ink-secondary">
			Pick any spot on the map. Globe Maker builds a clean OpenStreetMap export you can print
			flat, or cut into stripes for a physical globe. Quiet natural colors — or push every layer
			into something unexpected.
		</p>
	</header>

	<section class="mt-14 space-y-6" aria-labelledby="map-mode-heading">
		<div class="max-w-2xl space-y-3">
			<p class="text-sm font-medium tracking-wide text-accent-ink uppercase">Map mode</p>
			<h2 id="map-mode-heading" class="text-2xl font-semibold text-ink">
				Square map for print
			</h2>
			<p class="leading-relaxed text-ink-secondary">
				Choose a center and size, tune layers and colors, then download a square SVG or JPEG.
				Hang it as a framed print, light it from behind, or go full poster with saturated
				custom hues.
			</p>
		</div>

		<div class="grid gap-5 sm:grid-cols-2">
			{#each mapImages as image, i (image.slug)}
				<figure class="overflow-hidden rounded-2xl bg-panel shadow-sm ring-1 ring-line">
					<button
						type="button"
						class="group block w-full cursor-zoom-in text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
						onclick={() => openLightbox('map', i)}
						aria-label={`View larger: ${image.caption}`}
					>
						<img
							src={THUMB_SRC(image.slug)}
							srcset={THUMB_SRCSET(image.slug)}
							sizes="(min-width: 640px) 50vw, 100vw"
							alt={image.alt}
							class="aspect-video w-full object-cover transition group-hover:opacity-90"
							loading="lazy"
						/>
					</button>
					<figcaption class="px-4 py-3 text-sm text-ink-secondary">{image.caption}</figcaption>
				</figure>
			{/each}
		</div>
	</section>

	<section class="mt-16 space-y-6" aria-labelledby="globe-mode-heading">
		<div class="max-w-2xl space-y-3">
			<p class="text-sm font-medium tracking-wide text-accent-ink uppercase">Globe mode</p>
			<h2 id="globe-mode-heading" class="text-2xl font-semibold text-ink">
				Meridian stripes for a sphere
			</h2>
			<p class="leading-relaxed text-ink-secondary">
				Same city map, remapped for a globe. You get print-ready JPEG stripes (plus pole caps)
				sized to your diameter — wrap a lamp, build a sphere, or flood the room with soft
				(or wildly colorful) city light.
			</p>
		</div>

		<div class="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
			{#each globeImages as image, i (image.slug)}
				<figure
					class="overflow-hidden rounded-2xl bg-panel shadow-sm ring-1 ring-line
						{i === 0 || i === 3 ? 'sm:col-span-2 lg:col-span-3' : ''}"
				>
					<button
						type="button"
						class="group block w-full cursor-zoom-in text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
						onclick={() => openLightbox('globe', i)}
						aria-label={`View larger: ${image.caption}`}
					>
						<img
							src={THUMB_SRC(image.slug)}
							srcset={THUMB_SRCSET(image.slug)}
							sizes={i === 0 || i === 3
								? '(min-width: 1024px) 72rem, 100vw'
								: '(min-width: 1024px) 24rem, (min-width: 640px) 50vw, 100vw'}
							alt={image.alt}
							class="w-full object-cover transition group-hover:opacity-90 {i === 0 || i === 3
								? 'aspect-[21/9] sm:aspect-[2.4/1]'
								: 'aspect-video'}"
							loading="lazy"
						/>
					</button>
					<figcaption class="px-4 py-3 text-sm text-ink-secondary">{image.caption}</figcaption>
				</figure>
			{/each}
		</div>
	</section>

	<section
		class="mt-16 rounded-2xl bg-panel px-6 py-8 shadow-sm ring-1 ring-line sm:px-8"
		aria-labelledby="how-it-works-heading"
	>
		<h2 id="how-it-works-heading" class="text-xl font-semibold text-ink">How it works</h2>
		<ol class="mt-5 grid gap-4 sm:grid-cols-3">
			<li class="space-y-1">
				<p class="text-sm font-semibold text-accent-ink">1. Place</p>
				<p class="text-sm leading-relaxed text-ink-secondary">
					Search a city or click the map. Set how wide the square should be.
				</p>
			</li>
			<li class="space-y-1">
				<p class="text-sm font-semibold text-accent-ink">2. Style</p>
				<p class="text-sm leading-relaxed text-ink-secondary">
					Toggle streets, water, buildings, and labels. Soft natural tones or bold custom
					colors — your call.
				</p>
			</li>
			<li class="space-y-1">
				<p class="text-sm font-semibold text-accent-ink">3. Download</p>
				<p class="text-sm leading-relaxed text-ink-secondary">
					Get a square map file, or a zip of globe stripes ready to print and assemble.
				</p>
			</li>
		</ol>
		<p class="mt-8">
			<a
				href="/"
				class="inline-flex items-center rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-accent-contrast transition hover:bg-accent-hover"
			>
				Open Globe Maker App
			</a>
		</p>
	</section>
</main>

<AboutImageLightbox
	images={lightboxImages}
	index={lightboxIndex}
	onClose={closeLightbox}
	onNavigate={navigateLightbox}
/>
