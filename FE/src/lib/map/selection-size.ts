import { MAX_SIDE_METERS } from '@shared/tile-constants';

export const MIN_SIDE_METERS = 500;

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

/** Adjust side length from a wheel delta (scroll up = smaller, down = larger). */
export function adjustSideMetersFromWheel(currentMeters: number, deltaY: number): number {
	if (deltaY === 0) return currentMeters;
	const sign = Math.sign(deltaY);
	const magnitude = Math.min(3, Math.max(1, Math.abs(deltaY) / 50));
	const slider = sideToSlider(currentMeters) + sign * magnitude;
	return sliderToSide(Math.min(100, Math.max(0, slider)));
}
