<script lang="ts">
	import { browser } from '$app/environment';
	import { onDestroy, onMount } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

	/** Client safety net; server already serves ≤6000px equirectangular preview. */
	const MAX_EDGE = 6000;
	const STAR_COUNT = 4000;
	const SUN_DIR = new THREE.Vector3(4.2, 1.4, 2.6);

	interface Props {
		/** URL of stripe panorama preview JPEG (query string ignored for reload). */
		src: string;
		title?: string;
	}

	let { src, title = 'Sphere preview' }: Props = $props();

	let shellEl: HTMLDivElement | undefined = $state();
	let container: HTMLDivElement | undefined = $state();
	let statusMessage = $state('Loading sphere preview…');
	let isFullscreen = $state(false);
	/** Assume supported; hide only if the API is clearly missing after mount. */
	let fullscreenSupported = $state(true);

	/** Path only — ignore ?v= cache-bust so stripe uploads don't remount the globe. */
	const loadKey = $derived(src.split('?')[0] || src);

	function syncFullscreenState() {
		isFullscreen = document.fullscreenElement === shellEl;
	}

	async function toggleFullscreen() {
		if (!shellEl) return;
		try {
			if (document.fullscreenElement === shellEl) {
				await document.exitFullscreen();
			} else if (typeof shellEl.requestFullscreen === 'function') {
				await shellEl.requestFullscreen();
			}
		} catch {
			// Fullscreen request may be denied by the browser; ignore.
		}
	}

	let loadedKey = '';
	let renderer: THREE.WebGLRenderer | null = null;
	let animationId = 0;
	let resizeObserver: ResizeObserver | null = null;
	let sceneResources: {
		geometry: THREE.BufferGeometry;
		material: THREE.Material;
		texture: THREE.Texture;
		controls: OrbitControls;
		globe: THREE.Object3D;
		starsGeometry: THREE.BufferGeometry;
		starsMaterial: THREE.Material;
		sunTexture: THREE.Texture;
		sunMaterial: THREE.Material;
	} | null = null;

	/** Random stars on a spherical shell around the globe. */
	function createStarfield(count = STAR_COUNT) {
		const positions = new Float32Array(count * 3);
		const colors = new Float32Array(count * 3);
		for (let i = 0; i < count; i++) {
			const r = 12 + Math.random() * 50;
			const theta = Math.random() * Math.PI * 2;
			const phi = Math.acos(2 * Math.random() - 1);
			const sinPhi = Math.sin(phi);
			positions[i * 3] = r * sinPhi * Math.cos(theta);
			positions[i * 3 + 1] = r * sinPhi * Math.sin(theta);
			positions[i * 3 + 2] = r * Math.cos(phi);
			// Slight warm/cool variation so stars read on black.
			const tint = 0.75 + Math.random() * 0.25;
			const cool = Math.random() * 0.12;
			colors[i * 3] = tint;
			colors[i * 3 + 1] = tint - cool * 0.35;
			colors[i * 3 + 2] = Math.min(1, tint + cool);
		}
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
		geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
		const material = new THREE.PointsMaterial({
			size: 2.2,
			sizeAttenuation: false,
			vertexColors: true,
			transparent: true,
			opacity: 0.95,
			depthWrite: false
		});
		return { points: new THREE.Points(geometry, material), geometry, material };
	}

	/** Soft additive sun disc placed along the key-light direction. */
	function createSun(direction: THREE.Vector3, distance = 46) {
		const size = 256;
		const canvas = document.createElement('canvas');
		canvas.width = size;
		canvas.height = size;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Canvas unavailable');
		const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
		g.addColorStop(0, 'rgba(255, 255, 245, 1)');
		g.addColorStop(0.12, 'rgba(255, 236, 180, 0.95)');
		g.addColorStop(0.35, 'rgba(255, 190, 90, 0.45)');
		g.addColorStop(0.65, 'rgba(255, 140, 50, 0.12)');
		g.addColorStop(1, 'rgba(255, 120, 40, 0)');
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, size, size);

		const texture = new THREE.CanvasTexture(canvas);
		texture.colorSpace = THREE.SRGBColorSpace;
		const material = new THREE.SpriteMaterial({
			map: texture,
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
			toneMapped: false
		});
		const sprite = new THREE.Sprite(material);
		sprite.scale.setScalar(9.5);
		sprite.position.copy(direction).normalize().multiplyScalar(distance);
		return { sprite, texture, material };
	}

	function disposeViewer() {
		if (animationId) {
			cancelAnimationFrame(animationId);
			animationId = 0;
		}
		resizeObserver?.disconnect();
		resizeObserver = null;
		if (sceneResources) {
			sceneResources.controls.dispose();
			sceneResources.geometry.dispose();
			sceneResources.material.dispose();
			sceneResources.texture.dispose();
			sceneResources.starsGeometry.dispose();
			sceneResources.starsMaterial.dispose();
			sceneResources.sunTexture.dispose();
			sceneResources.sunMaterial.dispose();
			sceneResources = null;
		}
		if (renderer) {
			renderer.dispose();
			renderer.domElement.remove();
			renderer = null;
		}
	}

	async function loadTexture(url: string): Promise<THREE.CanvasTexture> {
		const img = new Image();
		img.decoding = 'async';
		img.src = url;
		await img.decode();

		const width = img.naturalWidth;
		const height = img.naturalHeight;
		if (!width || !height) throw new Error('Image has no dimensions');

		const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
		const w = Math.max(1, Math.round(width * scale));
		const h = Math.max(1, Math.round(height * scale));

		const canvas = document.createElement('canvas');
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Canvas unavailable');
		ctx.drawImage(img, 0, 0, w, h);

		const texture = new THREE.CanvasTexture(canvas);
		texture.colorSpace = THREE.SRGBColorSpace;
		texture.anisotropy = 8;
		return texture;
	}

	async function mountGlobe(el: HTMLDivElement, url: string) {
		disposeViewer();
		el.replaceChildren();
		statusMessage = 'Loading preview…';

		const texture = await loadTexture(url);

		const nextScene = new THREE.Scene();
		nextScene.background = new THREE.Color(0x000000);

		const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
		camera.position.set(0, 0.35, 2.6);

		const webgl = new THREE.WebGLRenderer({ antialias: true, alpha: false });
		webgl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		webgl.outputColorSpace = THREE.SRGBColorSpace;
		webgl.toneMapping = THREE.ACESFilmicToneMapping;
		webgl.toneMappingExposure = 1.05;
		webgl.setClearColor(0x000000, 1);
		el.appendChild(webgl.domElement);
		renderer = webgl;

		const stars = createStarfield();
		nextScene.add(stars.points);

		const sunLight = new THREE.DirectionalLight(0xfff1dd, 1.55);
		sunLight.position.copy(SUN_DIR);
		nextScene.add(sunLight);
		const sun = createSun(SUN_DIR);
		nextScene.add(sun.sprite);
		nextScene.add(new THREE.AmbientLight(0x9aa8c4, 0.42));
		const nightFill = new THREE.DirectionalLight(0x6d7fa8, 0.22);
		nightFill.position.set(-3.5, -0.4, -2.2);
		nextScene.add(nightFill);

		// DePolar panorama: top = map centre (north pole), bottom = rim / south.
		const geometry = new THREE.SphereGeometry(1, 96, 64);
		const material = new THREE.MeshStandardMaterial({
			map: texture,
			roughness: 0.92,
			metalness: 0
		});
		const globe = new THREE.Mesh(geometry, material);
		nextScene.add(globe);

		const controls = new OrbitControls(camera, webgl.domElement);
		controls.enableDamping = true;
		controls.dampingFactor = 0.06;
		controls.minDistance = 1.35;
		controls.maxDistance = 5;
		controls.target.set(0, 0, 0);
		controls.update();

		sceneResources = {
			geometry,
			material,
			texture,
			controls,
			globe,
			starsGeometry: stars.geometry,
			starsMaterial: stars.material,
			sunTexture: sun.texture,
			sunMaterial: sun.material
		};

		const fit = () => {
			const w = el.clientWidth || 1;
			const h = el.clientHeight || 1;
			camera.aspect = w / h;
			camera.updateProjectionMatrix();
			webgl.setSize(w, h, false);
		};
		fit();
		resizeObserver = new ResizeObserver(fit);
		resizeObserver.observe(el);

		const tick = () => {
			animationId = requestAnimationFrame(tick);
			globe.rotation.y += 0.0015;
			controls.update();
			webgl.render(nextScene, camera);
		};
		tick();

		statusMessage = '';
	}

	onMount(() => {
		if (!shellEl) return;

		fullscreenSupported =
			!!document.fullscreenEnabled && typeof shellEl.requestFullscreen === 'function';
		document.addEventListener('fullscreenchange', syncFullscreenState);
		syncFullscreenState();

		return () => {
			document.removeEventListener('fullscreenchange', syncFullscreenState);
		};
	});

	$effect(() => {
		if (!browser) return;

		const el = container;
		const key = loadKey;
		const url = src;
		if (!el || !key || !url) return;
		if (key === loadedKey && renderer) return;

		loadedKey = key;
		statusMessage = 'Loading sphere preview…';
		let cancelled = false;

		void (async () => {
			try {
				// Load with full URL (incl. ?v= cache-bust); key only dedupes remounts.
				await mountGlobe(el, url);
				if (cancelled) disposeViewer();
			} catch (err) {
				if (cancelled) return;
				disposeViewer();
				statusMessage =
					err instanceof Error ? err.message : 'Could not open sphere preview.';
			}
		})();

		return () => {
			cancelled = true;
		};
	});

	onDestroy(() => {
		disposeViewer();
		loadedKey = '';
	});
