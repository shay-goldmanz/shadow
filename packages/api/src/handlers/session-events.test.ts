/**
 * `GET /api/sessions/:id/events` (T2.7) — handler-level test spine PLAN.md's
 * T2.7 entry calls for, at HTTP level (real `fetch()` against a real
 * server, via `test-helpers.ts`'s harness with `sessionStore` exposed).
 *
 * Three harnesses:
 * - `withApi`/`withScriptedApi` (`test-helpers.ts`) — for replay-only,
 *   reconnect, and 404 cases, none of which need a turn to be genuinely
 *   mid-flight.
 * - `withGatedApi` (local to this file) — a `ControllableAgenticSessionPort`
 *   harness, mirroring `session-service.test.ts`'s `withGatedSessionService`
 *   one layer down but wired through a real HTTP server, for the
 *   replay-then-follow race and the idle-gap test, both of which need a
 *   turn to be observably running while the SSE connection is open.
 * - `withSteppedApi` (local to this file, F2/F4 review fix) — a
 *   `SteppedAgenticSessionPort` harness whose underlying session streams
 *   individual `text-delta`s one push at a time, for the mid-assistant-
 *   message-join test: a turn can be held with SOME deltas sent and more
 *   still to come, which `ControllableSession`'s single all-or-nothing gate
 *   can't express.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShadowAgent } from "@shadow/agent";
import { FileSystemVolumeStore, toVolumeSlug, type VolumeSlug } from "@shadow/core";
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
import type {
  NewStoredEvent,
  SessionListFilter,
  SessionMeta,
  SessionMetaPatch,
  SessionStore,
  StoredEventRecord,
} from "@shadow/sessions";
import { InMemorySessionStore } from "@shadow/sessions/test-helpers";
import type { ApiDeps } from "../deps.ts";
import { createServer } from "../server.ts";
import { PushChannel } from "../session-bus.ts";
import { SessionService } from "../session-service.ts";
import {
  alwaysNarrativeClassifier,
  type ParsedSseEvent,
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

/** Every `seq` a delivered SSE event carries, in delivery order — the field every wire event derived from a `StoredEventRecord` carries (`event-mapping.ts`'s `withSeq`). */
function seqsOf(events: readonly ParsedSseEvent[]): number[] {
  return events
    .map((e) => (e.data as { seq?: number }).seq)
    .filter((seq): seq is number => typeof seq === "number");
}

/** `event.data`, typed and asserted present — avoids `(events[i]?.data as T)`, which oxlint flags (`no-unsafe-optional-chaining`): the `as` cast breaks the optional chain, so a genuinely-missing event would throw reading a property off it regardless. Throwing here with a clear message is the same failure, just with a useful message instead of a bare `TypeError`. */
function dataOf<T>(event: ParsedSseEvent | undefined): T {
  if (!event) throw new Error("expected an SSE event at this position, got none");
  return event.data as T;
}

// ---------------------------------------------------------------------------
// A `SessionStore` decorator that blocks every `readEvents` call until the
// test releases it — used only by the replay-then-follow race test, to make
// the "subscribe, then replay reads the store" gap deterministically wide
// instead of hoping a real race lands the right way. Every other method
// passes straight through, unmodified.
// ---------------------------------------------------------------------------

class GatedReadEventsStore implements SessionStore {
  private gate: Promise<void> = Promise.resolve();
  private release: () => void = () => {};
  /** F5 review fix's test: the next `readEvents` call throws this instead of delegating, then clears itself — one-shot, so only the call under test is affected. */
  private pendingReadError: Error | undefined;
  /**
   * Fires the INSTANT `readEvents` is called, before it ever awaits the
   * gate — a test-observable proxy for "the handler's subscribe-then-
   * replay sequence has reached the replay step," since `getSessionEvents`
   * calls `subscribeToSession` synchronously, strictly before its one
   * `await sessionService.readEvents(...)` (this module's doc; the
   * handler's own module doc, "Bus-first-buffer"). A test cannot otherwise
   * observe "subscribe already happened" from the outside — awaiting the
   * HTTP response's headers does NOT prove it, because Bun does not flush
   * a streamed response's headers until its `ReadableStream` first
   * `enqueue()`s something, which — for a gated `readEvents` — hasn't
   * happened yet.
   */
  onReadEventsCalled: (() => void) | undefined;

