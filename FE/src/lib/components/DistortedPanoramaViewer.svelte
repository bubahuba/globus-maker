<script lang="ts">
	import { browser } from '$app/environment';
	import { onDestroy, onMount } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
	import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';

	/** Client safety net; server already serves ≤6000px equirectangular preview. */
	const MAX_EDGE = 6000;
	const STAR_COUNT = 4000;
	const SUN_DIR = new THREE.Vector3(4.2, 1.4, 2.6);
	/** Earth obliquity — north pole tipped toward the sun (NH summer). */
	const EARTH_AXIAL_TILT_DEG = 23.44;
	/** Far start for first-mount zoom — planet reads as a bright star. */
	const INTRO_DISTANCE = 95;
	const CAMERA_FAR = 280;
	const INTRO_ZOOM_MS = 2400;
	const CARD_LOOK = new THREE.Vector3(0, 0.35, 2.6);
	const STAGE_LOOK = new THREE.Vector3(0, 0.95, 0.85);
	const CARD_FRAMED_DISTANCE = CARD_LOOK.length();

	interface Props {
		/** URL of stripe panorama preview JPEG (query string ignored for reload). */
		src: string;
		title?: string;
		/** card = job outputs panel; stage = immersive full-bleed under nav */
		variant?: 'card' | 'stage';
		/** When true, treat square polar map like monitor fallback (DePolar). */
		depolarSquare?: boolean;
		emptyFillColor?: string;
		/** Extra right inset for the fullscreen control (e.g. archive pane open). */
		controlsOffsetRight?: string;
		/** Hide the built-in fullscreen button (parent chrome owns it). */
		hideFullscreenButton?: boolean;
	}

	let {
		src,
		title = 'Sphere preview',
		variant = 'card',
		depolarSquare = false,
		emptyFillColor = '#808080',
		controlsOffsetRight = '0.75rem',
		hideFullscreenButton = false
	}: Props = $props();

	let shellEl: HTMLDivElement | undefined = $state();
	let container: HTMLDivElement | undefined = $state();
	let statusMessage = $state('');
	let isFullscreen = $state(false);
	/** Assume supported; hide only if the API is clearly missing after mount. */
	let fullscreenSupported = $state(true);

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

	let loadedPreviewUrl = '';
	let loadedVariant: 'card' | 'stage' | '' = '';
	/** Ignore stale async texture loads when polls/clicks overlap. */
	let textureLoadSeq = 0;
	let renderer: THREE.WebGLRenderer | null = null;
	let animationId = 0;
	let introRaf = 0;
	let introCancel: (() => void) | null = null;
	/** In-flight first mount / intro; hot-swaps wait on these. */
	let mounting: Promise<void> | null = null;
	let finishing: Promise<void> | null = null;
	let resizeObserver: ResizeObserver | null = null;
	let sceneResources: {
		scene: THREE.Scene;
		camera: THREE.PerspectiveCamera;
		geometry: THREE.BufferGeometry;
		material: THREE.MeshStandardMaterial;
		texture: THREE.Texture | null;
		controls: OrbitControls;
		globe: THREE.Object3D;
		earth: THREE.Object3D;
		isStage: boolean;
		lookDir: THREE.Vector3;
		userMinDistance: number;
		userMaxDistance: number;
		introActive: boolean;
		autoFrame: boolean;
		onControlsStart?: () => void;
		starsGeometry: THREE.BufferGeometry;
		starsMaterial: THREE.Material;
		sunTexture: THREE.Texture;
		sunMaterial: THREE.Material;
		lensflare: Lensflare;
		lensflareTextures: THREE.Texture[];
		atmosphereGeometry: THREE.BufferGeometry;
		atmosphereMaterial: THREE.Material;
	} | null = null;

	function easeInOutCubic(t: number) {
		return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
	}

	function cancelIntroZoom() {
		if (introRaf) {
			cancelAnimationFrame(introRaf);
			introRaf = 0;
		}
		if (introCancel) {
			introCancel();
			introCancel = null;
		}
	}

	function framedFitDistance(camera: THREE.PerspectiveCamera) {
		const vFov = THREE.MathUtils.degToRad(camera.fov);
		const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
		const fitFov = Math.min(vFov, hFov);
		return (1 / Math.sin(fitFov / 2)) * 1.2;
	}

	/** OrbitControls clamps to maxDistance — raise it for the far intro camera. */
	function animateIntroZoom(
		camera: THREE.PerspectiveCamera,
		controls: OrbitControls,
		fromDist: number,
		toDist: number,
		lookDir: THREE.Vector3
	): Promise<void> {
		cancelIntroZoom();
		const dir = lookDir.clone().normalize();
		return new Promise((resolve) => {
			introCancel = () => resolve();
			const start = performance.now();
			const step = (now: number) => {
				if (!sceneResources) {
					introRaf = 0;
					introCancel = null;
					resolve();
					return;
				}
				const t = Math.min(1, (now - start) / INTRO_ZOOM_MS);
				const dist = fromDist + (toDist - fromDist) * easeInOutCubic(t);
				camera.position.copy(controls.target).addScaledVector(dir, dist);
				controls.update();
				if (t < 1) {
					introRaf = requestAnimationFrame(step);
					return;
				}
				introRaf = 0;
				introCancel = null;
				resolve();
			};
			introRaf = requestAnimationFrame(step);
		});
	}

	function viewerReady(): boolean {
		return !!(renderer && sceneResources?.material && sceneResources?.globe && sceneResources?.controls);
	}

	/** Snapshot view so a texture swap never drifts camera / spin. */
	function captureViewState() {
		if (!viewerReady() || !sceneResources) return null;
		const { camera, controls, globe } = sceneResources;
		return {
			cameraPos: camera.position.clone(),
			target: controls.target.clone(),
			spinY: globe.rotation.y
		};
	}

	function restoreViewState(
		state: { cameraPos: THREE.Vector3; target: THREE.Vector3; spinY: number } | null
	) {
		if (!state || !viewerReady() || !sceneResources) return;
		const { camera, controls, globe } = sceneResources;
		camera.position.copy(state.cameraPos);
		controls.target.copy(state.target);
		globe.rotation.y = state.spinY;
		controls.update();
	}

	function parseHex(hex: string): { r: number; g: number; b: number } | null {
		const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
		if (!m) return null;
		const n = parseInt(m[1], 16);
		return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
	}

	function hexToRgba(hex: string, alpha = 255): [number, number, number, number] {
		const c = parseHex(hex);
		if (!c) return [128, 128, 128, alpha];
		return [c.r, c.g, c.b, alpha];
	}

	/** Bilinear sample, or null when outside the square (IM `-virtual-pixel Background`). */
	function sampleBilinear(
		data: Uint8ClampedArray,
		width: number,
		height: number,
		x: number,
		y: number
	): [number, number, number, number] | null {
		if (x < 0 || y < 0 || x > width - 1 || y > height - 1) {
			return null;
		}
		const x0 = Math.floor(x);
		const y0 = Math.floor(y);
		const x1 = Math.min(width - 1, x0 + 1);
		const y1 = Math.min(height - 1, y0 + 1);
		const fx = x - x0;
		const fy = y - y0;
		const idx = (ix: number, iy: number) => (iy * width + ix) * 4;
		const out: [number, number, number, number] = [0, 0, 0, 0];
		for (let c = 0; c < 4; c++) {
			const v00 = data[idx(x0, y0) + c];
			const v10 = data[idx(x1, y0) + c];
			const v01 = data[idx(x0, y1) + c];
			const v11 = data[idx(x1, y1) + c];
			out[c] = Math.round(
				v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy
			);
		}
		return out;
	}

	/**
	 * ImageMagick-style DePolar (`-distort DePolar -1` + virtual-pixel Background):
	 * centre → north (equirect top); radius to furthest corner → south.
	 * Outside the square → empty fill — four south-pole sectors like the FE preview.
	 */
	function depolarSquareToEquirect(
		srcCanvas: HTMLCanvasElement,
		maxEdge: number,
		fillColor: string
	): HTMLCanvasElement {
		const sw = srcCanvas.width;
		const sh = srcCanvas.height;
		const cx = sw / 2;
		const cy = sh / 2;
		// IM `-1`: radius is centre → furthest corner (covers whole square).
		const maxR = Math.hypot(cx, cy);
		const empty = hexToRgba(fillColor || '#808080');

		let outW = Math.min(maxEdge, Math.max(2, Math.round(maxR * 2)));
		if (outW % 2) outW -= 1;
		const outH = Math.max(1, outW >> 1);

		const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
		if (!srcCtx) throw new Error('Canvas unavailable');
		const src = srcCtx.getImageData(0, 0, sw, sh).data;

		const out = document.createElement('canvas');
		out.width = outW;
		out.height = outH;
		const outCtx = out.getContext('2d');
		if (!outCtx) throw new Error('Canvas unavailable');
		const outImg = outCtx.createImageData(outW, outH);
		const dest = outImg.data;

		for (let y = 0; y < outH; y++) {
			// Top row = centre (north pole); bottom = corner radius (south).
			const r = (y / Math.max(1, outH - 1)) * maxR;
			for (let x = 0; x < outW; x++) {
				// IM DePolar: mid top row is angle 0; angles increase clockwise.
				const angle = (x / outW - 0.5) * Math.PI * 2;
				const sx = cx + r * Math.sin(angle);
				const sy = cy - r * Math.cos(angle);
				const sampled = sampleBilinear(src, sw, sh, sx, sy);
				const [cr, cg, cb, ca] = sampled ?? empty;
				const i = (y * outW + x) * 4;
				dest[i] = cr;
				dest[i + 1] = cg;
				dest[i + 2] = cb;
				dest[i + 3] = ca;
			}
		}
		outCtx.putImageData(outImg, 0, 0);
		return out;
	}

	/** ~2:1 already equirect (API preview); ~1:1 is a polar square map (needs DePolar). */
	function needsDepolar(width: number, height: number): boolean {
		return width / height < 1.5;
	}

	/**
	 * Tip local +Y (north) toward `sunDir` by Earth's axial tilt — northern summer solstice.
	 * Spin the globe with `globe.rotation.y -= …` (prograde / west→east) around that tilted axis.
	 */
	function applySummerAxialTilt(
		group: THREE.Group,
		sunDir: THREE.Vector3,
		tiltDeg = EARTH_AXIAL_TILT_DEG
	) {
		const up = new THREE.Vector3(0, 1, 0);
		const toward = sunDir.clone().normalize();
		const axis = new THREE.Vector3().crossVectors(up, toward);
		if (axis.lengthSq() < 1e-10) {
			group.quaternion.identity();
			return;
		}
		axis.normalize();
		group.quaternion.setFromAxisAngle(axis, THREE.MathUtils.degToRad(tiltDeg));
	}

	/** Soft fresnel shell — almost invisible face-on, faint limb glow at the rim. */
	function createAtmosphere(radius = 1.045) {
		const geometry = new THREE.SphereGeometry(radius, 64, 48);
		const material = new THREE.ShaderMaterial({
			uniforms: {
				glowColor: { value: new THREE.Color(0x8eb6ff) },
				intensity: { value: 0.22 },
				power: { value: 3.6 }
			},
			vertexShader: `
				varying vec3 vNormal;
				varying vec3 vWorldPos;
				void main() {
					vec4 worldPos = modelMatrix * vec4(position, 1.0);
					vWorldPos = worldPos.xyz;
					vNormal = normalize(mat3(modelMatrix) * normal);
					gl_Position = projectionMatrix * viewMatrix * worldPos;
				}
			`,
			fragmentShader: `
				uniform vec3 glowColor;
				uniform float intensity;
				uniform float power;
				varying vec3 vNormal;
				varying vec3 vWorldPos;
				void main() {
					vec3 viewDir = normalize(cameraPosition - vWorldPos);
					float fresnel = pow(1.0 - abs(dot(viewDir, normalize(vNormal))), power);
					float alpha = fresnel * intensity;
					gl_FragColor = vec4(glowColor, alpha);
				}
			`,
			transparent: true,
			depthWrite: false,
			side: THREE.FrontSide,
			blending: THREE.AdditiveBlending
		});
		return { mesh: new THREE.Mesh(geometry, material), geometry, material };
	}

	/** Random stars on a spherical shell around the globe. */
	function createStarfield(count = STAR_COUNT) {
		const positions = new Float32Array(count * 3);
		const colors = new Float32Array(count * 3);
		for (let i = 0; i < count; i++) {
			const r = 18 + Math.random() * 200;
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

	function makeLensflareTexture(kind: 'glow' | 'disc' | 'ring') {
		const size = kind === 'glow' ? 256 : 128;
		const canvas = document.createElement('canvas');
		canvas.width = size;
		canvas.height = size;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Canvas unavailable');
		const c = size / 2;
		if (kind === 'glow') {
			const g = ctx.createRadialGradient(c, c, 0, c, c, c);
			g.addColorStop(0, 'rgba(255,255,255,1)');
			g.addColorStop(0.12, 'rgba(255,255,255,0.75)');
			g.addColorStop(0.45, 'rgba(255,255,255,0.18)');
			g.addColorStop(1, 'rgba(255,255,255,0)');
			ctx.fillStyle = g;
			ctx.fillRect(0, 0, size, size);
		} else if (kind === 'ring') {
			const g = ctx.createRadialGradient(c, c, c * 0.42, c, c, c * 0.78);
			g.addColorStop(0, 'rgba(255,255,255,0)');
			g.addColorStop(0.4, 'rgba(255,255,255,0.55)');
			g.addColorStop(0.75, 'rgba(255,255,255,0.12)');
			g.addColorStop(1, 'rgba(255,255,255,0)');
			ctx.fillStyle = g;
			ctx.fillRect(0, 0, size, size);
		} else {
			const g = ctx.createRadialGradient(c, c, 0, c, c, c);
			g.addColorStop(0, 'rgba(255,255,255,0.95)');
			g.addColorStop(0.3, 'rgba(255,255,255,0.4)');
			g.addColorStop(0.65, 'rgba(255,255,255,0.1)');
			g.addColorStop(1, 'rgba(255,255,255,0)');
			ctx.fillStyle = g;
			ctx.fillRect(0, 0, size, size);
		}
		const texture = new THREE.CanvasTexture(canvas);
		texture.colorSpace = THREE.SRGBColorSpace;
		return texture;
	}

	/** Ghosts along the sun→screen-center axis when the sun is in view (hidden when occluded by the globe). */
	function createSunLensflare(position: THREE.Vector3) {
		const glow = makeLensflareTexture('glow');
		const disc = makeLensflareTexture('disc');
		const ring = makeLensflareTexture('ring');
		const lensflare = new Lensflare();
		lensflare.position.copy(position);
		lensflare.addElement(new LensflareElement(glow, 520, 0, new THREE.Color(0xfff1dd)));
		lensflare.addElement(new LensflareElement(disc, 90, 0.22, new THREE.Color(0xffc878)));
		lensflare.addElement(new LensflareElement(ring, 170, 0.38, new THREE.Color(0x9ec0ff)));
		lensflare.addElement(new LensflareElement(disc, 70, 0.52, new THREE.Color(0xff8a5c)));
		lensflare.addElement(new LensflareElement(disc, 110, 0.72, new THREE.Color(0x8ab6ff)));
		lensflare.addElement(new LensflareElement(ring, 210, 0.88, new THREE.Color(0xffd9a8)));
		lensflare.addElement(new LensflareElement(disc, 48, 1, new THREE.Color(0xffffff)));
		return { lensflare, textures: [glow, disc, ring] };
	}

	function disposeViewer() {
		cancelIntroZoom();
		if (animationId) {
			cancelAnimationFrame(animationId);
			animationId = 0;
		}
		resizeObserver?.disconnect();
		resizeObserver = null;
		if (sceneResources) {
			if (sceneResources.onControlsStart) {
				sceneResources.controls.removeEventListener('start', sceneResources.onControlsStart);
			}
			sceneResources.controls.dispose();
			sceneResources.geometry.dispose();
			sceneResources.material.dispose();
			sceneResources.texture?.dispose();
			sceneResources.starsGeometry.dispose();
			sceneResources.starsMaterial.dispose();
			sceneResources.sunTexture.dispose();
			sceneResources.sunMaterial.dispose();
			sceneResources.lensflare.dispose();
			for (const tex of sceneResources.lensflareTextures) tex.dispose();
			sceneResources.atmosphereGeometry.dispose();
			sceneResources.atmosphereMaterial.dispose();
			sceneResources = null;
		}
		if (renderer) {
			renderer.dispose();
			renderer.domElement.remove();
			renderer = null;
		}
	}

	async function loadTexture(
		url: string,
		opts: { depolarSquare?: boolean; emptyFillColor?: string } = {}
	): Promise<THREE.CanvasTexture> {
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

		const mapped =
			opts.depolarSquare || needsDepolar(w, h)
				? depolarSquareToEquirect(canvas, MAX_EDGE, opts.emptyFillColor || '#808080')
				: canvas;

		const texture = new THREE.CanvasTexture(mapped);
		texture.colorSpace = THREE.SRGBColorSpace;
		texture.anisotropy = 8;
		return texture;
	}

	/** Sync starfield scene at intro distance — no texture load. */
	function ensureScene(el: HTMLDivElement, variant: 'card' | 'stage' = 'card') {
		if (viewerReady() && loadedVariant === variant) {
			statusMessage = '';
			return;
		}

		disposeViewer();
		el.replaceChildren();
		statusMessage = '';
		loadedPreviewUrl = '';

		const isStage = variant === 'stage';
		const lookDir = (isStage ? STAGE_LOOK : CARD_LOOK).clone().normalize();
		const userMinDistance = isStage ? 1.05 : 1.35;
		const userMaxDistance = isStage ? 6 : 5;

		const nextScene = new THREE.Scene();
		nextScene.background = new THREE.Color(0x000000);

		const camera = new THREE.PerspectiveCamera(40, 1, 0.1, CAMERA_FAR);
		camera.position.copy(lookDir).multiplyScalar(INTRO_DISTANCE);

		// preserveDrawingBuffer so stage archive thumbs can canvas.toBlob after render.
		const webgl = new THREE.WebGLRenderer({
			antialias: true,
			alpha: false,
			preserveDrawingBuffer: isStage
		});
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
		const flare = createSunLensflare(sun.sprite.position);
		nextScene.add(flare.lensflare);
		nextScene.add(new THREE.AmbientLight(0x9aa8c4, 0.42));
		const nightFill = new THREE.DirectionalLight(0x6d7fa8, 0.22);
		nightFill.position.set(-3.5, -0.4, -2.2);
		nextScene.add(nightFill);

		// DePolar panorama: top = map centre (north pole), bottom = rim / south.
		const geometry = new THREE.SphereGeometry(1, 96, 64);
		const material = new THREE.MeshStandardMaterial({
			color: 0x0a0a12,
			roughness: 0.92,
			metalness: 0
		});
		const globe = new THREE.Mesh(geometry, material);
		const atmosphere = createAtmosphere();
		// Tilted spin axis: north leans toward the sun (summer); daily rotation on local Y.
		const earth = new THREE.Group();
		earth.visible = false;
		applySummerAxialTilt(earth, SUN_DIR);
		earth.add(globe);
		earth.add(atmosphere.mesh);
		nextScene.add(earth);

		const controls = new OrbitControls(camera, webgl.domElement);
		controls.enableDamping = true;
		controls.dampingFactor = 0.06;
		controls.minDistance = userMinDistance;
		// Raised so OrbitControls.update() does not clamp the far intro camera.
		controls.maxDistance = INTRO_DISTANCE + 1;
		controls.target.set(0, 0, 0);
		controls.enabled = false;

		const onControlsStart = () => {
			if (sceneResources) sceneResources.autoFrame = false;
		};
		if (isStage) {
			controls.addEventListener('start', onControlsStart);
		}
		controls.update();

		/** Pull camera so the unit sphere fits with starfield visible around it. */
		const frameGlobe = () => {
			const distance = framedFitDistance(camera);
			const dir = camera.position.clone().sub(controls.target);
			if (dir.lengthSq() < 1e-8) dir.copy(STAGE_LOOK);
			dir.normalize();
			camera.position.copy(controls.target).addScaledVector(dir, distance);
			controls.update();
		};

		sceneResources = {
			scene: nextScene,
			camera,
			geometry,
			material,
			texture: null,
			controls,
			globe,
			earth,
			isStage,
			lookDir,
			userMinDistance,
			userMaxDistance,
			introActive: true,
			autoFrame: false,
			onControlsStart: isStage ? onControlsStart : undefined,
			starsGeometry: stars.geometry,
			starsMaterial: stars.material,
			sunTexture: sun.texture,
			sunMaterial: sun.material,
			lensflare: flare.lensflare,
			lensflareTextures: flare.textures,
			atmosphereGeometry: atmosphere.geometry,
			atmosphereMaterial: atmosphere.material
		};

		const fit = () => {
			const res = sceneResources;
			if (!res) return;
			const w = el.clientWidth || 1;
			const h = el.clientHeight || 1;
			res.camera.aspect = w / h;
			res.camera.updateProjectionMatrix();
			webgl.setSize(w, h, false);
			if (res.autoFrame && !res.introActive) frameGlobe();
		};
		fit();
		resizeObserver = new ResizeObserver(fit);
		resizeObserver.observe(el);

		const tick = () => {
			animationId = requestAnimationFrame(tick);
			// West→east (prograde): negative Y with SphereGeometry UV / equirect mapping.
			globe.rotation.y -= 0.0015;
			controls.update();
			webgl.render(nextScene, camera);
		};
		tick();

		loadedVariant = variant;
	}

	/** Load first texture, reveal earth, zoom from intro distance to framed view. */
	async function finishIntroWithTexture(
		url: string,
		opts: {
			depolarSquare?: boolean;
			emptyFillColor?: string;
			variant?: 'card' | 'stage';
		} = {}
	) {
		const res = sceneResources;
		if (!res || !renderer) throw new Error('Sphere scene is not ready');

		const seq = ++textureLoadSeq;
		const texture = await loadTexture(url, opts);
		if (seq !== textureLoadSeq || !sceneResources || sceneResources !== res) {
			texture.dispose();
			return;
		}

		res.material.map = texture;
		res.material.color.set(0xffffff);
		res.material.needsUpdate = true;
		res.texture = texture;
		res.earth.visible = true;

		const el = renderer.domElement.parentElement;
		if (el) {
			const w = el.clientWidth || 1;
			const h = el.clientHeight || 1;
			res.camera.aspect = w / h;
			res.camera.updateProjectionMatrix();
			renderer.setSize(w, h, false);
		}

		const targetDistance = res.isStage
			? framedFitDistance(res.camera)
			: CARD_FRAMED_DISTANCE;
		await animateIntroZoom(
			res.camera,
			res.controls,
			INTRO_DISTANCE,
			targetDistance,
			res.lookDir
		);
		if (!sceneResources || sceneResources !== res) return;

		res.introActive = false;
		res.controls.maxDistance = res.userMaxDistance;
		res.controls.minDistance = res.userMinDistance;
		res.controls.enabled = true;
		if (res.isStage) res.autoFrame = true;

		loadedPreviewUrl = url;
		statusMessage = '';
	}

	async function mountGlobe(
		el: HTMLDivElement,
		url: string,
		opts: {
			depolarSquare?: boolean;
			emptyFillColor?: string;
			variant?: 'card' | 'stage';
		} = {}
	) {
		ensureScene(el, opts.variant ?? 'card');
		await finishIntroWithTexture(url, opts);
	}

	/**
	 * Swap globe albedo only — keeps camera, orbit target, and spin.
	 * Mounts the full scene only on first load (or variant change).
	 */
	async function applyGlobeTexture(
		el: HTMLDivElement,
		url: string,
		opts: {
			depolarSquare?: boolean;
			emptyFillColor?: string;
			variant?: 'card' | 'stage';
		} = {}
	) {
		if (mounting) await mounting;
		if (finishing) await finishing;

		const nextVariant = opts.variant ?? 'card';
		if (!viewerReady() || loadedVariant !== nextVariant) {
			const p = mountGlobe(el, url, opts);
			mounting = p.finally(() => {
				mounting = null;
			});
			await p;
			return;
		}
		if (url === loadedPreviewUrl) return;

		// Starfield waiting for first texture — run intro zoom (not a silent hot-swap).
		if (!loadedPreviewUrl) {
			const p = finishIntroWithTexture(url, opts);
			finishing = p.finally(() => {
				finishing = null;
			});
			await p;
			return;
		}

		const seq = ++textureLoadSeq;
		const view = captureViewState();
		const texture = await loadTexture(url, opts);
		if (seq !== textureLoadSeq || !viewerReady() || !sceneResources) {
			texture.dispose();
			return;
		}

		const prev = sceneResources.texture;
		sceneResources.material.map = texture;
		sceneResources.material.color.set(0xffffff);
		sceneResources.material.needsUpdate = true;
		sceneResources.texture = texture;
		sceneResources.earth.visible = true;
		prev?.dispose();
		restoreViewState(view);
		loadedPreviewUrl = url;
	}

	/** Silent hot-swap when already viewing; starfield is the first-mount loading state. */
	async function showGlobe(
		el: HTMLDivElement,
		url: string,
		opts: {
			depolarSquare?: boolean;
			emptyFillColor?: string;
			variant?: 'card' | 'stage';
		} = {}
	) {
		const hot = viewerReady() && loadedVariant === (opts.variant ?? 'card');
		if (hot && url === loadedPreviewUrl) {
			statusMessage = '';
			return;
		}
		try {
			await applyGlobeTexture(el, url, opts);
			statusMessage = '';
		} catch (err) {
			// Keep starfield if the scene is up; only tear down when there is nothing to show.
			if (!loadedPreviewUrl) {
				if (!viewerReady()) {
					disposeViewer();
					loadedVariant = '';
				}
				statusMessage =
					err instanceof Error ? err.message : 'Could not open sphere preview.';
				return;
			}
			console.warn('Texture hot-reload failed', err);
			statusMessage = '';
		}
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
		const url = src;
		const mountOpts = {
			depolarSquare,
			emptyFillColor,
			variant
		};
		if (!el) return;

		if (!url) {
			ensureScene(el, variant);
			return;
		}

		void showGlobe(el, url, mountOpts);

		return () => {
			// Invalidate in-flight texture loads when src/opts change or the effect re-runs.
			textureLoadSeq += 1;
		};
	});

	onDestroy(() => {
		disposeViewer();
		loadedPreviewUrl = '';
		loadedVariant = '';
	});

	/** Wait until first texture intro finishes so archive thumbs aren't empty starfield. */
	async function waitForIntroReady(timeoutMs = 30_000) {
		const start = performance.now();
		while (performance.now() - start < timeoutMs) {
			if (loadedPreviewUrl && sceneResources && !sceneResources.introActive) return true;
			await new Promise<void>((r) => requestAnimationFrame(() => r()));
		}
		return !!(loadedPreviewUrl && sceneResources && !sceneResources.introActive);
	}

	/** Snapshot the WebGL canvas for archive gallery thumbs (stage / preserveDrawingBuffer). */
	export async function captureThumbBlob(
		type = 'image/jpeg',
		quality = 0.82
	): Promise<Blob | null> {
		const ready = await waitForIntroReady();
		const webgl = renderer;
		const resources = sceneResources;
		if (!ready || !webgl || !resources) return null;
		await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
		webgl.render(resources.scene, resources.camera);
		return new Promise((resolve) => {
			webgl.domElement.toBlob((blob) => resolve(blob), type, quality);
		});
	}
</script>

<div class={variant === 'stage' ? 'relative h-full w-full' : 'space-y-1.5'}>
	<div
		bind:this={shellEl}
		class="relative overflow-hidden bg-black {variant === 'stage'
			? 'h-full w-full rounded-none ring-0'
			: isFullscreen
				? 'h-screen w-screen rounded-none ring-1 ring-line-strong'
				: 'h-[min(50vh,28rem)] w-full rounded-lg ring-1 ring-line-strong'}"
	>
		<div bind:this={container} class="h-full w-full" aria-label={title}></div>
		{#if statusMessage}
			<p
				class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/85 px-4 text-center text-sm text-ink"
			>
				{statusMessage}
			</p>
		{/if}
		{#if variant === 'stage'}
			<p
				class="pointer-events-none absolute inset-x-0 bottom-3 z-10 text-center text-xs text-ink/45"
			>
				Drag to orbit · scroll to zoom
			</p>
		{/if}
		{#if fullscreenSupported && !hideFullscreenButton}
			<button
				type="button"
				onclick={toggleFullscreen}
				aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
				title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
				class="absolute top-3 z-20 flex h-9 w-9 items-center justify-center rounded-lg bg-panel/90 text-ink-secondary shadow-md ring-1 ring-line-strong/80 backdrop-blur-sm transition hover:bg-panel"
				style:right={controlsOffsetRight}
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
	{#if variant !== 'stage'}
		<p class="text-xs text-ink-subtle">Drag to orbit · scroll to zoom</p>
	{/if}
</div>
