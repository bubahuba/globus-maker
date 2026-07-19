<script lang="ts">
	import { onDestroy } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

	/** Keep under typical WebGL MAX_TEXTURE_SIZE. */
	const MAX_EDGE = 4096;

	interface Props {
		/** URL of input-distorted.jpg (query string ignored for reload). */
		src: string;
		title?: string;
	}

	let { src, title = 'Sphere preview' }: Props = $props();

	let container: HTMLDivElement | undefined = $state();
	let statusMessage = $state('Loading sphere preview…');

	/** Only the path matters — ignore ?v= cache-bust from stripe uploads. */
	const stableSrc = $derived(src.split('?')[0] ?? '');

	let loadedPath = '';
	let renderer: THREE.WebGLRenderer | null = null;
	let animationId = 0;
	let resizeObserver: ResizeObserver | null = null;

	function disposeViewer() {
		if (animationId) {
			cancelAnimationFrame(animationId);
			animationId = 0;
		}
		resizeObserver?.disconnect();
		resizeObserver = null;
		if (renderer) {
			renderer.dispose();
			renderer.domElement.remove();
			renderer = null;
		}
	}

	async function loadTexture(url: string): Promise<THREE.Texture> {
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

		const scene = new THREE.Scene();
		scene.background = new THREE.Color(0xf5f5f4);

		const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
		camera.position.set(0, 0.35, 2.6);

		const webgl = new THREE.WebGLRenderer({ antialias: true, alpha: false });
		webgl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		webgl.outputColorSpace = THREE.SRGBColorSpace;
		el.appendChild(webgl.domElement);
		renderer = webgl;

		const ambient = new THREE.AmbientLight(0xffffff, 0.85);
		const key = new THREE.DirectionalLight(0xffffff, 0.65);
		key.position.set(3, 2, 4);
		scene.add(ambient, key);

		const geometry = new THREE.SphereGeometry(1, 96, 64);
		// Outside of the sphere (globe), not inside a panorama.
		const material = new THREE.MeshStandardMaterial({
			map: texture,
			roughness: 0.85,
			metalness: 0.05
		});
		const globe = new THREE.Mesh(geometry, material);
		scene.add(globe);

		const controls = new OrbitControls(camera, webgl.domElement);
		controls.enableDamping = true;
		controls.dampingFactor = 0.06;
		controls.minDistance = 1.35;
		controls.maxDistance = 5;
		controls.target.set(0, 0, 0);
		controls.update();

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
			webgl.render(scene, camera);
		};
		tick();

		statusMessage = '';
	}

	$effect(() => {
		const el = container;
		const path = stableSrc;
		if (!el || !path) return;
		if (path === loadedPath && renderer) return;

		loadedPath = path;
		statusMessage = 'Loading sphere preview…';
		let cancelled = false;

		void (async () => {
			try {
				await mountGlobe(el, path);
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
		loadedPath = '';
	});
</script>

<div class="space-y-1.5">
	<div class="relative h-[min(50vh,28rem)] w-full">
		<div
			bind:this={container}
			class="h-full w-full overflow-hidden rounded-lg bg-stone-100 ring-1 ring-stone-200"
			aria-label={title}
		></div>
		{#if statusMessage}
			<p
				class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-stone-100/95 px-4 text-center text-sm text-amber-800 ring-1 ring-stone-200"
			>
				{statusMessage}
			</p>
		{/if}
	</div>
	<p class="text-xs text-stone-400">Drag to orbit · scroll to zoom</p>
</div>
