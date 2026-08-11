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
const apiOrigin = process.env.SHADOW_API ?? "http://localhost:4301";

const server = Bun.serve({
  port,
  routes: { "/": index },
  development: true,
  async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      // Unknown non-API path: hand it back to the SPA so client-side routing
      // survives a refresh on a deep link.
      return new Response(null, { status: 404 });
    }

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
  },
});

console.log(`Shadow interface at ${server.url} (API: ${apiOrigin})`);
