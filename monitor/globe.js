/**
 * Full-window Three.js globe monitor — mirrors FE DistortedPanoramaViewer.
 * Fetches the latest globe job from Globe Maker (any host can serve this folder).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';
import {
	archiveLabelFromMeta,
	archiveMetaFromJob,
	archiveMetaQuery,
	formatArchiveMetaTooltip,
	parseArchiveImageMeta,
	recreateSelectionHrefFromMeta
} from './archive-image-meta.js';

/** Production Globe Maker origin (API + preview files). */
const GLOBE_ORIGIN = 'https://globe.rgb.sk';

/**
 * Saved previews live on the monitor host (not the API):
 *   GET  /globe-preview/list.php           → JSON filename list
 *   POST /globe-preview/save.php?name=…    → store JPEG / -thumb.jpg screenshot
 *   GET  /globe-preview/<file>             → static image
 * Prod: tiny PHP on Apache/FPM. Local: Vite middleware.
 */
const PREVIEW_DIR_URL = new URL('/globe-preview/', location.origin).href;
const PREVIEW_LIST_URL = new URL('list.php', PREVIEW_DIR_URL).href;
const PREVIEW_SAVE_URL = new URL('save.php', PREVIEW_DIR_URL).href;
const IMAGE_NAME_RE = /\.(jpe?g|png|webp)$/i;
const THUMB_NAME_RE = /-thumb\.(jpe?g|png|webp)$/i;

/** Optional override: ?origin=http://localhost:8787 for local API. */
const originParam = new URLSearchParams(location.search).get('origin');
const API_ORIGIN = (originParam || GLOBE_ORIGIN).replace(/\/$/, '');

const MAX_EDGE = 6000;
const POLL_MS = 60_000;
const GLOBE_SPIN = 0.0015;
/** OrbitControls auto-rotate: ~5 min per full orbit (feels like a slow horizontal drag). */
const AUTO_ROTATE_SPEED = 0.05;
/** Earth obliquity — north pole tipped toward the sun (NH summer). */
const EARTH_AXIAL_TILT_DEG = 23.44;
/** Far start for first-mount zoom — planet reads as a bright star. */
const INTRO_DISTANCE = 95;
const CAMERA_FAR = 280;
const INTRO_ZOOM_MS = 2400;
const FOCUS_FLY_MS = 2200;
const MIN_PLANET_SEPARATION = 28;
const STAGE_LOOK = new THREE.Vector3(0, 0.95, 0.85);
const SUN_DIR = new THREE.Vector3(4.2, 1.4, 2.6);
const USER_MIN_DISTANCE = 1.05;
const USER_MAX_DISTANCE = 6;

const container = document.getElementById('globe');
const statusEl = document.getElementById('status');
const placeLabelEl = document.getElementById('place-label');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const archiveBtn = document.getElementById('archive-btn');
const archivePane = document.getElementById('archive-pane');
const archiveList = document.getElementById('archive-list');

let renderer = null;
let animationId = 0;
let introRaf = 0;
let introCancel = null;
/** In-flight first mount / intro / focus; hot-swaps wait on these. */
let mounting = null;
let finishing = null;
let focusFlight = null;
let resizeObserver = null;
let onWindowResize = null;
let sceneResources = null;
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
let pointerDown = null;
let onCanvasPointerDown = null;
let onCanvasPointerUp = null;
/** Empty string = follow latest API job; otherwise a filename under /globe-preview/. */
let selectedArchive = '';
let archivedNames = [];
/** placeName/lat/lng/sideMeters from thumb JPEG COM, keyed by texture filename. */
let archiveMetaByName = {};
/** Place label for the live (API) option — updated on each successful live fetch. */
let liveDisplayName = '';
/** Last successful live preview URL (for LIVE focus without refetch). */
let liveUrl = '';
let livePlanetReady = false;
let pollTimer = 0;
let archivePaneOpen = false;
/** Last live job opts so gallery can return to live without a full remount when possible. */
let lastLiveJob = null;
/** Meta used when archiving the current live job. */
let lastArchiveMeta = null;

