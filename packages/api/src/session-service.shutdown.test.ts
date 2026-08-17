/**
 * `SessionService.shutdown` (T2.9) — the graceful-shutdown test spine
 * PLAN.md's T2.9 entry calls for. No fake-clock pattern exists in this repo
 * (checked: nothing named `FakeClock`/`fake-clock` anywhere under
 * `packages/`), so — per this task's own fallback instruction — every
 * deadline here is a small, real, injected `deadlineMs` rather than a
 * virtual clock, and "genuinely mid-flight" is a controllable gate, mirroring
 * `session-service.test.ts`'s own `ControllableSession` pattern one layer
 * up. `DeltaThenGatedSession` (below) is a small, purpose-built variant of
 * that pattern rather than a reuse of `ControllableSession` itself: it needs
 * a real yield point *before* its gate (a `text-delta`) so a test can prove
 * `shutdown()`'s `iterator.return()` was already queued before the gate
 * resolves — see that class's own doc for why this distinction is what
 * makes test 1 below deterministic rather than racing on microtask timing.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShadowAgent } from "@shadow/agent";
import { FileSystemVolumeStore, toVolumeSlug, type VolumeSlug } from "@shadow/core";
import { FileSystemEvidenceStore } from "@shadow/evidence";
import { StructuralIndexer } from "@shadow/indexing";
import type {
  AgenticSession,
  AgenticSessionOptions,
  AgenticSessionPort,
  AgenticStreamEvent,
  AgenticTurnResult,
} from "@shadow/model";
import { ZERO_USAGE } from "@shadow/model";
import type { SessionStore } from "@shadow/sessions";
import { InMemorySessionStore } from "@shadow/sessions/test-helpers";
import { toErrorResponse } from "./error-mapping.ts";
import { SessionService } from "./session-service.ts";
import {
  alwaysNarrativeClassifier,
  scriptedClaimRestater,
  scriptedEntailmentJudge,
  seedVolume,
  unusedResearchBriefPort,
  withApi,
} from "./test-helpers.ts";

function neverRepairClaimRestater() {
  return scriptedClaimRestater(() => {
    throw new Error("no claim should need repair in this harness");
  });
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil: timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/**
 * `enqueueTurn` resolves as soon as a turn is queued — it does NOT wait for
 * the job to actually start running (`session-service.ts`'s own doc). So the
 * `DeltaThenGatedSession` `ensureConversation` constructs doesn't
 * necessarily exist yet the instant `enqueueTurn`'s promise resolves; every
 * test below waits for it to appear first.
 */
async function waitForSession(
  sessions: SingleSessionAgenticSessionPort,
): Promise<DeltaThenGatedSession> {
  await waitUntil(() => sessions.session !== undefined);
  const session = sessions.session;
  if (!session) throw new Error("expected a session to have been created");
  return session;
}

function operatorTextsOf(records: Awaited<ReturnType<SessionStore["readEvents"]>>): string[] {
  return records
    .filter((r) => r.event.type === "operator-message")
    .map((r) => (r.event as { text: string }).text);
}

/**
 * A single-turn's underlying session: yields ONE `text-delta` immediately,
 * then blocks on a real gate before yielding `done`. The delta-before-gate
 * shape is deliberate: it gives the turn a genuine yield point the driving
 * `for await` loop already consumed *before* the gate is ever reached, so
 * that by the time a test calls `waitForGated()` and then `shutdown()`, the
 * only thing still in flight is the internal `await gate` — exactly the
 * "executing, blocked on an internal await" state native async-generator
 * `.return()` semantics queue behind (see `session-service.ts`'s `shutdown`
 * doc). Calling `shutdown()` BEFORE releasing the gate, then releasing the
 * gate, proves the interruption request was already queued: the turn stops
 * once that internal step resolves rather than continuing on to a further
 * round, deterministically — not a race against how fast the test happens
 * to run.
 */
