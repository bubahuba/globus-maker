<script lang="ts">
	import { onDestroy } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

	/** Client safety net; server already serves ≤6000px equirectangular preview. */
	const MAX_EDGE = 6000;

	interface Props {
		/** URL of stripe panorama preview JPEG (query string ignored for reload). */
		src: string;
		title?: string;
		/** Empty fill hex — drives the soft gradient behind the sphere. */
		backgroundColor?: string;
	}

	let {
		src,
		title = 'Sphere preview',
		backgroundColor = '#f5f5f4'
	}: Props = $props();

	let container: HTMLDivElement | undefined = $state();
	let statusMessage = $state('Loading sphere preview…');

	/** Path only — ignore ?v= cache-bust so stripe uploads don't remount the globe. */
	const loadKey = $derived(src.split('?')[0] || src);

	/** Radial wash around Empty fill so the globe rim stays readable on matching fills. */
	const backgroundGradient = $derived(gradientFromBase(backgroundColor));

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
	} | null = null;

	function parseHex(hex: string): { r: number; g: number; b: number } | null {
		const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
		if (!m) return null;
		const n = parseInt(m[1], 16);
		return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
	}

	function mixChannel(ch: number, toward: number, amount: number): number {
		return Math.round(ch + (toward - ch) * amount);
	}

	function mixHex(hex: string, toward: number, amount: number): string {
		const c = parseHex(hex);
		if (!c) return hex;
		const r = mixChannel(c.r, toward, amount);
		const g = mixChannel(c.g, toward, amount);
		const b = mixChannel(c.b, toward, amount);
		return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
	}

	function gradientFromBase(base: string): string {
		const dark = mixHex(base, 0, 0.32);
		const light = mixHex(base, 255, 0.16);
		return `radial-gradient(ellipse 125% 110% at 50% 38%, ${dark} 0%, ${base} 48%, ${light} 100%)`;
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
		statusMessage = 'Preparing globe…';

		const texture = await loadTexture(url);

		const nextScene = new THREE.Scene();
		// Transparent clear — CSS gradient on the host provides depth/contrast.
		nextScene.background = null;

		const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
		camera.position.set(0, 0.35, 2.6);

		const webgl = new THREE.WebGLRenderer({ antialias: true, alpha: true });
		webgl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		webgl.outputColorSpace = THREE.SRGBColorSpace;
		webgl.setClearColor(0x000000, 0);
		el.appendChild(webgl.domElement);
		renderer = webgl;

		// DePolar panorama: top = map centre (north pole), bottom = rim / south.
		const geometry = new THREE.SphereGeometry(1, 96, 64);
		const material = new THREE.MeshBasicMaterial({ map: texture });
		const globe = new THREE.Mesh(geometry, material);
		nextScene.add(globe);

		const controls = new OrbitControls(camera, webgl.domElement);
		controls.enableDamping = true;
		controls.dampingFactor = 0.06;
		controls.minDistance = 1.35;
		controls.maxDistance = 5;
		controls.target.set(0, 0, 0);
		controls.update();

		sceneResources = { geometry, material, texture, controls, globe };

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

	$effect(() => {
		const el = container;
		const key = loadKey;
		if (!el || !key) return;
		if (key === loadedKey && renderer) return;

		loadedKey = key;
		statusMessage = 'Loading sphere preview…';
		let cancelled = false;

		void (async () => {
			try {
				await mountGlobe(el, key);
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
	<div class="relative h-[min(50vh,28rem)] w-full">
		<div
			bind:this={container}
			class="h-full w-full overflow-hidden rounded-lg ring-1 ring-stone-200"
			style:background={backgroundGradient}
			aria-label={title}
		></div>
		{#if statusMessage}
			<p
				class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg px-4 text-center text-sm text-amber-800 ring-1 ring-stone-200"
				style:background={backgroundGradient}
			>
				{statusMessage}
			</p>
		{/if}
	</div>
	<p class="text-xs text-stone-400">Drag to orbit · scroll to zoom</p>
</div>
