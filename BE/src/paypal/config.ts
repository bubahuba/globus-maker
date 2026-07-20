import type { Env } from "../env";

export type PaypalMode = "sandbox" | "live";

export interface PaypalRuntimeConfig {
  mode: PaypalMode;
  clientId: string;
  clientSecret: string;
  currency: string;
  /** Decimal string, e.g. "5.00" */
  amount: string;
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function normalizeAmount(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return "5.00";
  return n.toFixed(2);
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
    amount: normalizeAmount(env.PAYPAL_AMOUNT ?? "5"),
  };
}

export function paypalApiBase(mode: PaypalMode): string {
  return mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

/** Public fields safe to expose to the browser. */
export function publicPaypalConfig(env: Env): {
  configured: boolean;
  mode: PaypalMode;
  clientId: string | null;
  currency: string;
  amount: string;
} {
  const cfg = resolvePaypalConfig(env);
  if (!cfg) {
    return {
      configured: false,
      mode: "sandbox",
      clientId: null,
      currency: "EUR",
      amount: "5.00",
    };
  }
  return {
    configured: true,
    mode: cfg.mode,
    clientId: cfg.clientId,
    currency: cfg.currency,
    amount: cfg.amount,
  };
}
