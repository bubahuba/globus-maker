import { app, isApiRequest } from "./BE/src/app";
import type { Env } from "./BE/src/env";

export type { Env };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (isApiRequest(request)) {
      return app.fetch(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
