/**
 * Full-window Three.js globe monitor — mirrors FE DistortedPanoramaViewer.
 * Fetches the latest globe job from Globus Maker (any host can serve this folder).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** Production Globus Maker origin (API + preview files). */
const GLOBE_ORIGIN = 'https://globe.rgb.sk';

/** Optional override: ?origin=http://localhost:8787 for local API. */
const originParam = new URLSearchParams(location.search).get('origin');
const API_ORIGIN = (originParam || GLOBE_ORIGIN).replace(/\/$/, '');

const MAX_EDGE = 6000;
const POLL_MS = 60_000;

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

function mixChannel(ch, toward, amount) {
	return Math.round(ch + (toward - ch) * amount);
}

function mixHex(hex, toward, amount) {
	const c = parseHex(hex);
	if (!c) return hex;
	const r = mixChannel(c.r, toward, amount);
	const g = mixChannel(c.g, toward, amount);
	const b = mixChannel(c.b, toward, amount);
	return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

function gradientFromBase(base) {
	const dark = mixHex(base, 0, 0.32);
	const light = mixHex(base, 255, 0.16);
	return `radial-gradient(ellipse 125% 110% at 50% 38%, ${dark} 0%, ${base} 48%, ${light} 100%)`;
}

function applyBackground(emptyFillColor) {
	const base = parseHex(emptyFillColor) ? emptyFillColor : '#f5f5f4';
	const gradient = gradientFromBase(base);
	document.body.style.background = gradient;
	if (container) container.style.background = gradient;
	if (statusEl) statusEl.style.background = gradient;
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
	scene.background = null;

	const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
	// Bias toward north pole (+Y); distance set by frameGlobe() to cover the viewport.
	camera.position.set(0, 0.95, 0.85);

	const webgl = new THREE.WebGLRenderer({ antialias: true, alpha: true });
	webgl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	webgl.outputColorSpace = THREE.SRGBColorSpace;
	webgl.setClearColor(0x000000, 0);
	el.appendChild(webgl.domElement);
	renderer = webgl;

	const geometry = new THREE.SphereGeometry(1, 96, 64);
	const material = new THREE.MeshBasicMaterial({ map: texture });
	const globe = new THREE.Mesh(geometry, material);
	scene.add(globe);

	const controls = new OrbitControls(camera, webgl.domElement);
	controls.enableDamping = true;
	controls.dampingFactor = 0.06;
	controls.minDistance = 1.05;
	controls.maxDistance = 6;
	controls.target.set(0, 0, 0);

	/** Keep cover-framing on resize until the user orbits / zooms. */
	let autoFrame = true;
	const onControlsStart = () => {
		autoFrame = false;
	};
	controls.addEventListener('start', onControlsStart);

	/** Pull camera in so the unit sphere covers the whole viewport (crop edges). */
	const frameGlobe = () => {
		const vFov = THREE.MathUtils.degToRad(camera.fov);
		const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
		const fillFov = Math.max(vFov, hFov);
		const distance = (1 / Math.sin(fillFov / 2)) * 0.72;
		const dir = camera.position.clone().sub(controls.target);
		if (dir.lengthSq() < 1e-8) dir.set(0, 0.95, 0.85);
		dir.normalize();
		camera.position.copy(controls.target).addScaledVector(dir, distance);
		controls.update();
	};

	sceneResources = { geometry, material, texture, controls, globe, onControlsStart };

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
		applyBackground(job.emptyFillColor || '#f5f5f4');

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

applyBackground('#f5f5f4');
void refresh();
setInterval(() => void refresh(), POLL_MS);

window.addEventListener('beforeunload', () => {
	disposeViewer();
});