  constructor(private readonly inner: SessionStore) {}

  /** Blocks every subsequent `readEvents` call until `releaseReads()` is called. Re-arms on each call, so a second `holdReads()` can gate a later reconnect too — unused by this file's tests, but keeps the fake honest about its own contract. */
  holdReads(): void {
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  releaseReads(): void {
    this.release();
  }

  /** F5 review fix's test: makes the NEXT `readEvents` call reject with `error` instead of delegating to `inner` — one-shot. */
  throwOnNextRead(error: Error): void {
    this.pendingReadError = error;
  }

  create(meta: SessionMeta): Promise<void> {
    return this.inner.create(meta);
  }
  get(id: string): Promise<SessionMeta | undefined> {
    return this.inner.get(id);
  }
  list(filter?: SessionListFilter): Promise<SessionMeta[]> {
    return this.inner.list(filter);
  }
  update(id: string, patch: SessionMetaPatch): Promise<void> {
    return this.inner.update(id, patch);
  }
  append(id: string, events: readonly NewStoredEvent[]): Promise<StoredEventRecord[]> {
    return this.inner.append(id, events);
  }
  async readEvents(id: string, fromSeq?: number): Promise<StoredEventRecord[]> {
    this.onReadEventsCalled?.();
    await this.gate;
    if (this.pendingReadError) {
      const error = this.pendingReadError;
      this.pendingReadError = undefined;
      throw error;
    }
    return this.inner.readEvents(id, fromSeq);
  }
  delete(id: string): Promise<void> {
    return this.inner.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Controllable underlying session — mirrors `session-service.test.ts`'s
// `ControllableSession`/`ControllableAgenticSessionPort` (itself mirroring
// `handlers/research-concurrency.test.ts`'s): `stream()` blocks on a real
// gate until the test releases this exact turn index, so a turn can be held
// genuinely, observably mid-flight while a follow stream races it.
// ---------------------------------------------------------------------------

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
  readonly deps: ApiDeps;
  readonly baseUrl: string;
  readonly sessions: ControllableAgenticSessionPort;
  readonly store: GatedReadEventsStore;
  readonly volume: VolumeSlug;
}

async function withGatedApi<T>(fn: (harness: GatedHarness) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "shadow-session-events-gated-"));
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

