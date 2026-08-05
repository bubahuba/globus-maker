import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const monitorRoot = dirname(fileURLToPath(import.meta.url));
const threePkg = resolve(monitorRoot, '../FE/node_modules/three');
const port = Number(process.env.MONITOR_PORT || 5193);
const apiOrigin = (process.env.MONITOR_API_ORIGIN || 'https://globe.rgb.sk').replace(/\/$/, '');

/** @type {import('vite').UserConfig} */
export default {
	root: monitorRoot,
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
