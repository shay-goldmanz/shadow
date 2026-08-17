/**
 * `GET /api/sessions`, `PATCH /api/sessions/:id`, `DELETE /api/sessions/:id`
 * (T3.1) — handler-level test spine at HTTP level, mirroring
 * `session-events.test.ts`'s conventions: real `fetch()` against a real
 * server, via `test-helpers.ts`'s harness with `sessionStore`/`sessions`
 * exposed for direct assertions.
 *
 * Two harnesses:
 * - `withApi`/`withScriptedApi` (`test-helpers.ts`) — list/patch/delete
 *   happy paths, validation, 404s, cold-session delete, and the F7 tests,
 *   none of which need a turn to be genuinely mid-flight.
 * - `withGatedApi` (local to this file, mirrors `session-events.test.ts`'s
 *   own) — a `ControllableAgenticSessionPort` harness, for the
 *   delete-while-running and delete-while-queued 409 tests, which need a
 *   turn to be observably in flight (or queued behind one) while the
 *   delete request lands.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShadowAgent } from "@shadow/agent";
import { FileSystemVolumeStore, toVolumeSlug } from "@shadow/core";
import { FileSystemEvidenceStore } from "@shadow/evidence";
import { InMemoryMissLog, StructuralIndexer } from "@shadow/indexing";
import type {
  AgenticSession,
  AgenticSessionOptions,
  AgenticSessionPort,
  AgenticStreamEvent,
  AgenticTurnResult,
  FakeAgenticTurnResponder,
} from "@shadow/model";
import { FakeStructuredGenerationPort, ZERO_USAGE } from "@shadow/model";
import { InMemorySessionStore } from "@shadow/sessions/test-helpers";
import type { ApiDeps } from "../deps.ts";
import { createServer } from "../server.ts";
import { SessionService } from "../session-service.ts";
import {
  alwaysNarrativeClassifier,
  readAllSseEvents,
  readSseEventsUntil,
  scriptedClaimRestater,
  scriptedEntailmentJudge,
  seedVolume,
  unusedResearchBriefPort,
  withApi,
  withScriptedApi,
} from "../test-helpers.ts";

function neverRepairClaimRestater() {
  return scriptedClaimRestater(() => {
    throw new Error("no claim should need repair in this harness");
  });
}

/** `enqueueTurn` resolves — and the `session` SSE event is sent — before `ensureConversation` has necessarily gotten around to constructing the underlying `ControllableSession` (a separate microtask, `session-service.ts`'s own doc: "does NOT wait for the turn to run"). Waits for it to exist before a test indexes into `sessions.sessions`. */
async function waitForControllableSession(
  sessions: ControllableAgenticSessionPort,
  index: number,
): Promise<ControllableSession> {
  await waitUntil(() => sessions.sessions.length > index);
  const session = sessions.sessions[index];
  if (!session) throw new Error(`expected a controllable session at index ${index}`);
  return session;
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("waitUntil: timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** Reads `response.body` to natural EOF (the server-side `ReadableStream`'s own `close()`), racing a timeout — proves a stream actually closed rather than merely stopped being read. Used for the "delete closes an open follow stream" test, where the only observable is "the connection eventually ends on its own." */
async function waitForStreamClose(response: Response, timeoutMs = 3000): Promise<void> {
  const body = response.body;
  if (!body) throw new Error("waitForStreamClose: response has no streamed body");
  const reader = body.getReader();
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("waitForStreamClose: timed out waiting for close");
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error("waitForStreamClose: timed out waiting for close")),
            remaining,
          );
        }),
      ]);
      if (result.done) return;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function postChat(baseUrl: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function sessionIdFrom(events: readonly { event: string; data: unknown }[]): string {
  const first = events[0];
  if (!first || first.event !== "session") {
    throw new Error("expected the session SSE event first");
  }
  return (first.data as { sessionId: string }).sessionId;
}

/** Asserts `value` is defined and narrows it — used where a test needs to pass a possibly-`undefined` field (`SessionMeta.sdkSessionId`, etc.) into an assertion that requires a concrete `string`, after already asserting its presence separately. */
function requireDefined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a defined value");
  return value;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

describe("GET /api/sessions", () => {
  test("global list: every session across every volume, newest-first by lastActiveAt", async () => {
    await withApi(async ({ baseUrl, deps, sessionStore }) => {
      const volA = toVolumeSlug("volume-a");
      const volB = toVolumeSlug("volume-b");
      await seedVolume(deps, volA, "Volume A");
      await seedVolume(deps, volB, "Volume B");

      await sessionStore.create({
        id: "older",
        volume: volA,
        title: "Older",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
      });
      await sessionStore.create({
        id: "newer",
        volume: volB,
        title: "Newer",
        createdAt: "2026-01-02T00:00:00.000Z",
        lastActiveAt: "2026-01-03T00:00:00.000Z",
      });
      await sessionStore.create({
        id: "middle",
        volume: volA,
        title: "Middle",
        createdAt: "2026-01-02T00:00:00.000Z",
        lastActiveAt: "2026-01-02T00:00:00.000Z",
      });

      const res = await fetch(`${baseUrl}/api/sessions`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: Array<{ id: string; volume: string }> };
      expect(body.sessions.map((s) => s.id)).toEqual(["newer", "middle", "older"]);
      // Internal SDK-transcript ids never cross the wire.
      expect(JSON.stringify(body.sessions)).not.toContain("sdkSessionId");
      expect(JSON.stringify(body.sessions)).not.toContain("failedSdkSessionIds");
    });
  });

  test("?volume= narrows to one volume, still newest-first", async () => {
    await withApi(async ({ baseUrl, deps, sessionStore }) => {
      const volA = toVolumeSlug("volume-a");
      const volB = toVolumeSlug("volume-b");
      await seedVolume(deps, volA, "Volume A");
      await seedVolume(deps, volB, "Volume B");

      await sessionStore.create({
        id: "in-a-old",
        volume: volA,
        title: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
      });
      await sessionStore.create({
        id: "in-a-new",
        volume: volA,
        title: null,
        createdAt: "2026-01-02T00:00:00.000Z",
        lastActiveAt: "2026-01-02T00:00:00.000Z",
      });
      await sessionStore.create({
        id: "in-b",
        volume: volB,
        title: null,
        createdAt: "2026-01-03T00:00:00.000Z",
        lastActiveAt: "2026-01-03T00:00:00.000Z",
      });

      const res = await fetch(`${baseUrl}/api/sessions?volume=volume-a`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: Array<{ id: string }> };
      expect(body.sessions.map((s) => s.id)).toEqual(["in-a-new", "in-a-old"]);
    });
  });
});

// ---------------------------------------------------------------------------
// Patch
// ---------------------------------------------------------------------------

describe("PATCH /api/sessions/:id", () => {
  test("sets the title, overriding whatever was there (including the first-turn default, T2.5)", async () => {
    const respond: FakeAgenticTurnResponder = () => ({ text: "Sure, let's dig in." });
    await withScriptedApi({ respond }, async ({ baseUrl, deps, sessionStore }) => {
      const volume = toVolumeSlug("design-craft");
      await seedVolume(deps, volume);

      const firstRes = await postChat(baseUrl, {
        volumeSlug: "design-craft",
        message: "Tell me about grid systems please",
      });
      const sessionId = sessionIdFrom(await readAllSseEvents(firstRes));

      // T2.5's default: first line of the operator's message, clipped.
      const beforePatch = await sessionStore.get(sessionId);
      expect(beforePatch?.title).toBe("Tell me about grid systems please");

      const patchRes = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Grid systems research" }),
      });
      expect(patchRes.status).toBe(200);
      const body = (await patchRes.json()) as { session: { id: string; title: string } };
      expect(body.session.id).toBe(sessionId);
      expect(body.session.title).toBe("Grid systems research");

      const afterPatch = await sessionStore.get(sessionId);
      expect(afterPatch?.title).toBe("Grid systems research");
    });
  });

  test("400 invalid_request: title missing, non-string, or empty", async () => {
    await withApi(async ({ baseUrl, deps, sessionStore }) => {
      const volume = toVolumeSlug("design-craft");
      await seedVolume(deps, volume);
      await sessionStore.create({
        id: "sess-1",
        volume,
        title: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
      });

      for (const body of [{}, { title: 42 }, { title: "" }, { title: "   " }]) {
        const res = await fetch(`${baseUrl}/api/sessions/sess-1`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(400);
        const parsed = (await res.json()) as { error: { code: string } };
        expect(parsed.error.code).toBe("invalid_request");
      }
    });
  });

  test("404 session_not_found for an unknown id", async () => {
    await withApi(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/sessions/nonexistent-id`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "New title" }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("session_not_found");
    });
  });
});

// ---------------------------------------------------------------------------
// Delete — happy path, cold sessions, 404, and F7's no-orphan assertion.
// ---------------------------------------------------------------------------

describe("DELETE /api/sessions/:id", () => {
  test("happy path: store directory, registry entry, AND the SDK transcript all go together — no orphan", async () => {
    const respond: FakeAgenticTurnResponder = () => ({ text: "Got it." });
    await withScriptedApi({ respond }, async ({ baseUrl, deps, sessions, sessionStore }) => {
      const volume = toVolumeSlug("design-craft");
      await seedVolume(deps, volume);

      const firstRes = await postChat(baseUrl, { volumeSlug: "design-craft", message: "Hi" });
      const sessionId = sessionIdFrom(await readAllSseEvents(firstRes));

      const meta = await sessionStore.get(sessionId);
      expect(meta?.sdkSessionId).toBeDefined();
      // The turn completed normally — the conversation is a live, registered handle.
      expect(deps.conversations.get(sessionId)).toBeDefined();

      const deleteRes = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: "DELETE" });
      expect(deleteRes.status).toBe(200);
      expect(await deleteRes.json()).toEqual({ deleted: true });

      // Store directory gone.
      expect(await sessionStore.get(sessionId)).toBeUndefined();
      // Registry entry gone.
      expect(deps.conversations.get(sessionId)).toBeUndefined();
      // The no-orphan assertion: `deleteStoredSession` was actually called
      // for this session's SDK transcript at the PORT level (F7's honesty
      // fix — this used to be uncheckable, `docs/DECISIONS.md` D6b).
      expect(sessions.deletedStoredSessionIds).toContain(requireDefined(meta?.sdkSessionId));
    });
  });

  test("cold-session delete: no live registry handle, SDK transcript still deleted by id", async () => {
    const respond: FakeAgenticTurnResponder = () => ({ text: "Got it." });
    await withScriptedApi({ respond }, async ({ baseUrl, deps, sessions, sessionStore }) => {
      const volume = toVolumeSlug("design-craft");
      await seedVolume(deps, volume);

      const firstRes = await postChat(baseUrl, { volumeSlug: "design-craft", message: "Hi" });
      const sessionId = sessionIdFrom(await readAllSseEvents(firstRes));
      const meta = await sessionStore.get(sessionId);
      const sdkSessionId = meta?.sdkSessionId;
      expect(sdkSessionId).toBeDefined();

      // Simulate "cold" — evicted, or never rehydrated since a restart:
      // drop the live handle directly, leaving only the store row behind.
      await deps.conversations.remove(sessionId);
      expect(deps.conversations.get(sessionId)).toBeUndefined();

      const deleteRes = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: "DELETE" });
      expect(deleteRes.status).toBe(200);

      expect(await sessionStore.get(sessionId)).toBeUndefined();
      expect(sessions.deletedStoredSessionIds).toContain(requireDefined(sdkSessionId));
    });
  });

  test("404 session_not_found for an unknown id", async () => {
    await withApi(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/sessions/nonexistent-id`, { method: "DELETE" });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("session_not_found");
    });
  });

  test("F7: a failed first turn's SDK id, AND a later successful turn's (different, post-rehydrate) SDK id, are BOTH deleted", async () => {
    let attempts = 0;
    const respond: FakeAgenticTurnResponder = () => {
      attempts += 1;
      // The first attempt (session A's own turn 0) fails; the second
      // attempt (session B's own turn 0, after the forced cold rehydrate
      // below) succeeds — two DIFFERENT underlying fake session ids, since
      // `FakeAgenticSessionPort` mints one per `createSession()` call.
      if (attempts === 1) return { isError: true, stopReason: "overloaded" };
      return { text: "Recovered." };
    };
    await withScriptedApi({ respond }, async ({ baseUrl, deps, sessions, sessionStore }) => {
      const volume = toVolumeSlug("design-craft");
      await seedVolume(deps, volume);

      const firstRes = await postChat(baseUrl, { volumeSlug: "design-craft", message: "Hi" });
      const sessionId = sessionIdFrom(await readAllSseEvents(firstRes));

      const afterFailedTurn = await sessionStore.get(sessionId);
      expect(afterFailedTurn?.sdkSessionId).toBeUndefined(); // never latched — T1.1
      expect(afterFailedTurn?.failedSdkSessionIds).toHaveLength(1);
      const failedId = requireDefined(afterFailedTurn?.failedSdkSessionIds?.[0]);

      // Force a cold rehydrate: without this, the SAME cached
      // `ShadowConversation`/`FakeAgenticSession` handle would be reused for
      // the next turn, which (per the fake's single-id-per-handle shape)
      // would report the SAME id on success as it did on failure — this
      // step is what makes the two ids genuinely distinct, matching what a
      // real retried `query()` subprocess would do.
      await deps.conversations.remove(sessionId);

      const secondRes = await postChat(baseUrl, { sessionId, message: "Still there?" });
      await readAllSseEvents(secondRes);

      const afterSuccess = await sessionStore.get(sessionId);
      expect(afterSuccess?.sdkSessionId).toBeDefined();
      expect(afterSuccess?.sdkSessionId).not.toBe(failedId);
      // The failed id survives the second (successful) turn's own meta patch.
      expect(afterSuccess?.failedSdkSessionIds).toEqual([failedId]);

      const deleteRes = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: "DELETE" });
      expect(deleteRes.status).toBe(200);

      expect(await sessionStore.get(sessionId)).toBeUndefined();
      expect(sessions.deletedStoredSessionIds).toContain(failedId);
      expect(sessions.deletedStoredSessionIds).toContain(
        requireDefined(afterSuccess?.sdkSessionId),
      );
    });
  });

  test("closes an open ?follow=true stream instead of leaving it inert (T2.7's documented seam, built)", async () => {
    const respond: FakeAgenticTurnResponder = () => ({ text: "Got it." });
    await withScriptedApi({ respond }, async ({ baseUrl, deps }) => {
      const volume = toVolumeSlug("design-craft");
      await seedVolume(deps, volume);

      const firstRes = await postChat(baseUrl, { volumeSlug: "design-craft", message: "Hi" });
      const sessionId = sessionIdFrom(await readAllSseEvents(firstRes));

      const followRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/events?follow=true`);
      expect(followRes.status).toBe(200);

      const deleteRes = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: "DELETE" });
      expect(deleteRes.status).toBe(200);

      // The follow stream must actually close on its own — not hang forever
      // quietly subscribed to a session id the store no longer knows about.
      await waitForStreamClose(followRes);
    });
  });
});

// ---------------------------------------------------------------------------
// Delete — 409 while a turn is running or queued. Needs a genuinely
// in-flight (gated) turn, so this uses its own controllable-session harness.
// ---------------------------------------------------------------------------

/** Mirrors `session-events.test.ts`'s own `ControllableSession`/`ControllableAgenticSessionPort` — `stream()` blocks on a real gate, per turn index, until the test releases it. */
class ControllableSession implements AgenticSession {
  sessionId: string | undefined;
  usage = ZERO_USAGE;
  readonly failedSessionIds: readonly string[] = [];
  readonly prompts: string[] = [];
  private turnIndex = 0;
  private readonly startResolvers: (() => void)[] = [];
  private readonly startPromises: Promise<void>[] = [];
  private readonly gateResolvers: (() => void)[] = [];

  constructor(
    private readonly assignedSessionId: string,
    public readonly options: AgenticSessionOptions,
  ) {}

  async *stream(prompt: string): AsyncGenerator<AgenticStreamEvent, void, undefined> {
    this.prompts.push(prompt);
    const index = this.turnIndex++;
    this.startPromises[index] = new Promise((resolve) => {
      this.startResolvers[index] = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      this.gateResolvers[index] = resolve;
    });
    this.startResolvers[index]?.();
    await gate;

    this.sessionId = this.assignedSessionId;
    const result: AgenticTurnResult = {
      text: `reply-${index}`,
      usage: ZERO_USAGE,
      sessionId: this.assignedSessionId,
      stopReason: "end_turn",
      isError: false,
      subagentsEnabled: false,
    };
    yield { type: "done", result };
  }

  async waitForStart(index: number): Promise<void> {
    while (this.startPromises[index] === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await this.startPromises[index];
  }

  release(index: number): void {
    this.gateResolvers[index]?.();
  }

  async close(): Promise<void> {}
}

class ControllableAgenticSessionPort implements AgenticSessionPort {
  readonly sessions: ControllableSession[] = [];
  readonly deletedStoredSessionIds: string[] = [];
  private counter = 0;

  createSession(options: AgenticSessionOptions = {}): AgenticSession {
    this.counter += 1;
    const session = new ControllableSession(`controllable-session-${this.counter}`, options);
    this.sessions.push(session);
    return session;
  }

  async deleteStoredSession(sdkSessionId: string): Promise<void> {
    this.deletedStoredSessionIds.push(sdkSessionId);
  }
}

interface GatedHarness {
  readonly baseUrl: string;
  readonly sessions: ControllableAgenticSessionPort;
}

async function withGatedApi<T>(fn: (harness: GatedHarness) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "shadow-sessions-delete-gated-"));
  try {
    const volumeStore = new FileSystemVolumeStore(root);
    const evidenceStore = new FileSystemEvidenceStore(volumeStore);
    const indexer = new StructuralIndexer({ rootDir: root });
    const sessions = new ControllableAgenticSessionPort();
    const volume = toVolumeSlug("design-craft");
    await volumeStore.createVolume({ slug: volume, title: "Design Craft" });

    const shadowAgent = new ShadowAgent({
      agenticSessionPort: sessions,
      researchBriefPort: unusedResearchBriefPort,
      volumeStore,
      evidenceStore,
      indexer,
      checkWorthinessClassifier: alwaysNarrativeClassifier,
      entailmentRelevanceJudge: scriptedEntailmentJudge(),
      claimRestater: neverRepairClaimRestater(),
      sessionCwd: root,
    });

    const store = new InMemorySessionStore();
    const sessionService = new SessionService({ store, shadowAgent, agenticSessionPort: sessions });

    const deps: ApiDeps = {
      volumeStore,
      evidenceStore,
      indexer,
      checkWorthinessClassifier: alwaysNarrativeClassifier,
      entailmentRelevanceJudge: scriptedEntailmentJudge(),
      claimRestater: neverRepairClaimRestater(),
      structuredGenerationPort: new FakeStructuredGenerationPort(),
      missLog: new InMemoryMissLog(),
      shadowAgent,
      sessionService,
      conversations: sessionService.registry,
    };

    const server = createServer(deps, { port: 0, hostname: "localhost" });
    try {
      return await fn({ baseUrl: server.url.toString().replace(/\/$/, ""), sessions });
    } finally {
      void server.stop(true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("DELETE /api/sessions/:id — 409 while busy", () => {
  test("409 session_busy while a turn is genuinely running", async () => {
    await withGatedApi(async ({ baseUrl, sessions }) => {
      const firstRes = await postChat(baseUrl, { volumeSlug: "design-craft", message: "op-1" });
      const sessionId = sessionIdFrom(
        await readSseEventsUntil(firstRes, (events) => events.length >= 1),
      );
      const controllable = await waitForControllableSession(sessions, 0);
      await controllable.waitForStart(0); // genuinely running, not just enqueued

      const deleteRes = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: "DELETE" });
      expect(deleteRes.status).toBe(409);
      const body = (await deleteRes.json()) as { error: { code: string } };
      expect(body.error.code).toBe("session_busy");

      controllable.release(0);
      await waitUntil(() => controllable.sessionId !== undefined);
    });
  });

  test("409 session_busy while a second turn is queued behind a running one", async () => {
    await withGatedApi(async ({ baseUrl, sessions }) => {
      const firstRes = await postChat(baseUrl, { volumeSlug: "design-craft", message: "op-1" });
      const sessionId = sessionIdFrom(
        await readSseEventsUntil(firstRes, (events) => events.length >= 1),
      );
      const controllable = await waitForControllableSession(sessions, 0);
      await controllable.waitForStart(0);

      // Queue a second turn behind the still-running first one.
      const secondResPromise = postChat(baseUrl, { sessionId, message: "op-2" });

      const deleteRes = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: "DELETE" });
      expect(deleteRes.status).toBe(409);

      controllable.release(0);
      await controllable.waitForStart(1);
      controllable.release(1);

      const secondRes = await secondResPromise;
      await readAllSseEvents(secondRes);
    });
  });
});
