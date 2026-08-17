/**
 * `SessionService` (T2.5) — the service-level test spine PLAN.md's T2.5
 * entry calls for. Two harnesses:
 *
 * - `withSessionService` — `FakeAgenticSessionPort` (auto-completing,
 *   scriptable text), for anything that doesn't need genuine mid-turn
 *   pausing: the tee contract, single-flight rehydration (structural, not
 *   timing-dependent — see that test's own doc), the fallback summary, meta
 *   bookkeeping, and 404 semantics.
 * - `withGatedSessionService` — a hand-rolled `ControllableAgenticSessionPort`
 *   (mirrors `handlers/research-concurrency.test.ts`'s
 *   `ControllableResearchSessionPort` one layer up) whose `stream()` blocks
 *   on a real gate until the test releases it, for anything that needs a
 *   turn to be genuinely, observably mid-flight: FIFO ordering + the queue
 *   bound, viewer detach, eviction re-run on settle, and crash-while-queued.
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
  FakeAgenticTurnResponder,
} from "@shadow/model";
import {
  FakeAgenticSessionPort,
  failNTimesThenSucceed,
  noConversationFoundError,
  ZERO_USAGE,
} from "@shadow/model";
import type { SessionStore, StoredEventRecord } from "@shadow/sessions";
import { expectRejection, InMemorySessionStore } from "@shadow/sessions/test-helpers";
import { SessionNotFoundError, TurnQueueBusyError } from "./errors.ts";
import type { SessionBusMessage } from "./session-bus.ts";
import {
  DEFAULT_MAX_QUEUED_TURNS_PER_SESSION,
  FALLBACK_SUMMARY_HEADER,
  SessionService,
} from "./session-service.ts";
import {
  alwaysNarrativeClassifier,
  scriptedClaimRestater,
  scriptedEntailmentJudge,
  unusedResearchBriefPort,
} from "./test-helpers.ts";

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

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
 * the job to actually start running (`session-service.ts`'s own doc: "does
 * NOT wait for the turn to run"). So the underlying `ControllableSession`
 * `ensureConversation` constructs doesn't necessarily exist yet the instant
 * `enqueueTurn`'s promise resolves; every gated test that inspects
 * `sessions.sessions[n]` waits for it to appear first.
 */
async function waitForControllableSession(
  sessions: ControllableAgenticSessionPort,
  index: number,
): Promise<ControllableSession> {
  await waitUntil(() => sessions.sessions.length > index);
  const session = sessions.sessions[index];
  if (!session) throw new Error(`expected a controllable session at index ${index}`);
  return session;
}

/** Drains a turn's `events` generator to completion (its own `turn-boundary(ended)`), discarding the messages — for tests that only care about the store's side of things afterward. */
async function drainToEnd(
  events: AsyncGenerator<SessionBusMessage, void, undefined>,
): Promise<void> {
  for await (const _message of events) {
    // side effect only: let the turn's bus messages flow through so the
    // generator reaches its own natural end.
  }
}

interface SimpleHarness {
  readonly service: SessionService;
  readonly store: SessionStore;
  readonly sessions: FakeAgenticSessionPort;
  readonly volume: VolumeSlug;
}

/** `FakeAgenticSessionPort`-backed harness — turns complete as soon as they're driven, no artificial gating. */
async function withSessionService<T>(
  respond: FakeAgenticTurnResponder | undefined,
  fn: (harness: SimpleHarness) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "shadow-session-service-"));
  try {
    const volumeStore = new FileSystemVolumeStore(root);
    const evidenceStore = new FileSystemEvidenceStore(volumeStore);
    const indexer = new StructuralIndexer({ rootDir: root });
    const sessions = new FakeAgenticSessionPort(respond);
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
    const service = new SessionService({ store, shadowAgent });

    return await fn({ service, store, sessions, volume });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** One gated turn's controllable underlying session — mirrors `handlers/research-concurrency.test.ts`'s `ControllableResearchSessionPort` one layer up (a fresh gate per `stream()` call, so one session can be gated across several sequential turns). */
class ControllableSession implements AgenticSession {
  sessionId: string | undefined;
  usage = ZERO_USAGE;
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
    await gate; // held open until the test releases this exact turn index

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

  /** Resolves once this session's `index`-th `stream()` call has genuinely started (proof of "in flight," not "about to be"). */
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
  private counter = 0;

  createSession(options: AgenticSessionOptions = {}): AgenticSession {
    this.counter += 1;
    const session = new ControllableSession(`controllable-session-${this.counter}`, options);
    this.sessions.push(session);
    return session;
  }

  async deleteStoredSession(): Promise<void> {}
}

interface GatedHarness {
  readonly service: SessionService;
  readonly store: SessionStore;
  readonly sessions: ControllableAgenticSessionPort;
  readonly volume: VolumeSlug;
}

/** `ControllableAgenticSessionPort`-backed harness — every turn blocks in `stream()` until the test releases its gate. `registryMaxSize`, when given, is forwarded to `SessionService` (the eviction test needs a small cap). */
async function withGatedSessionService<T>(
  fn: (harness: GatedHarness) => Promise<T>,
  options: { readonly registryMaxSize?: number } = {},
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "shadow-session-service-gated-"));
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
    const service = new SessionService(
      { store, shadowAgent },
      { registryMaxSize: options.registryMaxSize },
    );

    return await fn({ service, store, sessions, volume });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function operatorRecords(records: readonly StoredEventRecord[]): StoredEventRecord[] {
  return records.filter((r) => r.event.type === "operator-message");
}

