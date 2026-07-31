import { MAX_SIDE_METERS } from '@shared/tile-constants';

export const MIN_SIDE_METERS = 500;

/**
 * Nominatim reverse `zoom` from selection square size (≈ Leaflet zoom after fit).
 * Larger squares → coarser labels (region/country); small squares → suburb/city.
 */
export function nominatimZoomFromSideMeters(sideMeters: number): number {
	const m = Number(sideMeters);
	if (!Number.isFinite(m) || m <= 2_000) return 14;
	if (m <= 8_000) return 12;
	if (m <= 30_000) return 10;
	if (m <= 100_000) return 8;
	if (m <= 500_000) return 6;
	if (m <= 2_000_000) return 4;
	return 2;
}

/** Log-scale slider position (0–100) for square side in meters. */
export function sideToSlider(meters: number): number {
	return (100 * Math.log(meters / MIN_SIDE_METERS)) / Math.log(MAX_SIDE_METERS / MIN_SIDE_METERS);
}

/** Square side in meters from log-scale slider position (0–100). */
export function sliderToSide(position: number): number {
	return Math.round(
		MIN_SIDE_METERS * (MAX_SIDE_METERS / MIN_SIDE_METERS) ** (position / 100)
	);
}

/** Matches the square-side range input `step` on the main page. */
export const SIDE_SLIDER_STEP = 0.5;

/** Adjust side length by N log-slider steps (+ = larger square, − = smaller). */
export function adjustSideMetersBySliderStep(
	currentMeters: number,
	steps: number,
	stepSize = SIDE_SLIDER_STEP
): number {
	if (steps === 0) return currentMeters;
	const slider = sideToSlider(currentMeters) + steps * stepSize;
	return sliderToSide(Math.min(100, Math.max(0, slider)));
}

/** Adjust side length from a wheel delta (scroll up = smaller, down = larger). */
export function adjustSideMetersFromWheel(currentMeters: number, deltaY: number): number {
	if (deltaY === 0) return currentMeters;
	const sign = Math.sign(deltaY);
	const magnitude = Math.min(3, Math.max(1, Math.abs(deltaY) / 50));
	const slider = sideToSlider(currentMeters) + sign * magnitude;
	return sliderToSide(Math.min(100, Math.max(0, slider)));
}
