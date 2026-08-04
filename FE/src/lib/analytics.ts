/** Thin GA4 (gtag) wrapper — safe on SSR and when the script is blocked. */

export type AnalyticsParams = Record<string, string | number | boolean | undefined | null>;

export type AnalyticsMode = 'map' | 'globe';

export type ModeEventAction = 'generate' | 'download' | 'share' | 'purchase';

declare global {
	interface Window {
		gtag?: (...args: unknown[]) => void;
		dataLayer?: unknown[];
	}
}

export function trackEvent(name: string, params?: AnalyticsParams): void {
	if (typeof window === 'undefined' || typeof window.gtag !== 'function') return;

	const cleaned: Record<string, string | number | boolean> = {};
	if (params) {
		for (const [key, value] of Object.entries(params)) {
			if (value === undefined || value === null || value === '') continue;
			cleaned[key] = value;
		}
	}

	window.gtag('event', name, cleaned);
}

/** Fires `generateMap` / `downloadGlobe` / etc. from action + mode. */
export function trackModeEvent(
	action: ModeEventAction,
	mode: AnalyticsMode,
	params?: AnalyticsParams
): void {
	const suffix = mode === 'map' ? 'Map' : 'Globe';
	trackEvent(`${action}${suffix}`, params);
}
