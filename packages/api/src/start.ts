/**
 * `bun run start` — the real entry point. Builds a fully real `ApiDeps`
 * (`composition.ts`) and starts the server bound to `localhost` on a
 * configurable port (`docs/API.md`: "no auth, no multi-user, no remote
 * hosting... the server binds to localhost").
 */

import { buildRealApiDeps } from "./composition.ts";
import { createServer } from "./server.ts";

const port = Number(process.env.PORT ?? 4301);

// SHADOW_HOME, not SHADOW_ROOT: `@shadow/cli` already reads SHADOW_HOME, and
// the two must resolve to the same corpus. They agreed only by both defaulting
// to ~/.shadow — any override sent the API and the CLI to different corpora,
// so the operator's volumes were invisible to the agents meant to consume them.
const deps = buildRealApiDeps({ root: process.env.SHADOW_HOME });
const server = createServer(deps, { port, hostname: "localhost" });

console.log(`@shadow/api listening at ${server.url.toString()}`);
