/**
 * `createServer` — the only place `Bun.serve` is called. Takes an already-
 * built `ApiDeps` (either `composition.ts`'s real wiring, or a test's
 * fakes) and a port/hostname, and returns the running `Bun.Server`.
 * Binds to `localhost` by default (`docs/API.md`: "no auth, no multi-user,
 * no remote hosting... the server binds to localhost").
 */

import type { ApiDeps } from "./deps.ts";
import { buildRoutes, notFoundFallback } from "./router.ts";

export interface CreateServerOptions {
  /** @default 0 — an OS-assigned ephemeral port, what tests want. */
  readonly port?: number;
  /** @default "localhost" */
  readonly hostname?: string;
}

export function createServer(deps: ApiDeps, options: CreateServerOptions = {}) {
  return Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname ?? "localhost",
    routes: buildRoutes(deps),
    fetch: notFoundFallback,
  });
}

export type ShadowApiServer = ReturnType<typeof createServer>;
