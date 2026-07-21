<script lang="ts">
	const mapImages = [
		{
			src: '/about/map-mode-framed-wall-normal.png',
			alt: 'Framed city map print on a living-room wall in normal light',
			caption: 'Print & frame — a square city map for your wall'
		},
		{
			src: '/about/map-mode-framed-wall-enlighted.png',
			alt: 'Backlit framed city map glowing on a living-room wall',
			caption: 'Lit print — the same map as a soft lightbox'
		},
		{
			src: '/about/map-mode-artistic-saturated-normal.png',
			alt: 'Framed city map with magenta streets and teal land on a living-room wall',
			caption: 'Artistic layers — magenta streets, teal land, coral blocks'
		},
		{
			src: '/about/map-mode-artistic-saturated-lit.png',
			alt: 'Backlit framed city map with cobalt, pink, and lime colors',
			caption: 'Neon lightbox — cobalt land, pink streets, lime parks'
		},
		{
			src: '/about/map-mode-artistic-poster.png',
			alt: 'Framed mustard and burgundy artistic city map poster on a wall',
			caption: 'Poster vibe — mustard land, burgundy streets, aqua blocks'
		}
	] as const;

	const globeImages = [
		{
			src: '/about/sphere-lamp-map-projection-hero.png',
			alt: 'City map sphere lamp projecting soft map light in a living room',
			caption: 'Sphere lamp — your city map wrapped on glass'
		},
		{
			src: '/about/sphere-lamp-map-wrap-detail.png',
			alt: 'Close-up of transparent city map wrap on a glowing glass sphere',
			caption: 'Map wrap — streets and buildings on clear film'
		},
		{
			src: '/about/sphere-lamp-room-projection-wide.png',
			alt: 'Wide view of a room lit by map projections from a sphere lamp',
			caption: 'Room glow — meridians cast softly on the walls'
		},
		{
			src: '/about/globe-mode-artistic-sphere-hero.png',
			alt: 'Sphere lamp with violet, neon yellow, and fuchsia city map wrap',
			caption: 'Bold sphere — violet land, neon streets, fuchsia blocks'
		},
		{
			src: '/about/globe-mode-artistic-wrap-detail.png',
			alt: 'Close-up of crimson and indigo artistic city map on glass sphere',
			caption: 'Color wrap — crimson streets, indigo blocks, chartreuse parks'
		},
		{
			src: '/about/globe-mode-artistic-room-wide.png',
			alt: 'Room washed in colorful projections from an artistic city-map sphere lamp',
			caption: 'Color wash — tangerine land casting pink and teal light'
		}
	] as const;
</script>

<svelte:head>
	<title>About · Globus Maker</title>
	<meta
		name="description"
		content="Make a square city map or globe meridian stripes from any place on OpenStreetMap."
	/>
</svelte:head>

<main class="mx-auto max-w-6xl px-4 py-10 sm:py-14">
	<header class="max-w-2xl space-y-3">
		<p class="text-sm font-medium tracking-wide text-amber-800 uppercase">About</p>
		<h1 class="text-3xl font-semibold tracking-tight text-stone-900 sm:text-4xl">
			Your place, as a map or a globe
		</h1>
		<p class="text-lg leading-relaxed text-stone-600">
			Pick any spot on the map. Globus Maker builds a clean OpenStreetMap export you can print
			flat, or cut into stripes for a physical globe. Quiet natural colors — or push every layer
			into something unexpected.
		</p>
	</header>

	<section class="mt-14 space-y-6" aria-labelledby="map-mode-heading">
		<div class="max-w-2xl space-y-3">
			<p class="text-sm font-medium tracking-wide text-amber-800 uppercase">Map mode</p>
			<h2 id="map-mode-heading" class="text-2xl font-semibold text-stone-900">
				Square map for print
			</h2>
			<p class="leading-relaxed text-stone-600">
				Choose a center and size, tune layers and colors, then download a square SVG or JPEG.
				Hang it as a framed print, light it from behind, or go full poster with saturated
				custom hues.
			</p>
		</div>

		<div class="grid gap-5 sm:grid-cols-2">
			{#each mapImages as image (image.src)}
				<figure class="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-stone-200">
					<img
						src={image.src}
						alt={image.alt}
						class="aspect-video w-full object-cover"
						loading="lazy"
					/>
					<figcaption class="px-4 py-3 text-sm text-stone-600">{image.caption}</figcaption>
				</figure>
			{/each}
		</div>
	</section>

	<section class="mt-16 space-y-6" aria-labelledby="globe-mode-heading">
		<div class="max-w-2xl space-y-3">
			<p class="text-sm font-medium tracking-wide text-amber-800 uppercase">Globe mode</p>
			<h2 id="globe-mode-heading" class="text-2xl font-semibold text-stone-900">
				Meridian stripes for a sphere
			</h2>
			<p class="leading-relaxed text-stone-600">
				Same city map, remapped for a globe. You get print-ready JPEG stripes (plus pole caps)
				sized to your diameter — wrap a lamp, build a sphere, or flood the room with soft
				(or wildly colorful) city light.
			</p>
		</div>

		<div class="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
			{#each globeImages as image, i (image.src)}
				<figure
					class="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-stone-200
						{i === 0 || i === 3 ? 'sm:col-span-2 lg:col-span-3' : ''}"
				>
					<img
						src={image.src}
						alt={image.alt}
						class="w-full object-cover {i === 0 || i === 3
							? 'aspect-[21/9] sm:aspect-[2.4/1]'
							: 'aspect-video'}"
						loading="lazy"
					/>
					<figcaption class="px-4 py-3 text-sm text-stone-600">{image.caption}</figcaption>
				</figure>
			{/each}
		</div>
	</section>

	<section
		class="mt-16 rounded-2xl bg-white px-6 py-8 shadow-sm ring-1 ring-stone-200 sm:px-8"
		aria-labelledby="how-it-works-heading"
	>
		<h2 id="how-it-works-heading" class="text-xl font-semibold text-stone-900">How it works</h2>
		<ol class="mt-5 grid gap-4 sm:grid-cols-3">
			<li class="space-y-1">
				<p class="text-sm font-semibold text-amber-900">1. Place</p>
				<p class="text-sm leading-relaxed text-stone-600">
					Search a city or click the map. Set how wide the square should be.
				</p>
			</li>
			<li class="space-y-1">
				<p class="text-sm font-semibold text-amber-900">2. Style</p>
				<p class="text-sm leading-relaxed text-stone-600">
					Toggle streets, water, buildings, and labels. Soft natural tones or bold custom
					colors — your call.
				</p>
			</li>
			<li class="space-y-1">
				<p class="text-sm font-semibold text-amber-900">3. Download</p>
				<p class="text-sm leading-relaxed text-stone-600">
					Get a square map file, or a zip of globe stripes ready to print and assemble.
				</p>
			</li>
		</ol>
		<p class="mt-8">
			<a
				href="/"
				class="inline-flex items-center rounded-xl bg-amber-800 px-4 py-2.5 text-sm font-medium text-amber-50 transition hover:bg-amber-900"
			>
				Open Globus Maker App
			</a>
		</p>
	</section>
</main>
