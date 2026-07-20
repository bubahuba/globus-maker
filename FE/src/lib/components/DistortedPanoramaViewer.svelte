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
	}

	let { src, title = 'Sphere preview' }: Props = $props();

	let container: HTMLDivElement | undefined = $state();
	let statusMessage = $state('Loading sphere preview…');

	/** Path only — ignore ?v= cache-bust so stripe uploads don't remount the globe. */
	const loadKey = $derived(src.split('?')[0] || src);

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

		const scene = new THREE.Scene();
		scene.background = new THREE.Color(0xf5f5f4);

		const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
		camera.position.set(0, 0.35, 2.6);

		const webgl = new THREE.WebGLRenderer({ antialias: true, alpha: false });
		webgl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		webgl.outputColorSpace = THREE.SRGBColorSpace;
		el.appendChild(webgl.domElement);
		renderer = webgl;

		// DePolar panorama: top = map centre (north pole), bottom = rim / south.
		const geometry = new THREE.SphereGeometry(1, 96, 64);
		const material = new THREE.MeshBasicMaterial({ map: texture });
		const globe = new THREE.Mesh(geometry, material);
		scene.add(globe);

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
			webgl.render(scene, camera);
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
