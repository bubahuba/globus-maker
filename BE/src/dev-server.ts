import { serve } from "@hono/node-server";
import { app } from "./app";
import type { Env } from "./env";

const port = Number(process.env.PORT ?? 8787);

const env: Env = {
  ASSETS: {
    fetch: async () => new Response("Not found", { status: 404 }),
  } as unknown as Fetcher,
  PROCESSOR_URL: process.env.PROCESSOR_URL ?? "http://localhost:8080",
  API_CALLBACK_ORIGIN:
    process.env.API_CALLBACK_ORIGIN ?? "http://host.docker.internal:8787",
  PAYPAL_MODE: process.env.PAYPAL_MODE,
  PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET,
  USER_PAYPAL: process.env.USER_PAYPAL,
  PASS_PAYPAL: process.env.PASS_PAYPAL,
  PAYPAL_CURRENCY: process.env.PAYPAL_CURRENCY,
  PAYPAL_AMOUNT: process.env.PAYPAL_AMOUNT,
};

const executionCtx = {
  waitUntil(promise: Promise<unknown>) {
    promise.catch((error) => {
      console.error("[globus-maker] background job failed:", error);
    });
  },
  passThroughOnException() {},
  props: {},
} as ExecutionContext;

console.log(`API listening on http://localhost:${port}`);
console.log(`Processor URL: ${env.PROCESSOR_URL}`);
console.log(`Processor callback origin: ${env.API_CALLBACK_ORIGIN}`);
console.log(
  `PayPal: ${env.PAYPAL_MODE ?? "sandbox"} / client ${
    env.PAYPAL_CLIENT_ID || env.USER_PAYPAL ? "configured" : "missing"
  }`,
);

serve({
  fetch: (request) => app.fetch(request, env, executionCtx),
  port,
  hostname: process.env.HOST ?? "0.0.0.0",
});
