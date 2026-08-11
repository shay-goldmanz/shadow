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
  /**
   * @default "127.0.0.1" — explicit IPv4 loopback, not the hostname
   * `"localhost"`. Verified live on macOS: `Bun.serve({ hostname:
   * "localhost" })` binds IPv6 loopback (`[::1]`) only, so a client that
   * resolves `localhost`/connects to `127.0.0.1` directly (many `curl`
   * invocations, some HTTP clients) gets connection-refused even though the
   * server is "up". Binding the literal IPv4 address sidesteps hostname
   * resolution entirely and is reachable via both `127.0.0.1` and
   * `localhost` (which resolves to it first on essentially every system).
   */
  readonly hostname?: string;
}

export function createServer(deps: ApiDeps, options: CreateServerOptions = {}) {
  return Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname ?? "127.0.0.1",
    routes: buildRoutes(deps),
    fetch: notFoundFallback,
  });
}

export type ShadowApiServer = ReturnType<typeof createServer>;