// ---------------------------------------------------------------------------
// 1. Tee: store receives everything but text-deltas, plus operator/boundary
//    records, in the running turn's seq range only.
// ---------------------------------------------------------------------------

describe("SessionService — tee (store contract)", () => {
  test("appends operator-message, turn-boundary(started), every non-delta agent event, and turn-boundary(ended, completed) — deltas never appear", async () => {
    const respond: FakeAgenticTurnResponder = () => ({
      text: "Full reply text.",
      events: [
        { type: "text-delta", text: "Full " },
        { type: "text-delta", text: "reply text." },
      ],
    });

    await withSessionService(respond, async ({ service, store, volume }) => {
      const enqueued = await service.enqueueTurn({ volume }, "Hello Shadow");
      await drainToEnd(enqueued.events);

      const records = await store.readEvents(enqueued.sessionId);
      const types = records.map((r) => r.event.type);
      // `operator-turn-recorded` is an ordinary `ShadowEvent` (the evidence-
      // ledger bookkeeping `@shadow/agent` emits before the model turn even
      // starts) — tee'd like any other non-delta event, per this module's
      // doc: the tee is generic over "every stored-shape event," not an
      // allowlist of the ones this test happens to care about.
      expect(types).toEqual([
        "operator-message",
        "turn-boundary",
        "operator-turn-recorded",
        "assistant-message",
        "turn-boundary",
      ]);

      // No text-delta shape ever reaches the store — it has none.
      expect(JSON.stringify(records)).not.toContain("text-delta");

      const operator = records[0];
      expect(operator?.event).toMatchObject({ type: "operator-message", text: "Hello Shadow" });

      const started = records[1];
      expect(started?.event).toMatchObject({ type: "turn-boundary", phase: "started" });

      const assistant = records[3];
      expect(assistant?.event).toMatchObject({
        type: "assistant-message",
        text: "Full reply text.",
      });

      const ended = records[4];
      expect(ended?.event).toMatchObject({
        type: "turn-boundary",
        phase: "ended",
        endReason: "completed",
      });

      // Every record belongs to this one turn, seq strictly increasing from 1.
      for (const r of records) expect(r.turnId).toBe(enqueued.turnId);
      expect(records.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. FIFO ordering + the queue bound.
// ---------------------------------------------------------------------------

describe("SessionService — FIFO queue + bound", () => {
  test("two queued turns on one session run strictly in order; a 5th queued turn is rejected once 4 are already pending", async () => {
    await withGatedSessionService(async ({ service, store, sessions, volume }) => {
      const first = await service.enqueueTurn({ volume }, "op-1");
      const sessionId = first.sessionId;
      const controllable = await waitForControllableSession(sessions, 0);
      await controllable.waitForStart(0); // turn 1 genuinely running

      // Queue turns 2..5 behind it — exactly the bound (4 pending).
      const second = await service.enqueueTurn({ sessionId }, "op-2");
      const third = await service.enqueueTurn({ sessionId }, "op-3");
      const fourth = await service.enqueueTurn({ sessionId }, "op-4");
      const fifth = await service.enqueueTurn({ sessionId }, "op-5");

      // A 6th would be the 5th *pending* turn — over the bound.
      await expectRejection(service.enqueueTurn({ sessionId }, "op-6"), TurnQueueBusyError);
      expect(DEFAULT_MAX_QUEUED_TURNS_PER_SESSION).toBe(4);

      // Only ONE underlying AgenticSession exists throughout — every queued
      // turn reuses the same conversation/session handle (D6 reuse).
      expect(sessions.sessions).toHaveLength(1);

      // Release turns in order, waiting for each to genuinely start before
      // releasing the next — proves strict FIFO, not just eventual
      // completion in some order.
      controllable.release(0);
      await controllable.waitForStart(1);
      controllable.release(1);
      await controllable.waitForStart(2);
      controllable.release(2);
      await controllable.waitForStart(3);
      controllable.release(3);
      await controllable.waitForStart(4);
      controllable.release(4);

      await Promise.all([first, second, third, fourth, fifth].map((t) => drainToEnd(t.events)));

      expect(controllable.prompts.map((p) => p.includes("op-1"))[0]).toBe(true);
      // FIFO order, verified via the stored operator-message texts in seq order.
      const records = await store.readEvents(sessionId);
      const operatorTexts = operatorRecords(records).map((r) => (r.event as { text: string }).text);
      expect(operatorTexts).toEqual(["op-1", "op-2", "op-3", "op-4", "op-5"]);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Viewer-detach mid-turn.
// ---------------------------------------------------------------------------

describe("SessionService — viewer detach mid-turn", () => {
  test("cancelling the first viewer's iteration does not stop the turn; the store ends up whole", async () => {
    await withGatedSessionService(async ({ service, store, sessions, volume }) => {
      const enqueued = await service.enqueueTurn({ volume }, "Detach me");
      const controllable = await waitForControllableSession(sessions, 0);
      await controllable.waitForStart(0);

      // The viewer sees the operator + started records, then detaches —
      // exactly like an SSE response's `cancel()`.
      const iterator = enqueued.events;
      const firstMsg = await iterator.next();
      expect(firstMsg.done).toBe(false);
      await iterator.return(undefined);

      // The turn is still gated — nobody has released it — proving the
      // detach above did not touch the turn itself.
      controllable.release(0);

      // Poll the store until the turn's own boundary shows up (no viewer is
      // watching anymore — this is exactly the point).
      await waitUntil(async () => {
        const records = await store.readEvents(enqueued.sessionId);
        return records.some(
          (r) =>
            r.event.type === "turn-boundary" && (r.event as { phase: string }).phase === "ended",
        );
      });

      const records = await store.readEvents(enqueued.sessionId);
      const types = records.map((r) => r.event.type);
      // `operator-turn-recorded` — see test 1's doc for why it's here too.
      expect(types).toEqual([
        "operator-message",
        "turn-boundary",
        "operator-turn-recorded",
        "assistant-message",
        "turn-boundary",
      ]);
      const ended = records.at(-1);
      expect(ended?.event).toMatchObject({
        type: "turn-boundary",
        phase: "ended",
        endReason: "completed",
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Single-flight rehydrate.
// ---------------------------------------------------------------------------

describe("SessionService — single-flight rehydrate", () => {
  test("two concurrent enqueues on a cold session construct exactly ONE conversation, and both turns run FIFO", async () => {
    const respond: FakeAgenticTurnResponder = () => ({ text: "ok" });

    await withSessionService(respond, async ({ service, store, sessions, volume }) => {
      const sessionId = "cold-session-1";
      const now = new Date().toISOString();
      // A session the STORE knows about but the registry never has — the
      // cold-restart / post-eviction shape, seeded directly rather than via
      // `enqueueTurn` so nothing has touched the registry yet.
      await store.create({
        id: sessionId,
        volume,
        title: null,
        createdAt: now,
        lastActiveAt: now,
        sdkSessionId: "already-alive-sdk-session",
      });

      const [first, second] = await Promise.all([
        service.enqueueTurn({ sessionId }, "concurrent-1"),
        service.enqueueTurn({ sessionId }, "concurrent-2"),
      ]);

      await Promise.all([drainToEnd(first.events), drainToEnd(second.events)]);

      // ONE construction — not two racing rehydrations.
      expect(sessions.sessions).toHaveLength(1);
      expect(sessions.sessions[0]?.prompts).toHaveLength(2);

      // Both turns ran, strictly FIFO by enqueue order.
      const records = await store.readEvents(sessionId);
      const operatorTexts = operatorRecords(records).map((r) => (r.event as { text: string }).text);
      expect(operatorTexts).toEqual(["concurrent-1", "concurrent-2"]);
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Fallback plumbing.
// ---------------------------------------------------------------------------

describe("SessionService — resume fallback plumbing", () => {
  test("a resumed first turn's no-conversation-found error rebuilds with a deterministic summary (last 12, 500-char clip, fixed header) and overwrites sdkSessionId", async () => {
    const respond = failNTimesThenSucceed(1, noConversationFoundError("dead-sdk-id"), {
      text: "recovered",
    });

    await withSessionService(respond, async ({ service, store, sessions, volume }) => {
      const sessionId = "cold-session-fallback";
      const now = new Date().toISOString();
      await store.create({
        id: sessionId,
        volume,
        title: null,
        createdAt: now,
        lastActiveAt: now,
        sdkSessionId: "dead-sdk-id",
      });

      // Seed 15 alternating operator/assistant messages directly (bypassing
      // SessionService — this is prior transcript, not this test's own
      // turn), plus one long one to exercise the 500-char clip.
      const longText = "L".repeat(600);
      const seeded = Array.from({ length: 14 }, (_, i) => ({
        turnId: "seed-turn",
        at: now,
        event:
          i % 2 === 0
            ? { type: "operator-message" as const, text: `MSG-${i + 1}` }
            : { type: "assistant-message" as const, text: `MSG-${i + 1}` },
      }));
      seeded.push({
        turnId: "seed-turn",
        at: now,
        event: { type: "operator-message" as const, text: longText },
      });
      await store.append(sessionId, seeded);

      const enqueued = await service.enqueueTurn({ sessionId }, "new message");
      await drainToEnd(enqueued.events);

      // A doomed resumed session, then a fresh one without resume.
      expect(sessions.sessions).toHaveLength(2);
      expect(sessions.sessions[0]?.options.resume).toEqual({ sessionId: "dead-sdk-id" });
      expect(sessions.sessions[1]?.options.resume).toBeUndefined();

      const fallbackPrompt = sessions.sessions[1]?.prompts[0] ?? "";
      expect(fallbackPrompt).toContain(FALLBACK_SUMMARY_HEADER);
      // Last 12 of the 15 seeded messages survive — MSG-1..MSG-3 are dropped.
      expect(fallbackPrompt).not.toContain("MSG-1\n");
      expect(fallbackPrompt).not.toContain("MSG-2\n");
      expect(fallbackPrompt).not.toContain("MSG-3\n");
      expect(fallbackPrompt).toContain("MSG-4");
      expect(fallbackPrompt).toContain("MSG-14");
      // Each message clipped to 500 chars, with an ellipsis marker.
      expect(fallbackPrompt).not.toContain(longText);
      expect(fallbackPrompt).toContain(`${"L".repeat(500)}…`);

      // sdkSessionId overwritten with the NEW (rebuilt) session's id, not
      // the dead one it started from.
      const meta = await store.get(sessionId);
      expect(meta?.sdkSessionId).toBe(sessions.sessions[1]?.sessionId);
      expect(meta?.sdkSessionId).not.toBe("dead-sdk-id");
    });
  });
});

// ---------------------------------------------------------------------------
// 6. session_not_found only when absent from BOTH registry and store.
// ---------------------------------------------------------------------------

describe("SessionService — session_not_found", () => {
  test("an unknown sessionId (absent from both registry and store) is rejected", async () => {
    const respond: FakeAgenticTurnResponder = () => ({ text: "ok" });
    await withSessionService(respond, async ({ service }) => {
      await expectRejection(
        service.enqueueTurn({ sessionId: "never-existed" }, "hi"),
        SessionNotFoundError,
      );
    });
  });

  test("a sessionId present only in the store (registry miss) is accepted, not 404'd", async () => {
    const respond: FakeAgenticTurnResponder = () => ({ text: "ok" });
    await withSessionService(respond, async ({ service, store, volume }) => {
      const sessionId = "store-only-session";
      const now = new Date().toISOString();
      await store.create({ id: sessionId, volume, title: null, createdAt: now, lastActiveAt: now });

      const enqueued = await service.enqueueTurn({ sessionId }, "hi");
      await drainToEnd(enqueued.events);
      expect(enqueued.sessionId).toBe(sessionId);
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Eviction re-run on settle.
// ---------------------------------------------------------------------------

describe("SessionService — eviction re-run on settle", () => {
  test("a busy session survives eviction pressure and is evicted once its turn settles", async () => {
    await withGatedSessionService(
      async ({ service, sessions, volume }) => {
        const a = await service.enqueueTurn({ volume }, "session A's turn");
        const sessionA = await waitForControllableSession(sessions, 0);
        await sessionA.waitForStart(0); // A is genuinely busy now

        // A second, independent session's turn — registering it presses the
        // registry (maxSize 1) over the cap while A is still busy.
        const b = await service.enqueueTurn({ volume }, "session B's turn");
        const sessionB = await waitForControllableSession(sessions, 1);
        await sessionB.waitForStart(0);

        // Both busy: eviction had nothing evictable, so the registry
        // overshot its cap (`size <= maxSize + busy-count`).
        expect(service.registry.size).toBe(2);
        expect(service.registry.get(a.sessionId)).toBeDefined();
        expect(service.registry.get(b.sessionId)).toBeDefined();

        // Release A only — B stays busy.
        sessionA.release(0);
        await drainToEnd(a.events);

        // `enqueueTurn`'s own `.finally` re-runs eviction once A's lock
        // hold fully releases.
        await waitUntil(() => service.registry.get(a.sessionId) === undefined);
        expect(service.registry.get(b.sessionId)).toBeDefined();

        sessionB.release(0);
        await drainToEnd(b.events);
      },
      { registryMaxSize: 1 },
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Meta bookkeeping: sdkSessionId, lastActiveAt, default title.
// ---------------------------------------------------------------------------

describe("SessionService — meta bookkeeping", () => {
  test("sdkSessionId written on first-turn completion, lastActiveAt bumps every turn, default title set once from the first operator message", async () => {
    const respond: FakeAgenticTurnResponder = () => ({ text: "ok" });
    await withSessionService(respond, async ({ service, store, sessions, volume }) => {
      const first = await service.enqueueTurn({ volume }, "Hello world\nsecond line, ignored");
      await drainToEnd(first.events);

      const afterFirst = await store.get(first.sessionId);
      expect(afterFirst?.sdkSessionId).toBe(sessions.sessions[0]?.sessionId);
      expect(afterFirst?.sdkSessionId).toBeDefined();
      expect(afterFirst?.title).toBe("Hello world");
      const lastActiveAfterFirst = afterFirst?.lastActiveAt;
      expect(lastActiveAfterFirst).toBeDefined();

      // Wait a tick so a second timestamp is observably later.
      await new Promise((resolve) => setTimeout(resolve, 5));

      const second = await service.enqueueTurn({ sessionId: first.sessionId }, "A second message");
      await drainToEnd(second.events);

      const afterSecond = await store.get(first.sessionId);
      // Same underlying sdk session — no rebuild happened.
      expect(afterSecond?.sdkSessionId).toBe(afterFirst?.sdkSessionId);
      // Title untouched by the second turn.
      expect(afterSecond?.title).toBe("Hello world");
      // lastActiveAt bumped.
      expect(afterSecond?.lastActiveAt).not.toBe(lastActiveAfterFirst);
      expect(
        afterSecond?.lastActiveAt && afterSecond.lastActiveAt >= (lastActiveAfterFirst ?? ""),
      ).toBe(true);
    });
  });

  test("a very long first line clips the default title to 60 chars", async () => {
    const respond: FakeAgenticTurnResponder = () => ({ text: "ok" });
    await withSessionService(respond, async ({ service, store, volume }) => {
      const longFirstLine = "x".repeat(120);
      const enqueued = await service.enqueueTurn({ volume }, longFirstLine);
      await drainToEnd(enqueued.events);

      const meta = await store.get(enqueued.sessionId);
      expect(meta?.title).toBe(`${"x".repeat(60)}…`);
    });
  });
});

// ---------------------------------------------------------------------------
// 9. Crash-while-queued semantics.
// ---------------------------------------------------------------------------

describe("SessionService — crash-while-queued semantics", () => {
  test("a queued turn that never runs leaves NO operator-message in the store", async () => {
    await withGatedSessionService(async ({ service, store, sessions, volume }) => {
      const first = await service.enqueueTurn({ volume }, "op-1 (running)");
      const sessionId = first.sessionId;
      const controllable = await waitForControllableSession(sessions, 0);
      await controllable.waitForStart(0);

      // Queued behind the still-running (never-released) first turn —
      // "abandoned" for the purposes of this test: nothing ever releases it.
      const second = await service.enqueueTurn({ sessionId }, "op-2 (never runs)");
      void second; // intentionally never drained/released in this test

      const recordsWhileQueued = await store.readEvents(sessionId);
      const operatorTexts = operatorRecords(recordsWhileQueued).map(
        (r) => (r.event as { text: string }).text,
      );
      expect(operatorTexts).toEqual(["op-1 (running)"]);
      expect(JSON.stringify(recordsWhileQueued)).not.toContain("op-2 (never runs)");

      // Cleanup: release both so nothing is left dangling across tests.
      controllable.release(0);
      await drainToEnd(first.events);
      await controllable.waitForStart(1);
      controllable.release(1);
      await drainToEnd(second.events);
    });
  });
});
