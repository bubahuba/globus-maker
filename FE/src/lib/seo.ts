/** Shared Open Graph / Twitter card metadata. Images live in `static/about/`. */

export const SITE_NAME = 'Globus Maker';

/**
 * Canonical public origin baked into prerendered HTML for og:url / og:image.
 * Override with PUBLIC_SITE_ORIGIN at build time (FE/.env or the build env).
 */
export const DEFAULT_SITE_ORIGIN = 'https://globus-maker.shadow-hub.workers.dev';

export type OgImage = {
	/** Path under the site root, e.g. `/about/….webp`. */
	path: string;
	alt: string;
	width: number;
	height: number;
	type?: string;
};

/** 1280w WebP about assets — small enough for social crawlers (PNG sources are 2MB+). */
const WEBP_1280 = {
	width: 1280,
	height: 853,
	type: 'image/webp'
} as const;

/** Map-mode framed print — primary share image for the app. */
export const OG_IMAGE_MAP: OgImage = {
	path: '/about/map-mode-framed-wall-normal-1280.webp',
	alt: 'Framed city map print on a living-room wall',
	...WEBP_1280
};

/** Globe sphere lamp — second share image for the app. */
export const OG_IMAGE_GLOBE: OgImage = {
	path: '/about/sphere-lamp-map-projection-hero-1280.webp',
	alt: 'City map sphere lamp projecting soft map light in a living room',
	...WEBP_1280
};

export const OG_IMAGE_MAP_LIT: OgImage = {
	path: '/about/map-mode-framed-wall-enlighted-1280.webp',
	alt: 'Backlit framed city map glowing on a living-room wall',
	...WEBP_1280
};

export const OG_IMAGE_GLOBE_ARTISTIC: OgImage = {
	path: '/about/globe-mode-artistic-sphere-hero-1280.webp',
	alt: 'Sphere lamp with violet, neon yellow, and fuchsia city map wrap',
	...WEBP_1280
};

/** Home / default social preview images. */
export const HOME_OG_IMAGES: readonly OgImage[] = [
	OG_IMAGE_GLOBE_ARTISTIC,
	OG_IMAGE_MAP_LIT,
	OG_IMAGE_GLOBE
];

/** About page social preview — map, globe, and artistic variants. */
export const ABOUT_OG_IMAGES: readonly OgImage[] = [
	OG_IMAGE_MAP,
	OG_IMAGE_GLOBE,
	OG_IMAGE_MAP_LIT,
	OG_IMAGE_GLOBE_ARTISTIC
];

export const HOME_DESCRIPTION =
	'Make a square city map or globe meridian stripes from any place on OpenStreetMap or upload own map.';

export const ABOUT_DESCRIPTION =
	'Make a square city map or globe meridian stripes from any place on OpenStreetMap.';

/** Join origin + path into an absolute URL (required for og:image crawlers). */
export function absoluteUrl(origin: string, path: string): string {
	const base = origin.replace(/\/$/, '');
	const suffix = path.startsWith('/') ? path : `/${path}`;
	return `${base}${suffix}`;
}
