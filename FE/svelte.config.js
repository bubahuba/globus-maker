import adapter from '@sveltejs/adapter-static';

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
		// Absolute og:url / og:image need a real origin during prerender.
		// Set PUBLIC_SITE_ORIGIN (e.g. https://your-worker.example) before `npm run build`.
		prerender: {
			origin: process.env.PUBLIC_SITE_ORIGIN || 'http://localhost:5173'
		},
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			strict: true
		})
	}
};

export default config;
