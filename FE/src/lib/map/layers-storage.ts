import {
	createDefaultMapLayers,
	validateMapLayers,
	type MapLayerStyle
} from '@shared/map-style';

const STORAGE_KEY = 'globus-maker:map-layers';

/** Load persisted layer colors/toggles, merging with defaults. Safe on SSR. */
export function loadMapLayers(): MapLayerStyle {
	if (typeof localStorage === 'undefined') {
		return createDefaultMapLayers();
	}

	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return createDefaultMapLayers();
		return validateMapLayers(JSON.parse(raw));
	} catch {
		return createDefaultMapLayers();
	}
}

/** Persist layer colors/toggles. No-op on SSR or storage failures. */
export function saveMapLayers(layers: MapLayerStyle): void {
	if (typeof localStorage === 'undefined') return;

	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(layers));
	} catch {
		// QuotaExceededError / private mode — ignore
	}
}
