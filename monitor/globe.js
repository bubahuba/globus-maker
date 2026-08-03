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

async function loadTexture(url) {
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

	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = 8;
	return texture;
}

async function mountGlobe(el, url) {
	disposeViewer();
	el.replaceChildren();

	const texture = await loadTexture(url);

	const scene = new THREE.Scene();
	scene.background = null;

	const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
	camera.position.set(0, 0.35, 2.6);

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
	controls.minDistance = 1.35;
	controls.maxDistance = 5;
	controls.target.set(0, 0, 0);
	controls.update();

	sceneResources = { geometry, material, texture, controls, globe };

	const fit = () => {
		const w = el.clientWidth || window.innerWidth || 1;
		const h = el.clientHeight || window.innerHeight || 1;
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		webgl.setSize(w, h, false);
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
		await mountGlobe(container, previewUrl);
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
