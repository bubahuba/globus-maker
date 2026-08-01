/** Shared Open Graph / Twitter card metadata. Images live in `static/about/`. */

export const SITE_NAME = 'Globus Maker';

export type OgImage = {
	/** Path under the site root, e.g. `/about/….png`. */
	path: string;
	alt: string;
	width: number;
	height: number;
	type?: string;
};

const PNG = {
	width: 1536,
	height: 1024,
	type: 'image/png'
} as const;

/** Map-mode framed print — primary share image for the app. */
export const OG_IMAGE_MAP: OgImage = {
	path: '/about/map-mode-framed-wall-normal.png',
	alt: 'Framed city map print on a living-room wall',
	...PNG
};

/** Globe sphere lamp — second share image for the app. */
export const OG_IMAGE_GLOBE: OgImage = {
	path: '/about/sphere-lamp-map-projection-hero.png',
	alt: 'City map sphere lamp projecting soft map light in a living room',
	...PNG
};

export const OG_IMAGE_MAP_LIT: OgImage = {
	path: '/about/map-mode-framed-wall-enlighted.png',
	alt: 'Backlit framed city map glowing on a living-room wall',
	...PNG
};

export const OG_IMAGE_GLOBE_ARTISTIC: OgImage = {
	path: '/about/globe-mode-artistic-sphere-hero.png',
	alt: 'Sphere lamp with violet, neon yellow, and fuchsia city map wrap',
	...PNG
};

/** Home / default social preview images (map + globe). */
export const HOME_OG_IMAGES: readonly OgImage[] = [OG_IMAGE_GLOBE_ARTISTIC, OG_IMAGE_MAP_LIT, OG_IMAGE_GLOBE];

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