class DeltaThenGatedSession implements AgenticSession {
  sessionId: string | undefined;
  usage = ZERO_USAGE;
  readonly failedSessionIds: readonly string[] = [];
  readonly prompts: string[] = [];
  private gateResolve: (() => void) | undefined;
  private gatedResolve: (() => void) | undefined;
  private readonly gated: Promise<void>;

  constructor(
    private readonly assignedSessionId: string,
    public readonly options: AgenticSessionOptions,
  ) {
    this.gated = new Promise((resolve) => {
      this.gatedResolve = resolve;
    });
  }

  async *stream(prompt: string): AsyncGenerator<AgenticStreamEvent, void, undefined> {
    this.prompts.push(prompt);
    yield { type: "text-delta", text: "chunk-1 " };

    const gate = new Promise<void>((resolve) => {
      this.gateResolve = resolve;
    });
    this.gatedResolve?.();
    await gate; // held open until the test releases it (or never, for the deadline test)

    this.sessionId = this.assignedSessionId;
    const result: AgenticTurnResult = {
      text: "reply after gate",
      usage: ZERO_USAGE,
      sessionId: this.assignedSessionId,
      stopReason: "end_turn",
      isError: false,
      subagentsEnabled: false,
    };
    yield { type: "done", result };
  }

  /** Resolves once `stream()` has genuinely reached its own gate (past the first delta, blocked internally) — proof of "in flight," not "about to be." */
  async waitForGated(): Promise<void> {
    await this.gated;
  }

  release(): void {
    this.gateResolve?.();
  }

  async close(): Promise<void> {}
}

class SingleSessionAgenticSessionPort implements AgenticSessionPort {
  session: DeltaThenGatedSession | undefined;
  private counter = 0;

  createSession(options: AgenticSessionOptions = {}): AgenticSession {
    this.counter += 1;
    const session = new DeltaThenGatedSession(`shutdown-test-session-${this.counter}`, options);
    this.session = session;
    return session;
  }

  async deleteStoredSession(): Promise<void> {}
}

interface ShutdownHarness {
  readonly service: SessionService;
  readonly store: SessionStore;
  readonly sessions: SingleSessionAgenticSessionPort;
  readonly volume: VolumeSlug;
}