</script>

<div class="space-y-1.5">
	<div
		bind:this={shellEl}
		class="relative overflow-hidden bg-black ring-1 ring-stone-800 {isFullscreen
			? 'h-screen w-screen rounded-none'
			: 'h-[min(50vh,28rem)] w-full rounded-lg'}"
	>
		<div bind:this={container} class="h-full w-full" aria-label={title}></div>
		{#if statusMessage}
			<p
				class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/85 px-4 text-center text-sm text-stone-200"
			>
				{statusMessage}
			</p>
		{/if}
		{#if fullscreenSupported}
			<button
				type="button"
				onclick={toggleFullscreen}
				aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
				title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
				class="absolute top-3 right-3 z-20 flex h-9 w-9 items-center justify-center rounded-lg bg-white/90 text-stone-700 shadow-md ring-1 ring-stone-300/80 backdrop-blur-sm transition hover:bg-white"
			>
				{#if isFullscreen}
					<svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						class="h-4 w-4"
						aria-hidden="true"
					>
						<path d="M8 3v3a2 2 0 0 1-2 2H3" />
						<path d="M21 8h-3a2 2 0 0 1-2-2V3" />
						<path d="M3 16h3a2 2 0 0 1 2 2v3" />
						<path d="M16 21v-3a2 2 0 0 1 2-2h3" />
					</svg>
				{:else}
					<svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						class="h-4 w-4"
						aria-hidden="true"
					>
						<path d="M8 3H5a2 2 0 0 0-2 2v3" />
						<path d="M21 8V5a2 2 0 0 0-2-2h-3" />
						<path d="M3 16v3a2 2 0 0 0 2 2h3" />
						<path d="M16 21h3a2 2 0 0 0 2-2v-3" />
					</svg>
				{/if}
			</button>
		{/if}
	</div>
	<p class="text-xs text-stone-400">Drag to orbit · scroll to zoom</p>
</div>
