import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const monitorRoot = dirname(fileURLToPath(import.meta.url));
const threePkg = resolve(monitorRoot, '../FE/node_modules/three');
const previewDir = resolve(monitorRoot, 'globe-preview');
const port = Number(process.env.MONITOR_PORT || 5193);
const apiOrigin = (process.env.MONITOR_API_ORIGIN || 'https://globe.rgb.sk').replace(/\/$/, '');

const IMAGE_NAME_RE = /\.(jpe?g|png|webp)$/i;

async function listPreviewNames() {
	await mkdir(previewDir, { recursive: true });
	return (await readdir(previewDir))
		.filter((name) => IMAGE_NAME_RE.test(name))
		.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/**
 * Local stand-in for production list.php / save.php under /globe-preview/.
 * @returns {import('vite').Plugin}
 */
function globePreviewArchivePlugin() {
	return {
		name: 'globe-preview-archive',
		configureServer(server) {
			server.middlewares.use(async (req, res, next) => {
				const url = new URL(req.url || '/', 'http://vite.local');
				if (!url.pathname.startsWith('/globe-preview')) return next();

				const relative = decodeURIComponent(url.pathname.slice('/globe-preview'.length));
				const pathOnly = relative.replace(/^\/+/, '').split('/')[0] || '';

				try {
					if (
						(req.method === 'GET' || req.method === 'HEAD') &&
						(pathOnly === 'list.php' || relative === '' || relative === '/')
					) {
						const names = await listPreviewNames();
						const body = JSON.stringify(names);
						res.statusCode = 200;
						res.setHeader('Content-Type', 'application/json; charset=utf-8');
						res.setHeader('Cache-Control', 'no-store');
						if (req.method === 'HEAD') {
							res.end();
							return;
						}
						res.end(body);
						return;
					}

					if (req.method === 'POST' && pathOnly === 'save.php') {
						const filename = url.searchParams.get('name') || '';
						if (!IMAGE_NAME_RE.test(filename) || filename.includes('..')) {
							res.statusCode = 400;
							res.end('Invalid filename');
							return;
						}
						const chunks = [];
						for await (const chunk of req) chunks.push(chunk);
						await mkdir(previewDir, { recursive: true });
						await writeFile(resolve(previewDir, filename), Buffer.concat(chunks));
						res.statusCode = 201;
						res.end('Created');
						return;
					}

					if (req.method === 'OPTIONS' && (pathOnly === 'save.php' || pathOnly === 'list.php')) {
						res.statusCode = 204;
						res.setHeader('Allow', 'GET, HEAD, POST, OPTIONS');
						res.end();
						return;
					}
				} catch (err) {
					res.statusCode = 500;
					res.end(err instanceof Error ? err.message : 'Archive error');
					return;
				}

				return next();
			});
		}
	};
}

/** @type {import('vite').UserConfig} */
export default {
	root: monitorRoot,
	plugins: [globePreviewArchivePlugin()],
	resolve: {
		alias: [
			// Dev resolves npm three from FE; static hosts still use the HTML importmap.
			{ find: /^three$/, replacement: threePkg },
			{
				find: /^three\/addons\/(.*)/,
				replacement: `${resolve(threePkg, 'examples/jsm')}/$1`
			}
		]
	},
	server: {
		port,
		strictPort: true,
		open: `/?origin=${encodeURIComponent(apiOrigin)}`,
		fs: {
			allow: [monitorRoot, resolve(monitorRoot, '../FE/node_modules')]
		}
	},
	clearScreen: false
};
