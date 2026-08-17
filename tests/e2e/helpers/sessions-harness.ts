/**
 * Sessions e2e harness — real `FileSystemSessionStore` rooted at a temp
 * `SHADOW_HOME`, real `@shadow/api` server wiring (`createServer`,
 * `SessionService`, `ShadowAgent`), fake model ports
 * (`@shadow/model`'s `FakeAgenticSessionPort`) standing in for the Claude
 * Agent SDK subprocess — no network, no live model, exactly this repo's
 * existing e2e conventions (`agent-consumption.e2e.test.ts`'s own doc:
 * "Nothing here imports packages/cli/src/*" for the CLI suite; the sessions
 * analogue here is "nothing here imports a live model port").
 *
 * Deliberately NOT `@shadow/api/test-helpers.ts`'s `withApi`/
 * `withScriptedApi`: those build an `InMemorySessionStore`, which cannot
 * prove persistence survives a process restart, a torn tail on disk, or a
 * directory actually disappearing on `DELETE` — the whole point of this
 * suite (`docs/superpowers/specs/shadow-sessions/PLAN.md`'s verification
 * step). This harness mirrors `@shadow/api`'s own
 * `session-service.shutdown.test.ts` (`withShutdownHarness`) and
 * `composition.ts` (`buildRealApiDeps`) composition, swapping only the
 * store (filesystem, real) and the model port (fake, scripted) — every
 * other collaborator is the same concrete class production wiring uses.
 *
 * Imports reach into each package's `src/` by relative path rather than by
 * package specifier (`@shadow/sessions`, `@shadow/api`, ...): `tests/e2e` is
 * deliberately not a member of the root `workspaces` array (matching how
 * this whole directory has always been kept out of the monorepo's own
 * dependency graph — see `tests/e2e/package.json`), so bare package
 * specifiers don't resolve here. A relative import into a workspace
 * package's own `src/` directory resolves fine even so: module resolution
 * for THAT file's own further imports (e.g. `@shadow/core` from inside
 * `packages/sessions/src/index.ts`) happens relative to its own location,
 * which is still inside the real workspace graph.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShadowAgent } from "../../../packages/agent/src/index.ts";
import type { ApiDeps } from "../../../packages/api/src/deps.ts";
import { createServer, type ShadowApiServer } from "../../../packages/api/src/index.ts";
import { SessionService } from "../../../packages/api/src/session-service.ts";
import {
  alwaysNarrativeClassifier,
  type ParsedSseEvent,
  scriptedClaimRestater,
  scriptedEntailmentJudge,
  unusedResearchBriefPort,
} from "../../../packages/api/src/test-helpers.ts";
import { FileSystemVolumeStore } from "../../../packages/core/src/index.ts";
import { FileSystemEvidenceStore } from "../../../packages/evidence/src/index.ts";
import { InMemoryMissLog, StructuralIndexer } from "../../../packages/indexing/src/index.ts";
import {
  type AgenticSessionPort,
  FakeAgenticSessionPort,
  type FakeAgenticTurnResponder,
  FakeStructuredGenerationPort,
} from "../../../packages/model/src/index.ts";
import { FileSystemSessionStore } from "../../../packages/sessions/src/index.ts";

export {
  type ParsedSseEvent,
  readAllSseEvents,
  readSseEventsUntil,
} from "../../../packages/api/src/test-helpers.ts";
export { toVolumeSlug, type VolumeSlug } from "../../../packages/core/src/index.ts";
export type { AgenticSession, AgenticSessionOptions } from "../../../packages/model/src/index.ts";
export { FakeAgenticSessionPort };

/**
 * Like `readAllSseEvents`, but calls `onEvent` for every event as it
 * arrives, before the stream necessarily finishes — for a test that needs
 * to react to an early event (e.g. `POST /api/chat`'s very first `session`
 * event, sent before any turn content) while a LATER part of that same turn
 * is deliberately held open behind a real gate. Still resolves with the
 * full ordered list once the stream closes, same contract
 * `readAllSseEvents` has; unlike that function this reads incrementally
 * rather than via `response.text()`, so a caller may safely start this
 * without first awaiting the stream's completion (needed to synchronize a
 * second client's subscribe against "the first client has seen event X, but
 * the turn hasn't finished yet" — see `sessions.e2e.test.ts`'s replay+follow
 * and FIFO tests).
 */
