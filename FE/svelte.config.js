import adapter from '@sveltejs/adapter-static';

/** Keep in sync with `DEFAULT_SITE_ORIGIN` in `src/lib/seo.ts`. */
const DEFAULT_SITE_ORIGIN = 'https://globus-maker.shadow-hub.workers.dev';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		runes: ({ filename }) =>
			filename.split(/[/\\]/).includes('node_modules') ? undefined : true
	},
	kit: {
		alias: {
			'@lib': 'src/lib',
			'@shared': '../shared'
		},
		// Absolute og:url / og:image are baked in at prerender time.
		// Override with PUBLIC_SITE_ORIGIN when building for a different host.
		prerender: {
			origin: process.env.PUBLIC_SITE_ORIGIN || DEFAULT_SITE_ORIGIN
		},
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			strict: true
		})
	}
};

export default config;
