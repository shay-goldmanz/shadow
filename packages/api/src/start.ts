/**
 * `bun run start` — the real entry point. Builds a fully real `ApiDeps`
 * (`composition.ts`) and starts the server bound to `localhost` on a
 * configurable port (`docs/API.md`: "no auth, no multi-user, no remote
 * hosting... the server binds to localhost").
 */

import { buildRealApiDeps } from "./composition.ts";
import { createServer } from "./server.ts";

const port = Number(process.env.PORT ?? 4301);

const deps = buildRealApiDeps({ root: process.env.SHADOW_ROOT });
const server = createServer(deps, { port, hostname: "localhost" });

console.log(`@shadow/api listening at ${server.url.toString()}`);