async function withShutdownHarness<T>(fn: (harness: ShutdownHarness) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "shadow-session-service-shutdown-"));
  try {
    const volumeStore = new FileSystemVolumeStore(root);
    const evidenceStore = new FileSystemEvidenceStore(volumeStore);
    const indexer = new StructuralIndexer({ rootDir: root });
    const sessions = new SingleSessionAgenticSessionPort();
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
    const service = new SessionService({ store, shadowAgent, agenticSessionPort: sessions });

    return await fn({ service, store, sessions, volume });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. Shutdown during a running turn.
// ---------------------------------------------------------------------------

describe("SessionService.shutdown — running turn", () => {
  test("winds the turn down at its next yield point, appends turn-boundary(ended, interrupted), and resolves within the deadline", async () => {
    await withShutdownHarness(async ({ service, store, sessions, volume }) => {
      const enqueued = await service.enqueueTurn({ volume }, "op-1");
      const session = await waitForSession(sessions);
      await session.waitForGated(); // genuinely mid-flight, past the first delta

      const deadlineMs = 2000;
      const shutdownPromise = service.shutdown({ deadlineMs });
      // `.return()` is already queued on the turn's iterator by this point
      // (`shutdown()`'s synchronous sweep, before its first `await`) —
      // releasing the gate now lets that queued request take effect at the
      // next reachable suspend point, rather than the turn continuing.
      session.release();

      const start = Date.now();
      await shutdownPromise;
      const elapsed = Date.now() - start;
      // Resolved because the turn actually wound down, not because the
      // deadline fired — well under it.
      expect(elapsed).toBeLessThan(deadlineMs / 2);

      const records = await store.readEvents(enqueued.sessionId);
      const ended = records.at(-1);
      expect(ended?.event).toMatchObject({
        type: "turn-boundary",
        phase: "ended",
        endReason: "interrupted",
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 2. New enqueue during shutdown -> typed 503 (handler-level).
// ---------------------------------------------------------------------------

describe("SessionService.shutdown — new enqueues rejected (handler-level)", () => {
  test("POST /api/chat after shutdown() has begun is 503 shutting_down", async () => {
    await withApi(async ({ baseUrl, deps }) => {
      const volume = toVolumeSlug("design-craft");
      await seedVolume(deps, volume);

      await deps.sessionService.shutdown();

      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ volumeSlug: "design-craft", message: "hi" }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("shutting_down");
    });
  });

  test("the underlying error maps to 503/shutting_down via error-mapping.ts directly", async () => {
    await withShutdownHarness(async ({ service, volume }) => {
      await service.shutdown();
      try {
        await service.enqueueTurn({ volume }, "too late");
        throw new Error("expected enqueueTurn to reject after shutdown()");
      } catch (error) {
        const mapped = toErrorResponse(error);
        expect(mapped.status).toBe(503);
        expect(mapped.body.error.code).toBe("shutting_down");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Queued-but-not-started turn at shutdown: dropped cleanly.
// ---------------------------------------------------------------------------

describe("SessionService.shutdown — queued turn", () => {
  test("a turn still queued when shutdown begins is dropped cleanly — no operator-message, no boundary", async () => {
    await withShutdownHarness(async ({ service, store, sessions, volume }) => {
      const first = await service.enqueueTurn({ volume }, "op-1 (running)");
      const sessionId = first.sessionId;
      const session = await waitForSession(sessions);
      await session.waitForGated();

      // Queued behind the still-running first turn, before shutdown begins.
      const second = await service.enqueueTurn({ sessionId }, "op-2 (never runs)");
      void second; // never drained — dropped before it ever produces anything worth draining

      const shutdownPromise = service.shutdown({ deadlineMs: 2000 });
      // Let the first turn settle (interrupted) so the session's FIFO lock
      // advances to the second, still-queued turn — proving it is `runTurn`
      // itself dropping the turn (its own `shuttingDown` check), not just
      // "never got a chance to run."
      session.release();
      await shutdownPromise;

      const records = await store.readEvents(sessionId);
      expect(operatorTextsOf(records)).toEqual(["op-1 (running)"]);
      expect(JSON.stringify(records)).not.toContain("op-2 (never runs)");
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Shutdown with no activity.
// ---------------------------------------------------------------------------

describe("SessionService.shutdown — no activity", () => {
  test("resolves promptly with nothing to wind down and no records written", async () => {
    await withShutdownHarness(async ({ service, sessions }) => {
      const start = Date.now();
      await service.shutdown({ deadlineMs: 2000 });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(200);
      expect(sessions.session).toBeUndefined(); // nothing was ever created
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Deadline exceeded: a turn that refuses to wind down is abandoned.
// ---------------------------------------------------------------------------

describe("SessionService.shutdown — deadline exceeded", () => {
  test("a turn stuck on an internal await that never resolves is abandoned at the deadline — shutdown still resolves", async () => {
    await withShutdownHarness(async ({ service, store, sessions, volume }) => {
      const enqueued = await service.enqueueTurn({ volume }, "op-1 (gate never released)");
      const session = await waitForSession(sessions);
      await session.waitForGated();

      const deadlineMs = 100;
      const start = Date.now();
      await service.shutdown({ deadlineMs }); // the gate is never released
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(deadlineMs);
      // Generous upper bound — proves shutdown() didn't just hang forever.
      expect(elapsed).toBeLessThan(deadlineMs + 2000);

      // Abandoned, not falsely marked complete: the torn-tail read
      // tolerance (T2.1) is the documented backstop for exactly this case,
      // not something this method papers over with a fabricated boundary.
      const records = await store.readEvents(enqueued.sessionId);
      const hasEndedBoundary = records.some(
        (r) => r.event.type === "turn-boundary" && (r.event as { phase: string }).phase === "ended",
      );
      expect(hasEndedBoundary).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// 6. F8 review fix: a {volume} enqueue racing shutdown() creates no phantom
//    session row.
// ---------------------------------------------------------------------------

describe("SessionService.shutdown — F8: no phantom session row", () => {
  test("a fresh {volume} enqueue that loses the race against shutdown() persists no row at all", async () => {
    await withShutdownHarness(async ({ service, store, volume }) => {
      // Neither call is awaited before the other starts — `enqueueTurn`
      // resolves `resolveSessionId` synchronously for a `{volume}` target
      // now (F8's own fix: it only mints an id, no `await this.store.create`
      // any more) and then suspends at its own first genuine `await`
      // (`lock.tryReserve` is synchronous, but `runReserved`'s internal
      // `await previous` is not) — so `shutdown()`, called immediately
      // after on the very next line, sets `shuttingDown = true`
      // SYNCHRONOUSLY, strictly before `runTurn` ever gets a chance to run
      // (queued behind at least one more microtask tick via
      // `SessionLock.runReserved`). By the time `runTurn` does execute, its
      // own top-of-method check sees the flag already set and returns
      // before ever reaching the `store.create` call this fix moved inside
      // that same guard.
      const enqueuedPromise = service.enqueueTurn({ volume }, "racing shutdown");
      const shutdownPromise = service.shutdown({ deadlineMs: 500 });

      const enqueued = await enqueuedPromise;
      await shutdownPromise;

      // A short real-time settle, defensive against any remaining
      // scheduling slack — `runTurn`'s early return has no async work of
      // its own, so this is generous, not load-bearing for the ordering
      // argument above.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const meta = await store.get(enqueued.sessionId);
      expect(meta).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// 7. F9 remainder: double/concurrent shutdown() is idempotent.
// ---------------------------------------------------------------------------

describe("SessionService.shutdown — F9: double/concurrent shutdown is idempotent", () => {
  test("two concurrent shutdown() calls during a running turn both resolve, and the turn is only ever marked interrupted once", async () => {
    await withShutdownHarness(async ({ service, store, sessions, volume }) => {
      const enqueued = await service.enqueueTurn({ volume }, "op-1");
      const session = await waitForSession(sessions);
      await session.waitForGated(); // genuinely mid-flight, past the first delta

      const deadlineMs = 2000;
      // Two overlapping calls — the second stands in for a SIGTERM arriving
      // hot on a SIGINT's heels, the exact scenario `start.ts`'s own
      // `shuttingDownStarted` guard exists for one layer up; this proves
      // `SessionService.shutdown` itself tolerates it too, independent of
      // that guard.
      const firstShutdown = service.shutdown({ deadlineMs });
      const secondShutdown = service.shutdown({ deadlineMs });
      session.release();

      // Plain await + assert, not `expect(promise).resolves...` — that
      // matcher is typed `void` despite needing an await, which trips
      // oxlint's type-aware `await-thenable` rule (`contract.test.ts`'s own
      // comment documents the same workaround for `.rejects`).
      const results = await Promise.all([firstShutdown, secondShutdown]);
      expect(results).toEqual([undefined, undefined]);

      // Exactly one closing boundary for the turn — a second `shutdown()`
      // call never double-signals the same iterator into a second
      // `turn-boundary(ended, ...)`.
      const records = await store.readEvents(enqueued.sessionId);
      const endedBoundaries = records.filter(
        (r) => r.event.type === "turn-boundary" && (r.event as { phase: string }).phase === "ended",
      );
      expect(endedBoundaries).toHaveLength(1);
      expect(endedBoundaries[0]?.event).toMatchObject({ endReason: "interrupted" });
    });
  });

  test("shutdown() on an already-shut-down service (no activity at all) resolves both times", async () => {
    await withShutdownHarness(async ({ service }) => {
      await service.shutdown({ deadlineMs: 500 });
      // A second call after the first has already fully settled — the
      // simplest possible double-call shape.
      const result = await service.shutdown({ deadlineMs: 500 });
      expect(result).toBeUndefined();
    });
  });
});