export async function streamSseEvents(
  response: Response,
  onEvent: (event: ParsedSseEvent) => void,
): Promise<ParsedSseEvent[]> {
  const body = response.body;
  if (!body) throw new Error("streamSseEvents: response has no streamed body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: ParsedSseEvent[] = [];
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (block.trim().length > 0) {
        let eventName = "message";
        let dataLine: string | undefined;
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) eventName = line.slice("event: ".length);
          else if (line.startsWith("data: ")) dataLine = line.slice("data: ".length);
        }
        if (dataLine !== undefined) {
          const event: ParsedSseEvent = { event: eventName, data: JSON.parse(dataLine) };
          events.push(event);
          onEvent(event);
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  return events;
}

/** One fully-wired `ApiDeps` + the model port backing it (echoed back exactly as passed in, or a fresh `FakeAgenticSessionPort` if none was — see `buildSessionsE2eDeps`). Every call builds fresh instances — nothing here is process-global — which is exactly what a "rebuild after restart" test needs: call this twice with the SAME `root` for two independent `ApiDeps` that only share the filesystem. */
export interface SessionsE2eDeps<P extends AgenticSessionPort = FakeAgenticSessionPort> {
  readonly deps: ApiDeps;
  readonly sessions: P;
  readonly volumeStore: FileSystemVolumeStore;
}

/**
 * Builds one `ApiDeps` rooted at `root`, real `FileSystemSessionStore`
 * included, from a fresh `FakeAgenticSessionPort` (or a caller-supplied
 * `AgenticSessionPort`, for tests that need finer control than the fake's
 * scripted-responder shape gives — e.g. an explicit mid-turn gate). The
 * port passed in (or constructed) is returned as `sessions` — the SAME
 * reference `shadowAgent`/`sessionService` were built with, so a caller can
 * inspect it directly (spy on `deletedStoredSessionIds`, assert on
 * `options.resume`, etc.) without threading a second handle through.
 * Mirrors `composition.ts`'s `buildRealApiDeps` field-for-field except for
 * that one swap.
 */
export function buildSessionsE2eDeps<P extends AgenticSessionPort = FakeAgenticSessionPort>(
  root: string,
  agenticSessionPort?: P,
): SessionsE2eDeps<P> {
  // Only reachable when the caller omits `agenticSessionPort` entirely, in
  // which case `P` defaults to `FakeAgenticSessionPort` (the type param's
  // own default) — the cast is sound at the call site that matters, just
  // not provable to TS across a generic default at runtime.
  const sessions = agenticSessionPort ?? (new FakeAgenticSessionPort() as unknown as P);
  const volumeStore = new FileSystemVolumeStore(root);
  const evidenceStore = new FileSystemEvidenceStore(volumeStore);
  const indexer = new StructuralIndexer({ rootDir: root });

  const shadowAgent = new ShadowAgent({
    agenticSessionPort: sessions,
    researchBriefPort: unusedResearchBriefPort,
    volumeStore,
    evidenceStore,
    indexer,
    checkWorthinessClassifier: alwaysNarrativeClassifier,
    entailmentRelevanceJudge: scriptedEntailmentJudge(),
    claimRestater: scriptedClaimRestater(() => {
      throw new Error("no claim should need repair in this harness");
    }),
    sessionCwd: root,
  });

  const store = new FileSystemSessionStore(root);
  const sessionService = new SessionService({
    store,
    shadowAgent,
    agenticSessionPort: sessions,
  });

  const deps: ApiDeps = {
    volumeStore,
    evidenceStore,
    indexer,
    checkWorthinessClassifier: alwaysNarrativeClassifier,
    entailmentRelevanceJudge: scriptedEntailmentJudge(),
    claimRestater: scriptedClaimRestater(() => {
      throw new Error("no claim should need repair in this harness");
    }),
    structuredGenerationPort: new FakeStructuredGenerationPort(),
    missLog: new InMemoryMissLog(),
    shadowAgent,
    sessionService,
    conversations: sessionService.registry,
  };

  return { deps, sessions, volumeStore };
}

/** A running server + the model port that built it, with its `baseUrl` resolved (an OS-assigned ephemeral port — real HTTP, real loopback socket, no mocked `fetch`). */
export interface RunningSessionsApi<P extends AgenticSessionPort = FakeAgenticSessionPort>
  extends SessionsE2eDeps<P> {
  readonly server: ShadowApiServer;
  readonly baseUrl: string;
}

/** `buildSessionsE2eDeps` + `createServer`, bundled — the common case every test starts from. */
export function startSessionsApi<P extends AgenticSessionPort = FakeAgenticSessionPort>(
  root: string,
  agenticSessionPort?: P,
): RunningSessionsApi<P> {
  const built = buildSessionsE2eDeps(root, agenticSessionPort);
  const server = createServer(built.deps, { port: 0, hostname: "127.0.0.1" });
  return { ...built, server, baseUrl: server.url.toString().replace(/\/$/, "") };
}

/**
 * Tears a running server down the SAME way `start.ts`'s real SIGINT/SIGTERM
 * handler does (`shutdown.ts`'s `shutdownGracefully`, reproduced inline
 * rather than imported since that module also touches `process.exit`, which
 * a test must never call) — `SessionService.shutdown()` first (wind down any
 * in-flight turn, flush its closing boundary, release in-memory handles),
 * THEN `server.stop(true)`. This is the "graceful restart" teardown; the
 * crash-torn-tail test deliberately does NOT use this (see that test's own
 * comment) since it needs to simulate a process that never got to run its
 * shutdown sequence at all.
 */
export async function stopSessionsApiGracefully(
  api: Pick<RunningSessionsApi, "deps" | "server">,
  options: { readonly deadlineMs?: number } = {},
): Promise<void> {
  await api.deps.sessionService.shutdown(options);
  await api.server.stop(true);
}

/** `mkdtemp` + guaranteed `rm -rf` cleanup, scoped to one test — the same shape `agent-consumption.e2e.test.ts`'s `beforeAll`/`afterAll` uses, as a reusable `withX` for tests that don't need a shared root across multiple `test()` blocks. */
export async function withSessionsHome<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "shadow-sessions-e2e-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export type { FakeAgenticTurnResponder };
