import { Container } from "@cloudflare/containers";
import { app, isApiRequest } from "./BE/src/app";
import type { Env } from "./BE/src/env";

export type { Env };

export class GlobusProcessor extends Container {
  defaultPort = 8080;
  sleepAfter = "30s";
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (isApiRequest(request)) {
      return app.fetch(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
