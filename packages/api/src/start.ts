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
// "127.0.0.1", not "localhost" — see server.ts's CreateServerOptions doc:
// Bun binds "localhost" to IPv6 loopback only on macOS, which refuses an
// IPv4 client. Explicit IPv4 loopback is reachable via both.
const server = createServer(deps, { port, hostname: "127.0.0.1" });

console.log(`@shadow/api listening at ${server.url.toString()}`);

/**
 * Every live conversation holds its `AgenticSession` handle in memory for
 * as long as it's registered (`ConversationRegistry`'s doc). On a normal
 * shutdown (Ctrl-C, or `kill`) there is no later request that will ever
 * evict them, so this is the only chance to drop those in-memory handles
 * before the process exits. This is memory hygiene only, not disk cleanup
 * (T2.4/D6b): `releaseAll()` deletes nothing — every conversation's SDK
 * transcript is left on disk under `~/.claude/projects/`, on purpose, so it
 * stays resumable the next time the server starts. (T2.9 will insert a
 * turn-drain step ahead of this once turns can outlive a request; today,
 * every turn is still request-scoped, so there is nothing in flight to wait
 * for here.)
 */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`${signal} received — releasing ${deps.conversations.size} live conversation(s)...`);
  await deps.conversations.releaseAll();
  await server.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
