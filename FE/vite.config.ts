import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const API_PROXY = {
	target: 'http://localhost:8787',
	changeOrigin: true
};

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: {
		proxy: {
			'/api': API_PROXY,
			'/health': API_PROXY
		}
	}
});
