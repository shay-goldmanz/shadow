/**
 * Serves the SPA wired to the **real** `@shadow/api` (`bun run serve`).
 *
 * `dev-server.ts` is the fake-client demo — useful for building the interface
 * without a running backend, useless for actually operating Shadow. This is
 * the counterpart: it serves `index.html` (whose `main.tsx` falls through to
 * `HttpApiClient("/api")`) and proxies `/api/*` to the API server.
 *
 * The proxy exists so the SPA and the API share an origin. Without it the
 * browser would need CORS on every endpoint and an absolute API URL baked
 * into the bundle — both avoidable by putting one hop in front.
 *
 * Start `@shadow/api` first, then this. `SHADOW_API` overrides where it
 * points; `PORT` overrides where it listens.
 */

import index from "./index.html";

const port = Number(process.env.PORT ?? 4300);
// "127.0.0.1", not "localhost" — @shadow/api's own server.ts binds explicit
// IPv4 loopback (see that file's doc comment: "localhost" resolved to IPv6
// loopback only on macOS, refusing an IPv4 connection attempt). Matching it
// here means this proxy doesn't depend on hostname-resolution behavior to
// reach the server it's proxying to.
const apiOrigin = process.env.SHADOW_API ?? "http://127.0.0.1:4301";

async function proxyToApi(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, apiOrigin);
  try {
    return await fetch(target, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      // Required by undici/Bun when forwarding a streaming request body.
      // @ts-expect-error -- duplex is not in the DOM RequestInit types yet.
      duplex: "half",
      redirect: "manual",
    });
  } catch (cause) {
    return Response.json(
      {
        error: {
          code: "api_unreachable",
          message: `Could not reach @shadow/api at ${apiOrigin}. Is it running?`,
          details: { cause: String(cause) },
        },
      },
      { status: 502 },
    );
  }
}

const server = Bun.serve({
  port,
  // Bun's default request idle timeout is 10s, which severs a chat SSE stream
  // while Shadow is still thinking. 255 is Bun's maximum; the API's heartbeat
  // is what actually keeps long turns alive, this just stops the proxy hop
  // from being the shorter of the two ceilings.
  idleTimeout: 255,
  // NOT `development: true`. That injects Bun's HMR client, which renders a
  // full-width red "Unhandled Promise Rejection" modal over the interface and
  // — worse — intercepts pointer events, so the operator cannot click through
  // it. This is the entry point the operator actually uses; `dev-server.ts` is
  // where hot reload belongs.
  development: false,
  routes: {
    // `"/api/*"`'s literal prefix beats the trailing wildcard below for any
    // matching request (Bun's router prefers the more specific pattern), so
    // every `/api/...` path proxies through regardless of registration order.
    "/api/*": proxyToApi,
    // Every other path — including a hard refresh on a client-side route —
    // gets the SPA shell back, so routing survives a reload. Hash-based
    // routing (`useHashRoute.ts`) never actually sends a non-`/` pathname to
    // the server today, but the app shouldn't depend on that to avoid a
    // dead-end 404 if that ever changes. Bun bundles `index.html`'s
    // referenced `main.tsx` (and its imports) on the fly (D7); a plain
    // `new Response(index)` cannot do that, so this must stay a `routes`
    // entry, not a hand-built `fetch` fallback response.
    "/*": index,
  },
});

console.log(`Shadow interface at ${server.url} (API: ${apiOrigin})`);
