import type { Env } from "../env";
import {
  GLOBE_PRICE_MAX_CM,
  GLOBE_PRICE_MAX_EUR,
  GLOBE_PRICE_MIN_CM,
  GLOBE_PRICE_MIN_EUR,
  globeDownloadPriceEuro,
} from "../../../shared/globe-pricing";

export type PaypalMode = "sandbox" | "live";

export interface PaypalRuntimeConfig {
  mode: PaypalMode;
  clientId: string;
  clientSecret: string;
  currency: string;
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

export function resolvePaypalConfig(env: Env): PaypalRuntimeConfig | null {
  const clientId = firstNonEmpty(env.PAYPAL_CLIENT_ID, env.USER_PAYPAL);
  const clientSecret = firstNonEmpty(env.PAYPAL_CLIENT_SECRET, env.PASS_PAYPAL);
  if (!clientId || !clientSecret) return null;

  const modeRaw = (env.PAYPAL_MODE ?? "sandbox").trim().toLowerCase();
  const mode: PaypalMode = modeRaw === "live" || modeRaw === "production" ? "live" : "sandbox";

  return {
    mode,
    clientId,
    clientSecret,
    currency: (env.PAYPAL_CURRENCY ?? "EUR").trim().toUpperCase() || "EUR",
  };
}

export function paypalApiBase(mode: PaypalMode): string {
  return mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

export interface PaypalPublicConfig {
  configured: boolean;
  mode: PaypalMode;
  clientId: string | null;
  currency: string;
  /** Charge for the given diameter (or default sample size). */
  amount: string;
  /** Diameter used to compute `amount`. */
  diameterCm: number;
  pricing: {
    minCm: number;
    maxCm: number;
    minEuro: number;
    maxEuro: number;
  };
}

/** Public fields safe to expose to the browser. */
export function publicPaypalConfig(env: Env, diameterCm?: number): PaypalPublicConfig {
  const cm = Number.isFinite(Number(diameterCm)) ? Number(diameterCm) : 25;
  const amount = globeDownloadPriceEuro(cm);
  const pricing = {
    minCm: GLOBE_PRICE_MIN_CM,
    maxCm: GLOBE_PRICE_MAX_CM,
    minEuro: GLOBE_PRICE_MIN_EUR,
    maxEuro: GLOBE_PRICE_MAX_EUR,
  };
  const cfg = resolvePaypalConfig(env);
  if (!cfg) {
    return {
      configured: false,
      mode: "sandbox",
      clientId: null,
      currency: "EUR",
      amount,
      diameterCm: cm,
      pricing,
    };
  }
  return {
    configured: true,
    mode: cfg.mode,
    clientId: cfg.clientId,
    currency: cfg.currency,
    amount,
    diameterCm: cm,
    pricing,
  };
}
