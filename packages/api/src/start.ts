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
 * Graceful shutdown (T2.9). Once turns can outlive the request that started
 * them (T2.5), the old sequence here — release every live handle, stop the
 * server, exit — would hard-kill an SDK subprocess mid-turn and tear a
 * `store.append` mid-write, turning *every* Ctrl-C during a turn into the
 * crash path. `SessionService.shutdown()` (`session-service.ts`'s own doc)
 * owns the real sequence now: stop accepting new turns (503), signal every
 * running turn to wind down (`iterator.return()`, taking effect at its next
 * yield point), append `turn-boundary(ended, interrupted)` for each,
 * flush appends, and release every handle (T2.4's `release()` — memory
 * hygiene only, not disk cleanup: every SDK transcript is left on disk under
 * `~/.claude/projects/`, on purpose, so it stays resumable the next time the
 * server starts) — bounded by a ~10s deadline so a turn that never reaches a
 * yield point (a wedged subprocess, say) can't hold the process open
 * forever; the torn-tail read tolerance from T2.1 is the backstop for that
 * case, not the norm. `server.stop()` only happens *after* that sequence
 * settles (or times out), so no new HTTP connection can slip in while
 * turns are winding down.
 *
 * `shuttingDownStarted` guards against a second signal (SIGTERM arriving
 * hot on SIGINT's heels, say) re-entering this — `SessionService.shutdown()`
 * itself tolerates being called twice, but there is no reason to double the
 * logging or race two `server.stop()` calls.
 */
let shuttingDownStarted = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDownStarted) return;
  shuttingDownStarted = true;
  console.log(`${signal} received — winding down in-flight turns...`);
  await deps.sessionService.shutdown();
  await server.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
