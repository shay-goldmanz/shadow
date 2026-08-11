/**
 * Tiny, shared HTTP response helpers. No framework — Bun's native
 * `routes` table (`router.ts`) is enough for a surface this size, and
 * pulling in a router library would be exactly the kind of dependency
 * `ARCHITECTURE.md`'s "transport adapter, not a place where behaviour
 * lives" warns against adding weight to.
 */

/**
 * Permissive CORS: `@shadow/web` (T3.5) runs its own dev server on a
 * different port (`packages/web/src/dev-server.ts`), so a browser `fetch`
 * from it to this server is cross-origin. `docs/API.md` is silent on CORS
 * (it predates there being two separate localhost ports), but "no auth, no
 * multi-user... binds to localhost" already establishes there is no
 * origin worth restricting against on a single operator's machine, so
 * `*` costs nothing real here.
 */
const CORS_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "Content-Type",
};

function withCors(headers: Record<string, string> = {}): Record<string, string> {
  return { ...CORS_HEADERS, ...headers };
}

export function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: withCors({ "content-type": "application/json; charset=utf-8" }),
  });
}

export function textResponse(body: string, init: { status?: number } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: withCors({ "content-type": "text/plain; charset=utf-8" }),
  });
}

export function noContentResponse(): Response {
  return new Response(null, { status: 204, headers: withCors() });
}

export function corsPreflightResponse(): Response {
  return new Response(null, { status: 204, headers: withCors() });
}
