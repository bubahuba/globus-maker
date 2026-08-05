/**
 * Full-window Three.js globe monitor — mirrors FE DistortedPanoramaViewer.
 * Fetches the latest globe job from Globus Maker (any host can serve this folder).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';

/** Production Globus Maker origin (API + preview files). */
const GLOBE_ORIGIN = 'https://globe.rgb.sk';

/** Optional override: ?origin=http://localhost:8787 for local API. */
const originParam = new URLSearchParams(location.search).get('origin');
const API_ORIGIN = (originParam || GLOBE_ORIGIN).replace(/\/$/, '');

const MAX_EDGE = 6000;
const POLL_MS = 60_000;
/** Earth obliquity — north pole tipped toward the sun (NH summer). */
const EARTH_AXIAL_TILT_DEG = 23.44;

const container = document.getElementById('globe');
const statusEl = document.getElementById('status');

let renderer = null;
let animationId = 0;
let resizeObserver = null;
let onWindowResize = null;
let sceneResources = null;
let loadedPreviewUrl = '';

function setStatus(message) {
	if (!statusEl) return;
	if (message) {
		statusEl.hidden = false;
		statusEl.textContent = message;
	} else {
		statusEl.hidden = true;
		statusEl.textContent = '';
	}
}

function parseHex(hex) {
	const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
	if (!m) return null;
	const n = parseInt(m[1], 16);
	return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Random stars on a spherical shell around the globe. */
function createStarfield(count = 6000) {
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
function createSun(direction, distance = 46) {
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

/** Procedural flare maps — no external texture assets. */
function makeLensflareTexture(kind) {
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

/**
 * Tip local +Y (north) toward `sunDir` by Earth's axial tilt — northern summer solstice.
 * Spin the globe with `globe.rotation.y` so it turns around that tilted axis.
 */
function applySummerAxialTilt(group, sunDir, tiltDeg = EARTH_AXIAL_TILT_DEG) {
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

/** Ghosts along the sun→screen-center axis when the sun is in view (hidden when occluded by the globe). */
function createSunLensflare(position) {
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

/**
 * API paths (`/api/...`) → Globus Maker origin.
 * Monitor-relative fallbacks (`rip.jpeg`) → this page's directory.
 */
function resolvePreviewUrl(pathOrUrl, { fallback = false } = {}) {
	if (!pathOrUrl) return '';
	if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
	if (fallback || !pathOrUrl.startsWith('/')) {
		return new URL(pathOrUrl, location.href).href;
	}
	return `${API_ORIGIN}${pathOrUrl}`;
}

function disposeViewer() {
	if (animationId) {
		cancelAnimationFrame(animationId);
		animationId = 0;
	}
	resizeObserver?.disconnect();
	resizeObserver = null;
	if (onWindowResize) {
		window.removeEventListener('resize', onWindowResize);
		onWindowResize = null;
	}
	if (sceneResources) {
		if (sceneResources.onControlsStart) {
			sceneResources.controls.removeEventListener('start', sceneResources.onControlsStart);
		}
		sceneResources.controls.dispose();
		sceneResources.geometry.dispose();
		sceneResources.material.dispose();
		sceneResources.texture.dispose();
		sceneResources.starsGeometry?.dispose();
		sceneResources.starsMaterial?.dispose();
		sceneResources.sunTexture?.dispose();
		sceneResources.sunMaterial?.dispose();
		sceneResources.lensflare?.dispose();
		for (const tex of sceneResources.lensflareTextures ?? []) tex.dispose();
		sceneResources.atmosphereGeometry?.dispose();
		sceneResources.atmosphereMaterial?.dispose();
		sceneResources = null;
	}
	if (renderer) {
		renderer.dispose();
		renderer.domElement.remove();
		renderer = null;
	}
}

function hexToRgba(hex, alpha = 255) {
	const c = parseHex(hex);
	if (!c) return [128, 128, 128, alpha];
	return [c.r, c.g, c.b, alpha];
}

/** Bilinear sample, or null when outside the square (IM `-virtual-pixel Background`). */
function sampleBilinear(data, width, height, x, y) {
	if (x < 0 || y < 0 || x > width - 1 || y > height - 1) {
		return null;
	}
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const x1 = Math.min(width - 1, x0 + 1);
	const y1 = Math.min(height - 1, y0 + 1);
	const fx = x - x0;
	const fy = y - y0;
	const idx = (ix, iy) => (iy * width + ix) * 4;
	const out = [0, 0, 0, 0];
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
function depolarSquareToEquirect(srcCanvas, maxEdge, emptyFillColor) {
	const sw = srcCanvas.width;
	const sh = srcCanvas.height;
	const cx = sw / 2;
	const cy = sh / 2;
	// IM `-1`: radius is centre → furthest corner (covers whole square).
	const maxR = Math.hypot(cx, cy);
	const empty = hexToRgba(emptyFillColor || '#808080');

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
function needsDepolar(width, height) {
	return width / height < 1.5;
}

async function loadTexture(url, { depolarSquare = false, emptyFillColor = '#808080' } = {}) {
	const img = new Image();
	img.crossOrigin = 'anonymous';
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
		depolarSquare || needsDepolar(w, h)
			? depolarSquareToEquirect(canvas, MAX_EDGE, emptyFillColor)
			: canvas;

	const texture = new THREE.CanvasTexture(mapped);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = 8;
	return texture;
}

async function mountGlobe(el, url, opts = {}) {
	disposeViewer();
	el.replaceChildren();

	const texture = await loadTexture(url, opts);

	const scene = new THREE.Scene();
	scene.background = new THREE.Color(0x000000);

	const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
	// Bias toward north pole (+Y); distance set by frameGlobe().
	camera.position.set(0, 0.95, 0.85);

	const webgl = new THREE.WebGLRenderer({ antialias: true, alpha: false });
	webgl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	webgl.outputColorSpace = THREE.SRGBColorSpace;
	webgl.toneMapping = THREE.ACESFilmicToneMapping;
	webgl.toneMappingExposure = 1.05;
	webgl.setClearColor(0x000000, 1);
	el.appendChild(webgl.domElement);
	renderer = webgl;

	const stars = createStarfield();
	scene.add(stars.points);

	// Sun key + soft fill so the night side stays readable.
	const sunDir = new THREE.Vector3(4.2, 1.4, 2.6);
	const sunLight = new THREE.DirectionalLight(0xfff1dd, 1.55);
	sunLight.position.copy(sunDir);
	scene.add(sunLight);
	const sun = createSun(sunDir);
	scene.add(sun.sprite);
	const flare = createSunLensflare(sun.sprite.position);
	scene.add(flare.lensflare);
	scene.add(new THREE.AmbientLight(0x9aa8c4, 0.42));
	const nightFill = new THREE.DirectionalLight(0x6d7fa8, 0.22);
	nightFill.position.set(-3.5, -0.4, -2.2);
	scene.add(nightFill);

	const geometry = new THREE.SphereGeometry(1, 96, 64);
	const material = new THREE.MeshStandardMaterial({
		map: texture,
		roughness: 0.92,
		metalness: 0
	});
	const globe = new THREE.Mesh(geometry, material);
	const atmosphere = createAtmosphere();
	// Tilted spin axis: north leans toward the sun (summer); daily rotation on local Y.
	const earth = new THREE.Group();
	applySummerAxialTilt(earth, sunDir);
	earth.add(globe);
	earth.add(atmosphere.mesh);
	scene.add(earth);

	const controls = new OrbitControls(camera, webgl.domElement);
	controls.enableDamping = true;
	controls.dampingFactor = 0.06;
	controls.minDistance = 1.05;
	controls.maxDistance = 6;
	controls.target.set(0, 0, 0);

	/** Keep contain-framing on resize until the user orbits / zooms. */
	let autoFrame = true;
	const onControlsStart = () => {
		autoFrame = false;
	};
	controls.addEventListener('start', onControlsStart);

	/** Pull camera so the unit sphere fits with starfield visible around it. */
	const frameGlobe = () => {
		const vFov = THREE.MathUtils.degToRad(camera.fov);
		const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
		const fitFov = Math.min(vFov, hFov);
		const distance = (1 / Math.sin(fitFov / 2)) * 1.2;
		const dir = camera.position.clone().sub(controls.target);
		if (dir.lengthSq() < 1e-8) dir.set(0, 0.95, 0.85);
		dir.normalize();
		camera.position.copy(controls.target).addScaledVector(dir, distance);
		controls.update();
	};

	sceneResources = {
		geometry,
		material,
		texture,
		controls,
		globe,
		onControlsStart,
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
		const w = el.clientWidth || window.innerWidth || 1;
		const h = el.clientHeight || window.innerHeight || 1;
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		webgl.setSize(w, h, true);
		if (autoFrame) frameGlobe();
	};
	fit();
	onWindowResize = fit;
	window.addEventListener('resize', onWindowResize);
	resizeObserver = new ResizeObserver(fit);
	resizeObserver.observe(el);

	const tick = () => {
		animationId = requestAnimationFrame(tick);
		globe.rotation.y += 0.0015;
		controls.update();
		webgl.render(scene, camera);
	};
	tick();
}

async function fetchLatestGlobe() {
	const response = await fetch(`${API_ORIGIN}/api/jobs/latest-globe`);
	if (!response.ok) {
		const body = await response.json().catch(() => ({}));
		throw new Error(body.error || `HTTP ${response.status}`);
	}
	return response.json();
}

async function refresh() {
	try {
		const job = await fetchLatestGlobe();

		const previewUrl = resolvePreviewUrl(job.spherePreviewUrl, {
			fallback: job.fallback === true
		});
		if (!previewUrl) throw new Error('No sphere preview URL');

		if (previewUrl === loadedPreviewUrl && renderer) {
			setStatus('');
			return;
		}

		if (!container) throw new Error('Missing #globe container');
		setStatus('Loading preview…');
		// Fallback / square maps: DePolar centre→north like the FE globe pipeline
		// (corner radius + empty fill → four untextured south-pole sectors).
		await mountGlobe(container, previewUrl, {
			depolarSquare: job.fallback === true,
			emptyFillColor: job.emptyFillColor || '#808080'
		});
		loadedPreviewUrl = previewUrl;
		setStatus('');

		document.title = job.placeName
			? `${job.placeName} — Globe Monitor`
			: 'Globus Maker — Globe Monitor';
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Could not load globe preview.';
		setStatus(message);
	}
}

void refresh();
setInterval(() => void refresh(), POLL_MS);

window.addEventListener('beforeunload', () => {
	disposeViewer();
});
