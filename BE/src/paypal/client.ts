import { paypalApiBase, resolvePaypalConfig, type PaypalRuntimeConfig } from "./config";
import type { Env } from "../env";

interface TokenCache {
  accessToken: string;
  expiresAt: number;
  mode: string;
  clientId: string;
}

let tokenCache: TokenCache | null = null;

async function getAccessToken(cfg: PaypalRuntimeConfig): Promise<string> {
  const now = Date.now();
  if (
    tokenCache &&
    tokenCache.mode === cfg.mode &&
    tokenCache.clientId === cfg.clientId &&
    tokenCache.expiresAt > now + 60_000
  ) {
    return tokenCache.accessToken;
  }

  const auth = btoa(`${cfg.clientId}:${cfg.clientSecret}`);
  const response = await fetch(`${paypalApiBase(cfg.mode)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`PayPal auth failed (${response.status}): ${text.slice(0, 200)}`);
  }

  const body = (await response.json()) as { access_token: string; expires_in: number };
  tokenCache = {
    accessToken: body.access_token,
    expiresAt: now + body.expires_in * 1000,
    mode: cfg.mode,
    clientId: cfg.clientId,
  };
  return body.access_token;
}

async function paypalFetch(
  cfg: PaypalRuntimeConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getAccessToken(cfg);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", "application/json");
  headers.set("Prefer", "return=representation");
  return fetch(`${paypalApiBase(cfg.mode)}${path}`, { ...init, headers });
}

export async function createGlobeDownloadOrder(
  env: Env,
  jobId: string,
): Promise<{ id: string }> {
  const cfg = resolvePaypalConfig(env);
  if (!cfg) throw new Error("PayPal is not configured");

  const response = await paypalFetch(cfg, "/v2/checkout/orders", {
    method: "POST",
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: jobId,
          custom_id: jobId,
          description: `Globus Maker globe stripes (${jobId})`,
          amount: {
            currency_code: cfg.currency,
            value: cfg.amount,
          },
        },
      ],
      application_context: {
        shipping_preference: "NO_SHIPPING",
        user_action: "PAY_NOW",
        brand_name: "Globus Maker",
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`PayPal create order failed (${response.status}): ${text.slice(0, 300)}`);
  }

  const order = (await response.json()) as { id: string };
  if (!order.id) throw new Error("PayPal create order returned no id");
  return { id: order.id };
}

export interface CaptureResult {
  orderId: string;
  status: string;
  captureId?: string;
  jobId?: string;
}

export async function captureGlobeDownloadOrder(
  env: Env,
  orderId: string,
): Promise<CaptureResult> {
  const cfg = resolvePaypalConfig(env);
  if (!cfg) throw new Error("PayPal is not configured");

  const response = await paypalFetch(cfg, `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: "POST",
    body: "{}",
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`PayPal capture failed (${response.status}): ${text.slice(0, 300)}`);
  }

  const order = (await response.json()) as {
    id: string;
    status: string;
    purchase_units?: Array<{
      custom_id?: string;
      reference_id?: string;
      payments?: {
        captures?: Array<{ id: string; status: string }>;
      };
    }>;
  };

  const unit = order.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  return {
    orderId: order.id,
    status: order.status,
    captureId: capture?.id,
    jobId: unit?.custom_id || unit?.reference_id,
  };
}