    const store = new GatedReadEventsStore(new InMemorySessionStore());
    const sessionService = new SessionService({ store, shadowAgent });

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
      return await fn({
        deps,
        baseUrl: server.url.toString().replace(/\/$/, ""),
        sessions,
        store,
        volume,
      });
    } finally {
      void server.stop(true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function postChatOnGatedHarness(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Stepped underlying session — F2/F4 review fix's harness: `stream()` drains
// a `PushChannel` (`../session-bus.ts` — the exact same mechanism the
// production code under test uses, reused here rather than hand-rolled)
// that the test pushes individual `text-delta`s and a final `done` into,
// one at a time. Unlike `ControllableSession` above (one all-or-nothing gate
// per turn), this lets a test hold a message genuinely MID-STREAM — some
// deltas sent, more still to come — so a follow viewer can be proven to join
// in the middle of one. Channels are created lazily (`ensureChannel`) so a
// test can start pushing before `stream()` has necessarily been called yet
// without losing anything (`PushChannel` already buffers regardless of
// whether anyone's consuming — this module's own doc).
// ---------------------------------------------------------------------------

class SteppedSession implements AgenticSession {
  sessionId: string | undefined;
  usage = ZERO_USAGE;
  readonly prompts: string[] = [];
  private turnIndex = 0;
  private readonly channels: PushChannel<AgenticStreamEvent>[] = [];

  constructor(
    private readonly assignedSessionId: string,
    public readonly options: AgenticSessionOptions,
  ) {}

  private ensureChannel(index: number): PushChannel<AgenticStreamEvent> {
    let channel = this.channels[index];
    if (!channel) {
      channel = new PushChannel<AgenticStreamEvent>();
      this.channels[index] = channel;
    }
    return channel;
  }

  async *stream(prompt: string): AsyncGenerator<AgenticStreamEvent, void, undefined> {
    this.prompts.push(prompt);
    const index = this.turnIndex++;
    const channel = this.ensureChannel(index);
    for await (const event of channel) {
      yield event;
    }
  }

  /** Pushes one live `text-delta` chunk into `index`'s turn. */
  pushDelta(index: number, text: string): void {
    this.ensureChannel(index).push({ type: "text-delta", text });
  }

  /** Completes `index`'s turn with `finalText` — the eventual `assistant-message` record's full text. */
  finish(index: number, finalText: string): void {
    this.sessionId = this.assignedSessionId;
    const result: AgenticTurnResult = {
      text: finalText,
      usage: ZERO_USAGE,
      sessionId: this.assignedSessionId,
      stopReason: "end_turn",
      isError: false,
      subagentsEnabled: false,
    };
    const channel = this.ensureChannel(index);
    channel.push({ type: "done", result });
    channel.end();
  }

  async close(): Promise<void> {}
}

class SteppedAgenticSessionPort implements AgenticSessionPort {
  readonly sessions: SteppedSession[] = [];
  private counter = 0;

  createSession(options: AgenticSessionOptions = {}): AgenticSession {
    this.counter += 1;
    const session = new SteppedSession(`stepped-session-${this.counter}`, options);
    this.sessions.push(session);
    return session;
  }

  async deleteStoredSession(): Promise<void> {}
}

interface SteppedHarness {
  readonly baseUrl: string;
  readonly sessions: SteppedAgenticSessionPort;
}

async function withSteppedApi<T>(fn: (harness: SteppedHarness) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "shadow-session-events-stepped-"));
  try {
    const volumeStore = new FileSystemVolumeStore(root);
    const evidenceStore = new FileSystemEvidenceStore(volumeStore);
    const indexer = new StructuralIndexer({ rootDir: root });
    const sessions = new SteppedAgenticSessionPort();
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
    const sessionService = new SessionService({ store, shadowAgent });

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

/** Drains a `POST /api/chat` SSE response to completion — the test only needs the turn to finish, not any specific event out of it. */
async function drainChatResponse(response: Response): Promise<void> {
  await readAllSseEvents(response);
}

// ---------------------------------------------------------------------------
// 1. Replay-only: the full mapped wire sequence, seq-stamped, then `done`.
// ---------------------------------------------------------------------------

describe("GET /api/sessions/:id/events — replay-only", () => {
  test("streams the full stored transcript as mapped wire events, each carrying its record's seq, then ends with done", async () => {
    const respond: FakeAgenticTurnResponder = () => ({ text: "Full reply text." });

    await withScriptedApi({ respond }, async ({ baseUrl, deps }) => {
      const volume = toVolumeSlug("design-craft");
      await seedVolume(deps, volume);

      const chatRes = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ volumeSlug: "design-craft", message: "Hello Shadow" }),
      });
      const chatEvents = await readAllSseEvents(chatRes);
      const sessionId = dataOf<{ sessionId: string }>(chatEvents[0]).sessionId;

      const replayRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/events`);
      expect(replayRes.status).toBe(200);
      expect(replayRes.headers.get("content-type")).toContain("text/event-stream");
      const replayEvents = await readAllSseEvents(replayRes);

      // Stored: operator-message, turn-boundary(started), operator-turn-recorded,
      // assistant-message, turn-boundary(ended, completed) — operator-message,
      // assistant-message, AND (F3 review fix) the closing
      // turn-boundary(ended, completed) all have a wire representation
      // (`wireEventsFromStored`); only the started boundary and the
      // operator-turn-recorded record produce nothing.
      expect(replayEvents.map((e) => e.event)).toEqual(["operator", "text", "turn.ended", "done"]);
      expect(dataOf<{ text: string }>(replayEvents[0]).text).toBe("Hello Shadow");
      expect(dataOf<{ delta: string }>(replayEvents[1]).delta).toBe("Full reply text.");

      // Every record-derived wire event carries its record's seq — strictly
      // increasing, no gaps among the ones that DO carry it (operator=1,
      // assistant-message=4, the closing turn-boundary=5; the started
      // boundary/operator-turn-recorded records legitimately produce no
      // wire event at all).
      expect(seqsOf(replayEvents)).toEqual([1, 4, 5]);

      // done has no seq (it isn't derived from any one record).
      expect(dataOf<{ seq?: number }>(replayEvents.at(-1)).seq).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Replay-then-follow during a RUNNING turn: bus-first-buffer, no gap, no
//    duplicate around the seq boundary.
// ---------------------------------------------------------------------------

describe("GET /api/sessions/:id/events?follow=true — replay-then-follow during a running turn", () => {
  test("subscribing before replay closes the gap: every record delivered exactly once, in seq order, even when a second turn's records are appended and published while the replay read is still gated", async () => {
    await withGatedApi(async ({ baseUrl, sessions, store }) => {
      // Turn 1 completes fully — this becomes the stored prefix replay
      // will read back once its (gated) read is released.
      const firstChat = postChatOnGatedHarness(baseUrl, {
        volumeSlug: "design-craft",
        message: "turn one",
      });
      await waitUntil(() => sessions.sessions.length > 0);
      const controllable = sessions.sessions[0];
      if (!controllable) throw new Error("expected a controllable session");
      await controllable.waitForStart(0);
      controllable.release(0);
      const firstChatEvents = await readAllSseEvents(await firstChat);
      const sessionId = dataOf<{ sessionId: string }>(firstChatEvents[0]).sessionId;

      // Gate the store's `readEvents` — the follow request below will
      // subscribe to the bus (synchronous, happens before any await in the
      // handler) and then block trying to replay, exactly widening the
      // "subscribe, then replay reads the store" window PLAN.md's
      // bus-first-buffer design exists to close.
      store.holdReads();
      const readEventsCalled = new Promise<void>((resolve) => {
        store.onReadEventsCalled = resolve;
      });

      // Fired but deliberately NOT awaited here — a streamed response's
      // headers don't arrive until its `ReadableStream` first `enqueue()`s
      // something, which won't happen until the gate below is released.
      // `readEventsCalled` is the real, immediate proof that the handler's
      // synchronous subscribe-then-replay sequence has already reached the
      // (now-blocked) replay step.
      const followPromise = fetch(`${baseUrl}/api/sessions/${sessionId}/events?follow=true`);
      await readEventsCalled;

      // Turn 2, on the SAME session, runs to completion WHILE the follow
      // stream's replay is still blocked — every one of its records is
      // published to the bus (and therefore buffered by the follow
      // subscription) strictly before replay ever reads the store.
      const secondChat = postChatOnGatedHarness(baseUrl, {
        sessionId,
        message: "turn two",
      });
      await controllable.waitForStart(1);
      controllable.release(1);
      await drainChatResponse(await secondChat);

      // NOW release the gate: replay reads the store for the first time,
      // and — because turn 2 already finished appending above — reads back
      // BOTH turns' records in one shot. Every one of turn 2's records is
      // therefore ALSO sitting in the follow subscription's buffer,
      // published there before replay ever ran: the dedup-by-seq path is
      // exercised for real, not merely reachable in principle.
      store.releaseReads();

      const followRes = await followPromise;
      expect(followRes.status).toBe(200);

      const events = await readSseEventsUntil(
        followRes,
        (collected) => collected.filter((e) => e.event === "operator").length >= 2,
        { timeoutMs: 5_000 },
      );

      // Both operator messages arrive — turn 1's via pure replay, turn 2's
      // via replay-that-already-caught-up-with-the-buffer — but each
      // EXACTLY once: the buffered duplicate of turn 2's records (seq
      // already <= what replay just delivered) is dropped, not re-sent.
      const operatorTexts = events
        .filter((e) => e.event === "operator")
        .map((e) => (e.data as { text: string }).text);
      expect(operatorTexts).toEqual(["turn one", "turn two"]);

      // The full seq sequence this viewer saw is strictly increasing with
      // no gap and no repeated value — the property PLAN.md's
      // bus-first-buffer design exists to guarantee.
      const seqs = seqsOf(events);
      for (let i = 1; i < seqs.length; i++) {
        expect((seqs[i] ?? 0) > (seqs[i - 1] ?? 0)).toBe(true);
      }
      expect(new Set(seqs).size).toBe(seqs.length); // no duplicates
      // operator(seq 1), text(seq 4), turn.ended(seq 5) for turn 1;
      // operator(seq 6), text(seq 9), turn.ended(seq 10) for turn 2 — the
      // two turns' seq ranges are contiguous 5-record blocks
      // (operator-message, turn-boundary, operator-turn-recorded,
      // assistant-message, turn-boundary), matching `session-service.test.ts`'s
      // tee test; `turn-boundary(ended, completed)` now has a wire
      // representation too (F3 review fix), unlike the started boundary.
      expect(seqs).toEqual([1, 4, 5, 6, 9, 10]);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Reconnect with fromSeq=lastSeq+1 — only newer events.
// ---------------------------------------------------------------------------

describe("GET /api/sessions/:id/events?fromSeq= — reconnect cursor", () => {
  test("fromSeq is inclusive of the seq it names and excludes everything before it", async () => {
    const respond: FakeAgenticTurnResponder = (_prompt, { turnIndex }) =>
      turnIndex === 0 ? { text: "first reply" } : { text: "second reply" };

    await withScriptedApi({ respond }, async ({ baseUrl, deps, sessionStore }) => {
      const volume = toVolumeSlug("design-craft");
      await seedVolume(deps, volume);

      const firstRes = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ volumeSlug: "design-craft", message: "first message" }),
      });
      const firstEvents = await readAllSseEvents(firstRes);
      const sessionId = dataOf<{ sessionId: string }>(firstEvents[0]).sessionId;

      await drainChatResponse(
        await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, message: "second message" }),
        }),
      );

      const allRecords = await sessionStore.readEvents(sessionId);
      // The second turn's operator-message record's seq is the reconnect
      // cursor under test.
      const secondOperator = allRecords.find(
        (r) =>
          r.event.type === "operator-message" &&
          (r.event as { text: string }).text === "second message",
      );
      if (!secondOperator) throw new Error("expected the second turn's operator-message record");

      // A client that has already seen up through `secondOperator.seq - 1`
      // reconnects with `fromSeq = secondOperator.seq` (the store contract:
      // inclusive, so this re-delivers the record it names, not just what
      // comes after it).
      const reconnectRes = await fetch(
        `${baseUrl}/api/sessions/${sessionId}/events?fromSeq=${secondOperator.seq}`,
      );
      expect(reconnectRes.status).toBe(200);
      const reconnectEvents = await readAllSseEvents(reconnectRes);

      // Only the second turn's content — the first turn's operator/text
      // events (lower seq) are absent entirely.
      expect(reconnectEvents.map((e) => e.event)).toEqual([
        "operator",
        "text",
        "turn.ended",
        "done",
      ]);
      expect(dataOf<{ text: string }>(reconnectEvents[0]).text).toBe("second message");
      expect(dataOf<{ delta: string }>(reconnectEvents[1]).delta).toBe("second reply");
      expect(seqsOf(reconnectEvents).every((seq) => seq >= secondOperator.seq)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// F2/F4 review fix: reconnecting after a completed message re-delivers its
// FULL text exactly once — never duplicated, never per-delta.
// ---------------------------------------------------------------------------

describe("GET /api/sessions/:id/events?fromSeq= — F2/F4: reconnect after a completed message", () => {
  test("fromSeq at the assistant-message record's own seq re-delivers the FULL text as ONE text event, not per delta chunk", async () => {
    const respond: FakeAgenticTurnResponder = () => ({
      text: "Hello world",
      events: [
        { type: "text-delta", text: "Hello " },
        { type: "text-delta", text: "world" },
      ],
    });

    await withScriptedApi({ respond }, async ({ baseUrl, deps }) => {
      const volume = toVolumeSlug("design-craft");
      await seedVolume(deps, volume);

      const chatRes = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ volumeSlug: "design-craft", message: "hi" }),
      });
      const chatEvents = await readAllSseEvents(chatRes);
      const sessionId = dataOf<{ sessionId: string }>(chatEvents[0]).sessionId;
      // The live stream itself sent two separate `text` deltas that summed
      // to the full string — proof this scenario actually exercises a
      // multi-chunk message, not a single-chunk one that would pass either
      // way.
      const liveDeltas = chatEvents.filter((e) => e.event === "text");
      expect(liveDeltas.map((e) => (e.data as { delta: string }).delta)).toEqual([
        "Hello ",
        "world",
      ]);

      const replayed = await readAllSseEvents(
        await fetch(`${baseUrl}/api/sessions/${sessionId}/events`),
      );
      const textRecord = replayed.find((e) => e.event === "text");
      if (!textRecord) throw new Error("expected a text event in the replayed transcript");
      const seq = dataOf<{ seq: number }>(textRecord).seq;

      // A client reconnecting exactly at (or before) the record's own seq —
      // the inclusive `fromSeq` contract re-delivers it.
      const reconnected = await readAllSseEvents(
        await fetch(`${baseUrl}/api/sessions/${sessionId}/events?fromSeq=${seq}`),
      );
      const textEvents = reconnected.filter((e) => e.event === "text");

      // Exactly ONE `text` event — the stored `assistant-message` record's
      // full accumulated string, never the two individual deltas the live
      // stream sent (deltas have no stored shape at all, so a reconnect can
      // never re-derive or duplicate them).
      expect(textEvents).toHaveLength(1);
      expect(dataOf<{ delta: string; seq: number }>(textEvents[0]).delta).toBe("Hello world");
      expect(dataOf<{ seq: number }>(textEvents[0]).seq).toBe(seq);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Follow survives an idle gap: turn completes, stream stays open, a
//    second turn's events arrive on the same stream.
// ---------------------------------------------------------------------------

describe("GET /api/sessions/:id/events?follow=true — survives idle between turns", () => {
  test("a follow stream opened after a turn completes stays open and delivers a LATER turn's events on the same connection", async () => {
    await withGatedApi(async ({ baseUrl, sessions }) => {
      const firstChat = postChatOnGatedHarness(baseUrl, {
        volumeSlug: "design-craft",
        message: "turn one",
      });
      await waitUntil(() => sessions.sessions.length > 0);
      const controllable = sessions.sessions[0];
      if (!controllable) throw new Error("expected a controllable session");
      await controllable.waitForStart(0);
      controllable.release(0);
      const firstChatEvents = await readAllSseEvents(await firstChat);
      const sessionId = dataOf<{ sessionId: string }>(firstChatEvents[0]).sessionId;

      // Open follow only AFTER the first turn has fully settled — a purely
      // passive second tab, arriving during the idle gap between turns.
      const followRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/events?follow=true`);
      expect(followRes.status).toBe(200);

      // Idle: nothing happens on this session for a beat. The connection
      // must not close on its own (turn-ended is not a close condition).
      await new Promise((resolve) => setTimeout(resolve, 50));

      // A second turn, well after the first ended — the passive viewer
      // must see it on the SAME already-open connection.
      const secondChat = postChatOnGatedHarness(baseUrl, {
        sessionId,
        message: "turn two",
      });
      await controllable.waitForStart(1);
      controllable.release(1);
      await drainChatResponse(await secondChat);

      const events = await readSseEventsUntil(
        followRes,
        (collected) => collected.filter((e) => e.event === "operator").length >= 2,
        { timeoutMs: 5_000 },
      );

      // Turn 1's operator event arrived via replay (the stream opened after
      // it settled); turn 2's arrived live, on the SAME connection, after
      // the idle gap — proving the stream never closed on turn 1's end.
      const operatorTexts = events
        .filter((e) => e.event === "operator")
        .map((e) => (e.data as { text: string }).text);
      expect(operatorTexts).toEqual(["turn one", "turn two"]);
      // No `done` — follow never sends it (this module's doc: it stays
      // open until the client disconnects).
      expect(events.some((e) => e.event === "done")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// 5. 404 for an unknown session id; no rehydration on replay of a cold
//    session.
// ---------------------------------------------------------------------------

describe("GET /api/sessions/:id/events — 404 and no rehydration", () => {
  test("an unknown session id is 404 session_not_found, matching POST /api/chat's own mapping", async () => {
    await withScriptedApi({}, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/sessions/does-not-exist/events`);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("session_not_found");
    });
  });

  test("replaying a session that exists only in the store (post-restart shape) never adds it to the registry", async () => {
    await withApi(async ({ baseUrl, deps, sessionStore }) => {
      const volume = toVolumeSlug("design-craft");
      await seedVolume(deps, volume);

      const sessionId = "cold-session-replay-only";
      const now = new Date().toISOString();
      await sessionStore.create({
        id: sessionId,
        volume,
        title: null,
        createdAt: now,
        lastActiveAt: now,
      });
      await sessionStore.append(sessionId, [
        { turnId: "seed-turn", at: now, event: { type: "operator-message", text: "seeded" } },
      ]);

      // Never touched via enqueueTurn/POST /api/chat — the registry has
      // never heard of this session id.
      expect(deps.sessionService.registry.get(sessionId)).toBeUndefined();

      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/events`);
      expect(res.status).toBe(200);
      const events = await readAllSseEvents(res);
      expect(events.map((e) => e.event)).toEqual(["operator", "done"]);

      // Replay is read-only (PLAN.md's T2.7 entry) — it must not have
      // rehydrated a `ShadowConversation` for this cold session.
      expect(deps.sessionService.registry.get(sessionId)).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// 6. F5 review fix: a readEvents failure on the follow endpoint's error path
//    still unsubscribes the bus listener — no leaked subscription.
// ---------------------------------------------------------------------------

describe("GET /api/sessions/:id/events?follow=true — F5: bus unsubscribe on the error path", () => {
  test("a replay-read failure sends an in-band error, closes the stream, and leaves the bus listener count at zero", async () => {
    await withGatedApi(async ({ baseUrl, sessions, store, deps }) => {
      // A real, existing session — `hasSession`'s pre-stream check only
      // touches the registry/store's `get`, never `readEvents`, so this
      // needs to succeed before the throwing read is ever reached.
      const firstChat = postChatOnGatedHarness(baseUrl, {
        volumeSlug: "design-craft",
        message: "turn one",
      });
      await waitUntil(() => sessions.sessions.length > 0);
      const controllable = sessions.sessions[0];
      if (!controllable) throw new Error("expected a controllable session");
      await controllable.waitForStart(0);
      controllable.release(0);
      const firstChatEvents = await readAllSseEvents(await firstChat);
      const sessionId = dataOf<{ sessionId: string }>(firstChatEvents[0]).sessionId;

      // Before this fix: subscribeToSession registers a listener here, the
      // replay read below throws, and NOTHING ever called `unsubscribe()`
      // on that path — the listener stayed registered forever.
      store.throwOnNextRead(new Error("simulated readEvents failure"));

      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/events?follow=true`);
      expect(res.status).toBe(200); // the failure happens INSIDE the stream, after headers are already committed

      // The handler's own `catch` sends an in-band `error` event and its
      // `finally` closes the controller — this stream, unlike an ordinary
      // follow stream, genuinely ends on its own here, so a plain
      // `readAllSseEvents` (not `readSseEventsUntil`) is the right reader.
      const events = await readAllSseEvents(res);
      expect(events.map((e) => e.event)).toEqual(["error"]);
      expect(dataOf<{ message: string }>(events[0]).message).toContain(
        "simulated readEvents failure",
      );

      // The fix under test: the bus listener this request's
      // `subscribeToSession` registered is gone, not leaked.
      expect(deps.sessionService.listenerCountForTest(sessionId)).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// F2/F4 review fix: a follow viewer who subscribes MID-assistant-message —
// after some deltas, before the message completes — still ends up with the
// COMPLETE text exactly once, via the eventual seq-stamped full-text replace
// event, instead of permanently losing the prefix it missed.
// ---------------------------------------------------------------------------

describe("GET /api/sessions/:id/events?follow=true — F2/F4: viewer joins mid-assistant-message", () => {
  test("deltas flow before the join, the viewer joins, more deltas flow, then the record lands: the wire carries the complete text as ONE seq-stamped replace event", async () => {
    await withSteppedApi(async ({ baseUrl, sessions }) => {
      // Start the turn. `SteppedSession.stream()` blocks on its own
      // per-turn `PushChannel` until pushed into — nothing streams until
      // this test says so.
      const chatPromise = postChatOnGatedHarness(baseUrl, {
        volumeSlug: "design-craft",
        message: "start",
      });

      // Proves the session row + `ShadowConversation` already exist (F8
      // review fix: for a fresh `{volume}` target, the row is now created
      // from INSIDE `runTurn`, which only runs once `ensureConversation`
      // has constructed this exact session — `hasSession`'s pre-stream
      // check below needs that to have already happened).
      await waitUntil(() => sessions.sessions.length > 0);
      const session = sessions.sessions[0];
      if (!session) throw new Error("expected a stepped session");

      // Read just the `session` event off the chat POST's own stream to
      // learn the id, then let that one viewer go — the turn keeps running
      // server-side regardless (T2.5's whole point; `postChatOnGatedHarness`
      // callers elsewhere in this file rely on the same fact).
      const initial = await readSseEventsUntil(
        await chatPromise,
        (collected) => collected.some((e) => e.event === "session"),
        { timeoutMs: 2_000 },
      );
      const sessionId = dataOf<{ sessionId: string }>(initial[0]).sessionId;

      // Some of the message streams BEFORE any viewer joins — this is the
      // prefix a follow-only viewer can never recover from live deltas
      // alone.
      session.pushDelta(0, "Hello ");

      // The viewer joins mid-message. `fetch()` resolving here is itself
      // the proof the subscribe has already happened — Bun does not flush
      // a streamed response's headers until its first `enqueue()`, and
      // `subscribeToSession` runs strictly before replay's first enqueue
      // (`session-events.ts`'s "Bus-first-buffer" doc).
      const followRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/events?follow=true`);
      expect(followRes.status).toBe(200);

      // More of the message streams AFTER the join — this part the viewer
      // DOES receive live, as an ordinary seq-less delta.
      session.pushDelta(0, "world");
      // The message completes: the stored `assistant-message` record (full
      // text "Hello world") and the closing `turn-boundary(ended,
      // completed)` record are appended and published.
      session.finish(0, "Hello world");

      const events = await readSseEventsUntil(
        followRes,
        (collected) => collected.some((e) => e.event === "turn.ended"),
        { timeoutMs: 5_000 },
      );

      const textEvents = events.filter((e) => e.event === "text");
      const seqCarrying = textEvents.filter((e) => (e.data as { seq?: number }).seq !== undefined);
      const seqLess = textEvents.filter((e) => (e.data as { seq?: number }).seq === undefined);

      // The pre-join delta ("Hello ") never arrives on its own — this
      // viewer wasn't subscribed yet when it was sent, and it has no
      // stored shape a later record could re-derive it from individually.
      expect(seqLess.map((e) => (e.data as { delta: string }).delta)).toEqual(["world"]);

      // Exactly ONE seq-carrying `text` event — the eventual
      // `assistant-message` record, now reaching the live tail too (F2/F4
      // fix) — carrying the FULL, authoritative text. Before this fix, the
      // live tail suppressed this record entirely (`wireEventsForLive`),
      // so this viewer would have been stuck with only "world" forever —
      // the prefix it missed by joining mid-message, permanently lost.
      expect(seqCarrying).toHaveLength(1);
      expect(dataOf<{ delta: string }>(seqCarrying[0]).delta).toBe("Hello world");

      // Downstream (`../../web/src/pages/chat-transcript.ts`'s `"text"`
      // case, pinned separately in that package's own tests): a seq-carrying
      // `text` REPLACES the assistant bubble outright, so this viewer's
      // rendered transcript ends with "Hello world" exactly once — never
      // "worldHello world" (an append) and never just "world" (the
      // pre-fix loss).
    });
  });
});
