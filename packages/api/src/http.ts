/**
 * Tiny, shared HTTP response helpers. No framework — Bun's native
 * `routes` table (`router.ts`) is enough for a surface this size, and
 * pulling in a router library would be exactly the kind of dependency
 * `ARCHITECTURE.md`'s "transport adapter, not a place where behaviour
 * lives" warns against adding weight to.
 */

/**
 * No CORS. `packages/web/src/serve.ts` proxies `/api/*` to this server so
 * the browser and the API share an origin — that proxy is what removes the
 * need for CORS, per its own doc comment, not a wildcard header here. A
 * wildcard `access-control-allow-origin: *` would instead let *any* site the
 * operator's browser visits read their volumes via a cross-origin `fetch`
 * straight to this server (it binds to loopback but has no auth, D5) —
 * unnecessary exposure the proxy already makes redundant. `OPTIONS` still
 * gets a plain no-content response (harmless, no permission granted); an
 * actual cross-origin request without the proxy in front is left to the
 * browser's default same-origin policy to block.
 */

/**
 * Every JSON/text response is `no-store`: `@shadow/web`'s state (the volume
 * list in particular) must reflect what the filesystem actually holds, not
 * a browser heuristic cache — Chromium will otherwise serve a stale 200
 * from disk cache with no request even hitting the network when this
 * server is down, since the API sent no cache-control/ETag validator at
 * all.
 */
function withNoStore(headers: Record<string, string> = {}): Record<string, string> {
  return { "cache-control": "no-store", ...headers };
}

export function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: withNoStore({ "content-type": "application/json; charset=utf-8" }),
  });
}

export function textResponse(body: string, init: { status?: number } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: withNoStore({ "content-type": "text/plain; charset=utf-8" }),
  });
}

export function noContentResponse(): Response {
  return new Response(null, { status: 204, headers: withNoStore() });
}

export function corsPreflightResponse(): Response {
  return new Response(null, { status: 204 });
}