function easeInOutCubic(t) {
	return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** Quadratic Bezier through a → b → c. */
function bezier3(a, b, c, t, out) {
	const u = 1 - t;
	return out
		.copy(a)
		.multiplyScalar(u * u)
		.addScaledVector(b, 2 * u * t)
		.addScaledVector(c, t * t);
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

function framedFitDistance(camera) {
	const vFov = THREE.MathUtils.degToRad(camera.fov);
	const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
	const fitFov = Math.min(vFov, hFov);
	return (1 / Math.sin(fitFov / 2)) * 1.2;
}

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

/** External-link icon for clickable place chip (matches FE /latest-planet). */
const PLACE_LINK_ICON = `<svg class="place-label-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`;

/**
 * Upper-left place chip (matches FE /latest-planet).
 * Live → `/?job=`; archive → recreate `/?mode=globe&latlng=…`.
 */
function setPlaceLabel(label, href = '', linkTitle = 'Open in Globe Maker') {
	if (!placeLabelEl) return;
	const text = label != null ? String(label).trim() : '';
	if (!text || text === 'Unavailable') {
		placeLabelEl.hidden = true;
		placeLabelEl.replaceChildren();
		placeLabelEl.removeAttribute('href');
		placeLabelEl.removeAttribute('title');
		placeLabelEl.removeAttribute('target');
		placeLabelEl.removeAttribute('rel');
		return;
	}
	placeLabelEl.hidden = false;
	const nextHref = href != null ? String(href).trim() : '';
	const textSpan = document.createElement('span');
	textSpan.className = 'place-label-text';
	textSpan.textContent = text;
	placeLabelEl.replaceChildren(textSpan);
	if (nextHref) {
		placeLabelEl.insertAdjacentHTML('beforeend', PLACE_LINK_ICON);
		placeLabelEl.href = nextHref;
		placeLabelEl.title = linkTitle;
		placeLabelEl.target = '_blank';
		placeLabelEl.rel = 'noopener noreferrer';
	} else {
		placeLabelEl.removeAttribute('href');
		placeLabelEl.removeAttribute('title');
		placeLabelEl.removeAttribute('target');
		placeLabelEl.removeAttribute('rel');
	}
}

function jobPageUrl(jobId) {
	const id = jobId != null ? String(jobId).trim() : '';
	if (!id) return '';
	return `${API_ORIGIN}/?job=${encodeURIComponent(id)}`;
}

function recreatePageUrl(meta) {
	return recreateSelectionHrefFromMeta(meta, API_ORIGIN) || '';
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
 * Spin the globe with `globe.rotation.y -= …` (prograde / west→east) around that tilted axis.
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
 * API paths (`/api/...`) → Globe Maker origin.
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

function pickPlanetPosition(planets, id) {
	if (id === 'live' || planets.size === 0) {
		return new THREE.Vector3(0, 0, 0);
	}
	for (let radius = 32; radius <= 200; radius += 8) {
		for (let attempt = 0; attempt < 20; attempt++) {
			const dir = new THREE.Vector3(
				Math.random() * 2 - 1,
				Math.random() * 2 - 1,
				Math.random() * 2 - 1
			);
			if (dir.lengthSq() < 1e-8) continue;
			dir.normalize().multiplyScalar(radius);
			let ok = true;
			for (const p of planets.values()) {
				if (p.earth.position.distanceTo(dir) < MIN_PLANET_SEPARATION) {
					ok = false;
					break;
				}
			}
			if (ok) return dir;
		}
	}
	const axis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
	if (axis.lengthSq() < 1e-8) axis.set(1, 0, 0);
	return axis.normalize().multiplyScalar(80);
}

function disposePlanet(planet) {
	planet.earth.removeFromParent();
	planet.geometry.dispose();
	planet.material.dispose();
	planet.texture?.dispose();
	planet.atmosphereGeometry.dispose();
	planet.atmosphereMaterial.dispose();
}

function detachPlanetClickHandlers() {
	const canvas = renderer?.domElement;
	if (canvas && onCanvasPointerDown) {
		canvas.removeEventListener('pointerdown', onCanvasPointerDown);
	}
	if (canvas && onCanvasPointerUp) {
		canvas.removeEventListener('pointerup', onCanvasPointerUp);
	}
	onCanvasPointerDown = null;
	onCanvasPointerUp = null;
	pointerDown = null;
}

/** Click a distant planet (not a drag) → same as sidebar focus. */
function attachPlanetClickHandlers(canvas) {
	detachPlanetClickHandlers();
	onCanvasPointerDown = (event) => {
		if (event.button !== 0) return;
		pointerDown = { x: event.clientX, y: event.clientY, t: performance.now() };
	};
	onCanvasPointerUp = (event) => {
		const down = pointerDown;
		pointerDown = null;
		if (!down || event.button !== 0) return;
		const res = sceneResources;
		if (!res || res.introActive || !res.controls.enabled) return;
		const dx = event.clientX - down.x;
		const dy = event.clientY - down.y;
		if (dx * dx + dy * dy > 36) return;
		if (performance.now() - down.t > 500) return;

		const rect = canvas.getBoundingClientRect();
		if (rect.width < 1 || rect.height < 1) return;
		pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
		pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
		raycaster.setFromCamera(pointerNdc, res.camera);

		const targets = [];
		for (const planet of res.planets.values()) {
			if (!planet.earth.visible || !planet.texture) continue;
			targets.push(planet.globe);
			for (const child of planet.earth.children) {
				if (child !== planet.globe) targets.push(child);
			}
		}
		const hits = raycaster.intersectObjects(targets, false);
		const hitId = hits[0]?.object?.userData?.planetId;
		if (typeof hitId !== 'string' || !hitId) return;
		if (hitId === res.focusedId) return;
		const planet = res.planets.get(hitId);
		if (!planet?.loadedUrl) return;
		void selectArchive(hitId === 'live' ? '' : hitId);
	};
	canvas.addEventListener('pointerdown', onCanvasPointerDown);
	canvas.addEventListener('pointerup', onCanvasPointerUp);
}

function disposeViewer() {
	cancelIntroZoom();
	detachPlanetClickHandlers();
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
		for (const planet of sceneResources.planets.values()) {
			disposePlanet(planet);
		}
		sceneResources.planets.clear();
		sceneResources.starsGeometry?.dispose();
		sceneResources.starsMaterial?.dispose();
		sceneResources.sunTexture?.dispose();
		sceneResources.sunMaterial?.dispose();
		sceneResources.lensflare?.dispose();
		for (const tex of sceneResources.lensflareTextures ?? []) tex.dispose();
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

function waitFrames(count = 2) {
	return new Promise((resolve) => {
		let left = Math.max(1, count);
		const step = () => {
			left -= 1;
			if (left <= 0) resolve();
			else requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	});
}

function viewerReady() {
	return !!(renderer && sceneResources?.controls && sceneResources?.camera);
}

function createPlanetEntry(id, position) {
	const res = sceneResources;
	if (!res) throw new Error('Sphere scene is not ready');

	const geometry = new THREE.SphereGeometry(1, 96, 64);
	// Glossy varnish over the map: clearcoat specular from scene lights.
	const material = new THREE.MeshPhysicalMaterial({
		color: 0x0a0a12,
		roughness: 0.62,
		metalness: 0.04,
		clearcoat: 0.7,
		clearcoatRoughness: 0.38
	});
	const globe = new THREE.Mesh(geometry, material);
	globe.userData.planetId = id;
	const atmosphere = createAtmosphere();
	atmosphere.mesh.userData.planetId = id;
	const earth = new THREE.Group();
	earth.visible = false;
	earth.position.copy(position);
	applySummerAxialTilt(earth, SUN_DIR);
	earth.add(globe);
	earth.add(atmosphere.mesh);
	res.scene.add(earth);

	const entry = {
		id,
		earth,
		globe,
		material,
		geometry,
		texture: null,
		atmosphereGeometry: atmosphere.geometry,
		atmosphereMaterial: atmosphere.material,
		loadSeq: 0,
		loadedUrl: ''
	};
	res.planets.set(id, entry);
	return entry;
}

async function applyTextureToPlanet(planet, url, opts = {}) {
	const seq = ++planet.loadSeq;
	const texture = await loadTexture(url, opts);
	if (seq !== planet.loadSeq || !sceneResources?.planets.has(planet.id)) {
		texture.dispose();
		return false;
	}
	const prev = planet.texture;
	planet.material.map = texture;
	planet.material.color.set(0xffffff);
	planet.material.needsUpdate = true;
	planet.texture = texture;
	planet.earth.visible = true;
	planet.loadedUrl = url;
	prev?.dispose();
	return true;
}

function captureViewState(planet) {
	if (!viewerReady() || !sceneResources) return null;
	const { camera, controls } = sceneResources;
	return {
		cameraPos: camera.position.clone(),
		target: controls.target.clone(),
		spinY: planet.globe.rotation.y
	};
}

function restoreViewState(planet, state) {
	if (!state || !viewerReady() || !sceneResources) return;
	const { camera, controls } = sceneResources;
	camera.position.copy(state.cameraPos);
	controls.target.copy(state.target);
	planet.globe.rotation.y = state.spinY;
	controls.update();
}

function syncCameraAspect() {
	const res = sceneResources;
	const webgl = renderer;
	if (!res || !webgl) return;
	const el = webgl.domElement.parentElement;
	if (!el) return;
	const w = el.clientWidth || window.innerWidth || 1;
	const h = el.clientHeight || window.innerHeight || 1;
	res.camera.aspect = w / h;
	res.camera.updateProjectionMatrix();
	webgl.setSize(w, h, true);
}

function frameFocusedPlanet() {
	const res = sceneResources;
	if (!res || !res.focusedId) return;
	const planet = res.planets.get(res.focusedId);
	if (!planet) return;
	const distance = framedFitDistance(res.camera);
	const dir = res.camera.position.clone().sub(res.controls.target);
	if (dir.lengthSq() < 1e-8) dir.copy(res.lookDir);
	dir.normalize();
	res.controls.target.copy(planet.earth.position);
	res.camera.position.copy(res.controls.target).addScaledVector(dir, distance);
	res.controls.update();
}

/**
 * Inter-planet flights approach from the current viewpoint (keeps destination on screen)
 * via a pull-back Bezier arc; intro zoom keeps the far starfield path.
 */
function animateCameraToPlanet(planet, { fromIntroDistance = false, durationMs }) {
	cancelIntroZoom();
	const res = sceneResources;
	if (!res) return Promise.resolve();

	const { camera, controls, lookDir } = res;
	const endTarget = planet.earth.position.clone();
	const framedDist = framedFitDistance(camera);
	const fallbackDir = lookDir.clone().normalize();

	let startTarget;
	let startCam;
	let midCam;
	let endCam;
	const cinematic = !fromIntroDistance;

	if (fromIntroDistance) {
		startTarget = endTarget.clone();
		startCam = endTarget.clone().addScaledVector(fallbackDir, INTRO_DISTANCE);
		camera.position.copy(startCam);
		controls.target.copy(startTarget);
		endCam = endTarget.clone().addScaledVector(fallbackDir, framedDist);
		midCam = startCam.clone().lerp(endCam, 0.5);
	} else {
		startTarget = controls.target.clone();
		startCam = camera.position.clone();
		// Approach from where we already see the destination — don't flip to STAGE_LOOK.
		const approachDir = startCam.clone().sub(endTarget);
		if (approachDir.lengthSq() < 1e-8) approachDir.copy(fallbackDir);
		else approachDir.normalize();
		endCam = endTarget.clone().addScaledVector(approachDir, framedDist);

		// Gentle arc (light pull-back) so travel is one continuous motion, not pull-then-dive.
		const span = Math.max(startCam.distanceTo(endCam), startCam.distanceTo(endTarget));
		const pullBack = THREE.MathUtils.clamp(span * 0.18, 2, 14);
		midCam = startCam.clone().lerp(endCam, 0.5).addScaledVector(approachDir, pullBack);
		midCam.y += pullBack * 0.12;
	}

	const maxNeeded =
		Math.max(
			startCam.distanceTo(endTarget),
			midCam.distanceTo(endTarget),
			endCam.distanceTo(endTarget),
			startCam.distanceTo(startTarget),
			INTRO_DISTANCE
		) + 1;
	controls.maxDistance = Math.max(controls.maxDistance, maxNeeded);
	controls.enabled = false;
	res.introActive = true;

	const camOut = new THREE.Vector3();
	return new Promise((resolve) => {
		introCancel = () => resolve();
		const start = performance.now();
		const step = (now) => {
			if (!sceneResources || sceneResources !== res) {
				introRaf = 0;
				introCancel = null;
				resolve();
				return;
			}
			const t = Math.min(1, (now - start) / durationMs);
			// One shared ease: look and camera travel together (look leads only slightly).
			const e = easeInOutCubic(t);
			const lookT = cinematic ? easeInOutCubic(Math.min(1, t * 1.08)) : e;
			controls.target.lerpVectors(startTarget, endTarget, lookT);
			if (cinematic) {
				bezier3(startCam, midCam, endCam, e, camOut);
				camera.position.copy(camOut);
			} else {
				camera.position.lerpVectors(startCam, endCam, e);
			}
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

async function finishFocusOnPlanet(planet, fromIntro) {
	const res = sceneResources;
	if (!res) return;

	syncCameraAspect();
	const durationMs = fromIntro ? INTRO_ZOOM_MS : FOCUS_FLY_MS;
	const p = animateCameraToPlanet(planet, {
		fromIntroDistance: fromIntro,
		durationMs
	});
	focusFlight = p.finally(() => {
		focusFlight = null;
	});
	await p;
	if (!sceneResources || sceneResources !== res || !res.planets.has(planet.id)) return;

	res.introActive = false;
	res.hadFirstIntro = true;
	res.focusedId = planet.id;
	res.controls.target.copy(planet.earth.position);
	res.controls.maxDistance = USER_MAX_DISTANCE;
	res.controls.minDistance = USER_MIN_DISTANCE;
	res.controls.enabled = true;
	res.autoFrame = true;
	setStatus('');
}

/** Sync starfield scene at intro distance — no texture load / no planets. */
function ensureScene(el) {
	if (viewerReady()) {
		setStatus('');
		return;
	}

	disposeViewer();
	el.replaceChildren();
	setStatus('');

	const lookDir = STAGE_LOOK.clone().normalize();

	const scene = new THREE.Scene();
	scene.background = new THREE.Color(0x000000);

	const camera = new THREE.PerspectiveCamera(40, 1, 0.1, CAMERA_FAR);
	camera.position.copy(lookDir).multiplyScalar(INTRO_DISTANCE);

	const webgl = new THREE.WebGLRenderer({
		antialias: true,
		alpha: false,
		preserveDrawingBuffer: true
	});
	webgl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	webgl.outputColorSpace = THREE.SRGBColorSpace;
	webgl.toneMapping = THREE.ACESFilmicToneMapping;
	webgl.toneMappingExposure = 1.05;
	webgl.setClearColor(0x000000, 1);
	el.appendChild(webgl.domElement);
	renderer = webgl;

	const stars = createStarfield();
	scene.add(stars.points);

	const sunLight = new THREE.DirectionalLight(0xfff1dd, 1.7);
	sunLight.position.copy(SUN_DIR);
	scene.add(sunLight);
	const sun = createSun(SUN_DIR);
	scene.add(sun.sprite);
	const flare = createSunLensflare(sun.sprite.position);
	scene.add(flare.lensflare);
	// Soft fill only — a second DirectionalLight would add a clearcoat specular on the night side.
	scene.add(new THREE.AmbientLight(0x9aa8c4, 0.48));
	scene.add(new THREE.HemisphereLight(0xb8c8e8, 0x1a2030, 0.28));

	const controls = new OrbitControls(camera, webgl.domElement);
	controls.enableDamping = true;
	controls.dampingFactor = 0.06;
	controls.autoRotate = true;
	controls.autoRotateSpeed = AUTO_ROTATE_SPEED;
	controls.minDistance = USER_MIN_DISTANCE;
	controls.maxDistance = INTRO_DISTANCE + 1;
	controls.target.set(0, 0, 0);
	controls.enabled = false;

	const onControlsStart = () => {
		if (sceneResources) sceneResources.autoFrame = false;
	};
	controls.addEventListener('start', onControlsStart);
	controls.update();

	sceneResources = {
		scene,
		camera,
		controls,
		lookDir,
		introActive: true,
		autoFrame: false,
		hadFirstIntro: false,
		focusedId: null,
		planets: new Map(),
		onControlsStart,
		starsGeometry: stars.geometry,
		starsMaterial: stars.material,
		sunTexture: sun.texture,
		sunMaterial: sun.material,
		lensflare: flare.lensflare,
		lensflareTextures: flare.textures
	};

	const fit = () => {
		const res = sceneResources;
		if (!res) return;
		const w = el.clientWidth || window.innerWidth || 1;
		const h = el.clientHeight || window.innerHeight || 1;
		res.camera.aspect = w / h;
		res.camera.updateProjectionMatrix();
		webgl.setSize(w, h, true);
		if (res.autoFrame && !res.introActive) frameFocusedPlanet();
	};
	fit();
	onWindowResize = fit;
	window.addEventListener('resize', onWindowResize);
	resizeObserver = new ResizeObserver(fit);
	resizeObserver.observe(el);

	const tick = () => {
		animationId = requestAnimationFrame(tick);
		const res = sceneResources;
		if (res) {
			for (const planet of res.planets.values()) {
				planet.globe.rotation.y -= GLOBE_SPIN;
			}
			// autoRotate (via controls.update) slowly orbits like a gentle horizontal drag.
			res.controls.update();
			webgl.render(res.scene, res.camera);
		}
	};
	tick();

	attachPlanetClickHandlers(webgl.domElement);
}

/**
 * Focus an existing planet, or spawn + texture + fly/frame a new one.
 * First planet uses the far starfield intro.
 */
async function focusOrCreatePlanet(id, url, opts = {}) {
	if (!container) throw new Error('Missing #globe container');
	if (focusFlight) await focusFlight;
	if (mounting) await mounting;
	if (finishing) await finishing;

	ensureScene(container);
	const res = sceneResources;
	if (!res || !renderer) throw new Error('Sphere scene is not ready');

	const existing = res.planets.get(id);
	if (existing) {
		if (url !== existing.loadedUrl) {
			await applyTextureToPlanet(existing, url, opts);
		}
		if (res.focusedId === id && !res.introActive) {
			setStatus('');
			return;
		}
		await finishFocusOnPlanet(existing, !res.hadFirstIntro);
		return;
	}

	const position = pickPlanetPosition(res.planets, id);
	const planet = createPlanetEntry(id, position);
	const fromIntro = !res.hadFirstIntro;

	try {
		const ok = await applyTextureToPlanet(planet, url, opts);
		if (!ok || !sceneResources?.planets.has(id)) return;
		await finishFocusOnPlanet(planet, fromIntro);
	} catch (err) {
		if (sceneResources?.planets.get(id) === planet && !planet.texture) {
			disposePlanet(planet);
			sceneResources.planets.delete(id);
		}
		throw err;
	}
}

/** Silent hot-swap on one planet — no camera move. */
async function updatePlanetTexture(id, url, opts = {}) {
	if (!container) throw new Error('Missing #globe container');
	if (mounting) await mounting;
	if (finishing) await finishing;

	ensureScene(container);
	const res = sceneResources;
	if (!res) throw new Error('Sphere scene is not ready');

	const existing = res.planets.get(id);
	if (existing) {
		if (url === existing.loadedUrl) {
			setStatus('');
			return;
		}
		const view = captureViewState(existing);
		const ok = await applyTextureToPlanet(existing, url, opts);
		if (!ok) return;
		restoreViewState(existing, view);
		setStatus('');
		return;
	}

	const position = pickPlanetPosition(res.planets, id);
	const planet = createPlanetEntry(id, position);
	const shouldFocus = !res.focusedId && !res.hadFirstIntro;

	try {
		const ok = await applyTextureToPlanet(planet, url, opts);
		if (!ok || !sceneResources?.planets.has(id)) return;
		if (shouldFocus) {
			await finishFocusOnPlanet(planet, true);
		}
		setStatus('');
	} catch (err) {
		if (sceneResources?.planets.get(id) === planet && !planet.texture) {
			disposePlanet(planet);
			sceneResources.planets.delete(id);
		}
		throw err;
	}
}

/** Wait until focused planet has texture and intro is done. */
async function waitForIntroReady(timeoutMs = 30_000) {
	const start = performance.now();
	while (performance.now() - start < timeoutMs) {
		const res = sceneResources;
		const focused = res?.focusedId ? res.planets.get(res.focusedId) : undefined;
		if (focused?.texture && res && !res.introActive) return true;
		await new Promise((r) => requestAnimationFrame(r));
	}
	const res = sceneResources;
	const focused = res?.focusedId ? res.planets.get(res.focusedId) : undefined;
	return !!(focused?.texture && res && !res.introActive);
}

async function captureGlobeThumbBlob() {
	const ready = await waitForIntroReady();
	if (!ready || !sceneResources?.scene || !sceneResources?.camera || !renderer) {
		throw new Error('Viewer not ready for screenshot');
	}
	await waitFrames(3);
	renderer.render(sceneResources.scene, sceneResources.camera);
	const canvas = renderer.domElement;
	const blob = await new Promise((resolve, reject) => {
		canvas.toBlob(
			(b) => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))),
			'image/jpeg',
			0.82
		);
	});
	return blob;
}

async function fetchLatestGlobe() {
	const response = await fetch(`${API_ORIGIN}/api/jobs/latest-globe`);
	if (!response.ok) {
		const body = await response.json().catch(() => ({}));
		throw new Error(body.error || `HTTP ${response.status}`);
	}
	return response.json();
}

/** Parse Apache/nginx autoindex HTML (or a plain newline list) into image filenames. */
function parseDirectoryListing(text) {
	const names = new Set();
	const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
	let match;
	while ((match = hrefRe.exec(text))) {
		let href = match[1].trim();
		if (!href || href === '/' || href.startsWith('?') || href.startsWith('#')) continue;
		try {
			href = decodeURIComponent(href);
		} catch {
			/* keep raw */
		}
		const base = href.split(/[?#]/)[0].replace(/\/$/, '').split('/').pop() || '';
		if (!base || base === '..' || base === '.') continue;
		if (!IMAGE_NAME_RE.test(base)) continue;
		names.add(base);
	}
	if (names.size === 0) {
		for (const line of text.split(/\r?\n/)) {
			const base = line.trim().split(/[/?#]/).pop() || '';
			if (IMAGE_NAME_RE.test(base)) names.add(base);
		}
	}
	return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function isThumbFilename(name) {
	return THUMB_NAME_RE.test(name);
}

function thumbNameFor(filename) {
	return String(filename).replace(IMAGE_NAME_RE, '-thumb.jpg');
}

function textureArchiveNames() {
	return archivedNames.filter((name) => !isThumbFilename(name));
}

async function listArchivedPreviews() {
	try {
		const response = await fetch(`${PREVIEW_LIST_URL}?t=${Date.now()}`, {
			cache: 'no-store',
			headers: { Accept: 'application/json, text/plain, */*' }
		});
		if (!response.ok) return archivedNames;
		const text = await response.text();
		try {
			const data = JSON.parse(text);
			if (Array.isArray(data)) {
				archivedNames = data
					.map((name) => String(name))
					.filter((name) => IMAGE_NAME_RE.test(name))
					.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
				return archivedNames;
			}
		} catch {
			/* fall through to HTML directory listing */
		}
		archivedNames = parseDirectoryListing(text);
		return archivedNames;
	} catch {
		return archivedNames;
	}
}

function archiveUrl(filename) {
	return new URL(encodeURIComponent(filename), PREVIEW_DIR_URL).href;
}

function previewDirLabel() {
	try {
		return new URL(PREVIEW_DIR_URL).pathname;
	} catch {
		return '/globe-preview/';
	}
}

function sanitizeArchiveName(raw) {
	const base = String(raw || 'globe')
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-zA-Z0-9._-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^[-.]+|[-.]+$/g, '')
		.slice(0, 80);
	const stem = base || 'globe';
	return IMAGE_NAME_RE.test(stem) ? stem : `${stem}.jpg`;
}

function archiveNameForJob(job) {
	const place = job.placeName ? String(job.placeName) : 'globe';
	const id = job.id ? String(job.id).slice(0, 12) : String(Date.now());
	return sanitizeArchiveName(`${place}-${id}.jpg`);
}

/** Gallery label: drop extension and trailing job-id / timestamp suffix. */
function archiveDisplayLabel(filename) {
	const stem = String(filename || '')
		.replace(THUMB_NAME_RE, '')
		.replace(IMAGE_NAME_RE, '');
	const withoutId = stem.replace(/-(?:[0-9a-f]{8}-[0-9a-f]{3}|\d{10,})$/i, '');
	return withoutId || stem || filename;
}

function placeLabelFromJob(job) {
	if (!job || job.fallback === true) return 'Unavailable';
	const place = job.placeName != null ? String(job.placeName).trim() : '';
	return place || 'Globe';
}

async function headExists(filename) {
	const head = await fetch(archiveUrl(filename), { method: 'HEAD', cache: 'no-store' }).catch(
		() => null
	);
	return !!head?.ok;
}

async function postArchiveBlob(filename, blob, meta = null) {
	const saveUrl = `${PREVIEW_SAVE_URL}?name=${encodeURIComponent(filename)}${archiveMetaQuery(meta)}`;
	const saveRes = await fetch(saveUrl, {
		method: 'POST',
		body: blob,
		headers: {
			'Content-Type': blob.type || 'image/jpeg'
		}
	});
	if (!saveRes.ok && saveRes.status !== 201 && saveRes.status !== 204) {
		console.warn(
			`Could not archive ${filename} (${saveRes.status}). Check PHP write access on ${previewDirLabel()}`
		);
		return false;
	}
	return true;
}

async function fetchArchiveImageMeta(filename) {
	try {
		const response = await fetch(`${archiveUrl(filename)}?meta=1`, { cache: 'no-store' });
		if (!response.ok) return null;
		return parseArchiveImageMeta(await response.arrayBuffer());
	} catch {
		return null;
	}
}

async function refreshArchiveMeta(names = archivedNames) {
	const textures = names.filter((name) => !isThumbFilename(name));
	if (textures.length === 0) {
		archiveMetaByName = {};
		return;
	}
	const nameSet = new Set(names);
	const entries = await Promise.all(
		textures.map(async (name) => {
			const thumb = thumbNameFor(name);
			const source = nameSet.has(thumb) ? thumb : name;
			const meta = await fetchArchiveImageMeta(source);
			return [name, meta];
		})
	);
	const next = {};
	for (const [name, meta] of entries) {
		if (meta) next[name] = meta;
	}
	archiveMetaByName = next;
}

function labelForArchive(name) {
	return archiveLabelFromMeta(archiveMetaByName[name], archiveDisplayLabel(name));
}

function rememberArchived(...names) {
	archivedNames = [...new Set([...archivedNames, ...names.filter(Boolean)])].sort((a, b) =>
		a.localeCompare(b, undefined, { sensitivity: 'base' })
	);
	void refreshArchiveMeta(archivedNames).then(() => rebuildArchiveGallery());
}

/**
 * After the live globe is on screen: store equirect map + canvas screenshot (-thumb).
 * If files already exist without GM1 metadata, re-POST with meta from the live job.
 */
async function archiveLivePreview(filename, sourceUrl, meta = null) {
	if (!filename || !sourceUrl) return;
	const thumbName = thumbNameFor(filename);
	const hasTexture = archivedNames.includes(filename) || (await headExists(filename));
	const hasThumb = archivedNames.includes(thumbName) || (await headExists(thumbName));

	let needsMeta = false;
	if (meta && (hasTexture || hasThumb)) {
		const probe = hasThumb ? thumbName : filename;
		needsMeta = (await fetchArchiveImageMeta(probe)) == null;
	}

	if (hasTexture && hasThumb && !needsMeta) {
		rememberArchived(filename, thumbName);
		return;
	}

	if (!hasTexture || needsMeta) {
		let blob = null;
		if (!hasTexture) {
			const imageRes = await fetch(sourceUrl, { mode: 'cors', cache: 'no-store' });
			if (imageRes.ok) blob = await imageRes.blob();
		} else {
			const existing = await fetch(archiveUrl(filename), { cache: 'no-store' }).catch(() => null);
			if (existing?.ok) blob = await existing.blob();
		}
		if (!blob && !hasTexture) return;
		if (blob) {
			const ok = await postArchiveBlob(filename, blob, meta);
			if (!ok && !hasTexture) return;
		}
	}

	if (!hasThumb || needsMeta) {
		try {
			let thumbBlob = null;
			if (!hasThumb) {
				thumbBlob = await captureGlobeThumbBlob();
			} else {
				thumbBlob = (await captureGlobeThumbBlob()) || null;
				if (!thumbBlob) {
					const existing = await fetch(archiveUrl(thumbName), { cache: 'no-store' }).catch(
						() => null
					);
					if (existing?.ok) thumbBlob = await existing.blob();
				}
			}
			if (thumbBlob) await postArchiveBlob(thumbName, thumbBlob, meta);
		} catch (err) {
			console.warn('Could not capture globe thumb', err);
		}
	}

	rememberArchived(filename, thumbName);
}

function rebuildArchiveGallery() {
	if (!archiveList) return;
	archiveList.replaceChildren();

	const liveBtn = document.createElement('button');
	liveBtn.type = 'button';
	liveBtn.className = 'archive-item';
	liveBtn.dataset.archive = '';
	liveBtn.setAttribute('aria-current', selectedArchive ? 'false' : 'true');
	const liveThumb = document.createElement('span');
	liveThumb.className = 'archive-thumb-placeholder';
	liveThumb.textContent = 'LIVE';
	const liveName = document.createElement('span');
	liveName.className = 'archive-name';
	liveName.textContent = liveDisplayName || 'Latest';
	liveBtn.append(liveThumb, liveName);
	liveBtn.addEventListener('click', () => void selectArchive(''));
	archiveList.appendChild(liveBtn);

	const textures = textureArchiveNames();
	const grid = document.createElement('div');
	grid.className = 'archive-grid';

	const newLink = document.createElement('a');
	newLink.className = 'archive-tile archive-tile-new';
	newLink.href = `${API_ORIGIN}/?mode=globe`;
	newLink.target = '_blank';
	newLink.rel = 'noopener noreferrer';
	newLink.title = 'Create a globe';
	newLink.setAttribute('aria-label', 'Create a globe');
	const newThumb = document.createElement('span');
	newThumb.className = 'archive-thumb-placeholder archive-thumb-new';
	newThumb.setAttribute('aria-hidden', 'true');
	newThumb.textContent = '+';
	const newLabel = document.createElement('span');
	newLabel.className = 'archive-name';
	newLabel.textContent = 'New';
	newLink.append(newThumb, newLabel);
	grid.appendChild(newLink);

	for (const name of textures) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'archive-tile';
		btn.dataset.archive = name;
		btn.setAttribute('aria-current', selectedArchive === name ? 'true' : 'false');

		const thumbName = thumbNameFor(name);
		const displayLabel = labelForArchive(name);
		const tip = formatArchiveMetaTooltip(archiveMetaByName[name]) || displayLabel;
		btn.title = tip;
		if (archivedNames.includes(thumbName)) {
			const img = document.createElement('img');
			img.className = 'archive-thumb';
			img.src = `${archiveUrl(thumbName)}?v=2`;
			img.alt = '';
			img.loading = 'lazy';
			btn.appendChild(img);
		} else {
			const ph = document.createElement('span');
			ph.className = 'archive-thumb-placeholder';
			ph.textContent = 'MAP';
			btn.appendChild(ph);
		}

		const label = document.createElement('span');
		label.className = 'archive-name';
		label.textContent = displayLabel;
		btn.appendChild(label);
		btn.addEventListener('click', () => void selectArchive(name));
		grid.appendChild(btn);
	}

	archiveList.appendChild(grid);
}

async function refreshArchiveList() {
	await listArchivedPreviews();
	await refreshArchiveMeta(archivedNames);
	rebuildArchiveGallery();
}

async function selectArchive(filename) {
	selectedArchive = filename || '';
	rebuildArchiveGallery();

	try {
		if (selectedArchive) {
			const url = archiveUrl(selectedArchive);
			const label = labelForArchive(selectedArchive);
			await focusOrCreatePlanet(selectedArchive, url, { depolarSquare: false });
			const recreateHref = recreatePageUrl(archiveMetaByName[selectedArchive]);
			setPlaceLabel(label, recreateHref, 'Recreate in Globe Maker');
			document.title = `${label} — Globe Monitor`;
			return;
		}

		const opts = lastLiveJob
			? {
					depolarSquare: lastLiveJob.fallback === true,
					emptyFillColor: lastLiveJob.emptyFillColor || '#808080'
				}
			: {};
		if (liveUrl) {
			await focusOrCreatePlanet('live', liveUrl, opts);
			livePlanetReady = true;
			const liveLabel =
				liveDisplayName && liveDisplayName !== 'Unavailable' ? liveDisplayName : '';
			const liveJobHref =
				lastLiveJob && lastLiveJob.fallback !== true && lastLiveJob.id
					? jobPageUrl(lastLiveJob.id)
					: '';
			setPlaceLabel(liveLabel, liveJobHref, 'Open job');
			document.title =
				liveDisplayName && liveDisplayName !== 'Unavailable'
					? `${liveDisplayName} — Globe Monitor`
					: 'Globe Maker — Globe Monitor';
		} else {
			await refreshLive();
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Could not load globe preview.';
		setStatus(message);
	}
}

async function refreshLive() {
	try {
		const job = await fetchLatestGlobe();
		lastLiveJob = job;
		lastArchiveMeta = archiveMetaFromJob(job);
		liveDisplayName = placeLabelFromJob(job);
		rebuildArchiveGallery();

		const previewUrl = resolvePreviewUrl(job.spherePreviewUrl, {
			fallback: job.fallback === true
		});
		if (!previewUrl) throw new Error('No sphere preview URL');
		liveUrl = previewUrl;

		const opts = {
			depolarSquare: job.fallback === true,
			emptyFillColor: job.emptyFillColor || '#808080'
		};

		if (!container) throw new Error('Missing #globe container');

		if (!selectedArchive && !livePlanetReady) {
			await focusOrCreatePlanet('live', previewUrl, opts);
			livePlanetReady = true;
		} else {
			await updatePlanetTexture('live', previewUrl, opts);
			if (!livePlanetReady) livePlanetReady = true;
		}

		if (!selectedArchive) {
			const liveLabel =
				liveDisplayName && liveDisplayName !== 'Unavailable' ? liveDisplayName : '';
			const liveJobHref =
				job.fallback !== true && job.id ? jobPageUrl(job.id) : '';
			setPlaceLabel(liveLabel, liveJobHref, 'Open job');
			document.title =
				liveDisplayName && liveDisplayName !== 'Unavailable'
					? `${liveDisplayName} — Globe Monitor`
					: 'Globe Maker — Globe Monitor';
		}

		if (job.fallback !== true && job.id && !selectedArchive) {
			void archiveLivePreview(archiveNameForJob(job), previewUrl, lastArchiveMeta);
		}
	} catch (err) {
		if (!liveUrl) {
			const message = err instanceof Error ? err.message : 'Could not load globe preview.';
			setStatus(message);
		} else {
			console.warn('Live globe refresh failed', err);
		}
	}
}

function startPolling() {
	stopPolling();
	pollTimer = window.setInterval(() => {
		void refreshLive();
	}, POLL_MS);
}

function stopPolling() {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = 0;
	}
}

function syncFullscreenUi() {
	if (!fullscreenBtn) return;
	const active = document.fullscreenElement != null;
	fullscreenBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
	fullscreenBtn.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Enter fullscreen');
	fullscreenBtn.title = active ? 'Exit fullscreen' : 'Enter fullscreen';
}

async function toggleFullscreen() {
	try {
		if (document.fullscreenElement) {
			await document.exitFullscreen();
		} else if (typeof document.documentElement.requestFullscreen === 'function') {
			await document.documentElement.requestFullscreen();
		}
	} catch {
		/* denied */
	}
}

function setArchivePaneOpen(open) {
	archivePaneOpen = open;
	document.body.classList.toggle('archive-open', open);
	if (archiveBtn) {
		archiveBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
		archiveBtn.setAttribute('aria-label', open ? 'Close saved globes' : 'Open saved globes');
		archiveBtn.title = open ? 'Close saved globes' : 'Saved globes';
	}
	if (archivePane) {
		archivePane.setAttribute('aria-hidden', open ? 'false' : 'true');
	}
}

function initFullscreen() {
	if (!fullscreenBtn) return;
	const supported =
		!!document.fullscreenEnabled &&
		typeof document.documentElement.requestFullscreen === 'function';
	fullscreenBtn.hidden = !supported;
	if (!supported) return;
	fullscreenBtn.addEventListener('click', () => void toggleFullscreen());
	document.addEventListener('fullscreenchange', syncFullscreenUi);
	syncFullscreenUi();
}

function initArchivePane() {
	if (!archiveBtn || !archivePane) return;
	setArchivePaneOpen(false);
	archiveBtn.addEventListener('click', () => {
		setArchivePaneOpen(!archivePaneOpen);
		if (archivePaneOpen) void refreshArchiveList();
	});
	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && archivePaneOpen) setArchivePaneOpen(false);
	});
}

async function boot() {
	initFullscreen();
	initArchivePane();
	// Starfield immediately — before API fetch / texture decode.
	if (container) ensureScene(container);
	await refreshArchiveList();
	await refreshLive();
	startPolling();
}

void boot();

window.addEventListener('beforeunload', () => {
	stopPolling();
	disposeViewer();
});
