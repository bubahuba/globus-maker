/** Globe download price scales with diameter (EUR). */

export const GLOBE_PRICE_MIN_CM = 20;
export const GLOBE_PRICE_MAX_CM = 60;
export const GLOBE_PRICE_MIN_EUR = 2;
export const GLOBE_PRICE_MAX_EUR = 6;

/**
 * PayPal unit amount for a globe download.
 * Linear: €2 at 20 cm → €6 at 60 cm (clamped outside that range).
 */
export function globeDownloadPriceEuro(diameterCm: number): string {
  const d = Number(diameterCm);
  if (!Number.isFinite(d)) return GLOBE_PRICE_MIN_EUR.toFixed(2);

  const spanCm = GLOBE_PRICE_MAX_CM - GLOBE_PRICE_MIN_CM;
  const t = Math.min(1, Math.max(0, (d - GLOBE_PRICE_MIN_CM) / spanCm));
  const euro = GLOBE_PRICE_MIN_EUR + t * (GLOBE_PRICE_MAX_EUR - GLOBE_PRICE_MIN_EUR);
  return euro.toFixed(2);
}
