/**
 * Serves the SPA wired to `FakeApiClient` (`bun run dev`). `@shadow/api`
 * may not exist yet — this is how the interface is developed and
 * demonstrated against `docs/API.md`'s contract without a running server,
 * per the task's boundaries. No separate build toolchain: Bun bundles
 * `dev.html`'s referenced `main.tsx` (and its imports) on the fly (D7).
 */

import dev from "./dev.html";

const port = Number(process.env.PORT ?? 4300);

const server = Bun.serve({
  port,
  routes: {
    "/": dev,
  },
  development: true,
});

console.log(`Shadow (dev, fake client) running at ${server.url}`);
