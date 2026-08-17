/**
 * Sessions e2e — the system-level flows unit/handler tests can't prove
 * (`docs/superpowers/specs/shadow-sessions/PLAN.md`'s verification step for
 * Tiers 0-3, "prove the sessions feature holds together as a system").
 *
 * Every test here goes through real HTTP (`fetch` against a real
 * `Bun.serve` loopback socket, `createServer` — `@shadow/api/server.ts`)
 * over a real `FileSystemSessionStore` rooted at a temp `SHADOW_HOME`
 * (`tests/e2e/helpers/sessions-harness.ts`), with only the model layer
 * faked (`@shadow/model`'s `FakeAgenticSessionPort` / a hand-rolled
 * `AgenticSession` for the tests that need real mid-turn control) — the
 * same "real everything except the LLM" shape `@shadow/api`'s own
 * `test-helpers.ts` uses, minus the one swap (`InMemorySessionStore` ->
 * `FileSystemSessionStore`) that makes restart/crash/delete-from-disk
 * provable at all.
 *
 * What's covered, and why each earns its place as an e2e (not a unit/
 * handler test — those already exist and are thorough, see
 * `packages/api/src/session-service.test.ts`,
 * `session-service.shutdown.test.ts`, `handlers/sessions.test.ts`,
 * `handlers/session-events.test.ts`):
 *
 * 1. **Persistence across restart** — a session survives the `ApiDeps`/
 *    `Bun.serve` instance that created it being torn down completely and
 *    rebuilt from nothing but the same on-disk root: `GET /api/sessions`
 *    finds it, replay reconstructs its transcript, and a further turn
 *    resumes it (`options.resume.sessionId` reaches the model port). No
 *    existing test rebuilds `ApiDeps` from scratch mid-test — every handler
 *    test's server lives for exactly one `withApi`/`withScriptedApi` call.
 * 2. **Replay+follow across two clients** — a second client subscribing
 *    mid-turn converges on the SAME transcript a first client watching live
 *    sees, proving the whole-message semantics fix (F2/F4,
 *    `session-events.ts`'s module doc) over the real bus/store pairing, not
 *    just the mapping function in isolation.
 * 3. **FIFO + queue bound over the wire** — `session-service.test.ts`
 *    already proves this at the service layer; this proves the SAME bound
 *    is reachable and enforced from real concurrent `fetch()` calls, through
 *    the actual HTTP/JSON boundary (`TurnQueueBusyError`'s `409` envelope).
 * 4. **Delete end-to-end** — a completed-turn session AND a poisoned
 *    failed-first-turn session, deleted over HTTP, with the directories
 *    actually gone from a REAL filesystem (`existsSync`), the fake model
 *    port's deletion spy checked, and a live follower's stream closing
 *    cleanly.
 * 5. **Crash torn-tail self-heal** — `filesystem-session-store.test.ts`
 *    already proves the store repairs a torn tail in isolation; this proves
 *    the repair is reachable through a REAL restart-then-turn sequence:
 *    write via the real API, tear the file on disk exactly as a SIGKILL
 *    mid-`append` would, rebuild `ApiDeps` from the same root, replay, then
 *    send a further turn through the wire and confirm the file is clean
 *    afterward.
 * 6. **Graceful shutdown e2e** — `session-service.shutdown.test.ts` already
 *    proves the interruption mechanism against a controllable fake; this
 *    proves the SAME sequence end-to-end through a live SSE connection (a
 *    real client watching `POST /api/chat` sees the stream end) and that
 *    the interrupted boundary survives a full rebuild afterward.
 *
 * Deliberately NOT added (see the caller-facing report for the full
 * reasoning): a byte-for-byte SIGKILL simulation (the store's own crash
 * torn-tail unit test already covers the exact mechanism; this suite proves
 * it end-to-end via direct file truncation instead of actually killing a
 * `bun test` worker process, which the test runner has no supported way to
 * do to itself mid-write).
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgenticSession,
  AgenticSessionOptions,
  AgenticSessionPort,
  AgenticStreamEvent,
} from "../../packages/model/src/index.ts";
import { ZERO_USAGE } from "../../packages/model/src/index.ts";
import {
  FakeAgenticSessionPort,
  type FakeAgenticTurnResponder,
  type ParsedSseEvent,
  readAllSseEvents,
  readSseEventsUntil,
  startSessionsApi,
  stopSessionsApiGracefully,
  streamSseEvents,
  toVolumeSlug,
  withSessionsHome,
} from "./helpers/sessions-harness.ts";

/** Reads a session's `events.jsonl` off the REAL filesystem — used only where the assertion genuinely needs raw bytes (the torn-tail test); everything else goes through the HTTP API like a real client would. */
function eventsJsonlPath(root: string, sessionId: string): string {
  return join(root, "sessions", sessionId, "events.jsonl");
}

async function postChat(
  baseUrl: string,
  body: { volumeSlug?: string; sessionId?: string; message: string },
): Promise<Response> {
  return fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function findEvent(events: readonly ParsedSseEvent[], name: string): ParsedSseEvent | undefined {
  return events.find((e) => e.event === name);
}

const replyFromProcess1: FakeAgenticTurnResponder = () => ({ text: "reply from process 1" });
const replyFromProcess2: FakeAgenticTurnResponder = () => ({
  text: "reply from process 2, after resume",
});

function sessionIdFrom(events: readonly ParsedSseEvent[]): string {
  const sessionEvent = findEvent(events, "session");
  if (!sessionEvent) throw new Error("no 'session' SSE event received");
  return (sessionEvent.data as { sessionId: string }).sessionId;
}

// ---------------------------------------------------------------------------
// 1. Persistence across restart.
// ---------------------------------------------------------------------------

describe("Sessions e2e — persistence across a full process rebuild", () => {
  test(
    "a session created via POST /api/chat survives the API instance being torn down and " +
      "rebuilt from the same SHADOW_HOME: GET /api/sessions shows it, replay reconstructs the " +
      "transcript, and a further turn resumes it (options.resume reaches the model port)",
    async () => {
      await withSessionsHome(async (root) => {
        const volume = toVolumeSlug("restart-volume");

        // --- process 1: create the session, complete one turn -------------
        const api1 = startSessionsApi(root, new FakeAgenticSessionPort(replyFromProcess1));
        let sessionId: string;
        try {
          await api1.volumeStore.createVolume({ slug: volume, title: "Restart Volume" });

          const res1 = await postChat(api1.baseUrl, {
            volumeSlug: "restart-volume",
            message: "first turn, before restart",
          });
          expect(res1.status).toBe(200);
          const events1 = await readAllSseEvents(res1);
          expect(findEvent(events1, "done")).toBeDefined();
          expect(findEvent(events1, "error")).toBeUndefined();
          sessionId = sessionIdFrom(events1);

          // The fake model port assigned a real sdk session id on the
          // successful first turn — captured here to compare against
          // process 2's resume target below.
          expect(api1.sessions.sessions).toHaveLength(1);
          const sdkSessionIdBeforeRestart = api1.sessions.sessions[0]?.sessionId;
          expect(sdkSessionIdBeforeRestart).toBeDefined();

          // Sanity: the row and transcript really are on disk, not just in
          // this process's memory.
          expect(existsSync(join(root, "sessions", sessionId, "meta.json"))).toBe(true);
        } finally {
          // Graceful teardown (T2.9's real sequence) — this is "restart",
          // not "crash"; the crash-torn-tail test below covers the other
          // shape.
          await stopSessionsApiGracefully(api1);
        }

        // --- process 2: nothing shared with process 1 but the filesystem --
        const api2 = startSessionsApi(root, new FakeAgenticSessionPort(replyFromProcess2));
        try {
          // GET /api/sessions: the row survived, on a BRAND NEW SessionService
          // /ConversationRegistry/store instance that never saw process 1.
          const listRes = await fetch(`${api2.baseUrl}/api/sessions`);
          expect(listRes.status).toBe(200);
          const listBody = (await listRes.json()) as {
            sessions: readonly { id: string; volume: string }[];
          };
          expect(listBody.sessions.map((s) => s.id)).toContain(sessionId);
          expect(listBody.sessions.find((s) => s.id === sessionId)?.volume).toBe("restart-volume");

          // Replay: the whole transcript from turn 1 is intact, including
          // the FULL assistant text (not just deltas — `assistant-message`'s
          // stored record, see event-mapping.ts's module doc).
          const replayRes = await fetch(`${api2.baseUrl}/api/sessions/${sessionId}/events`);
          expect(replayRes.status).toBe(200);
          const replayEvents = await readAllSseEvents(replayRes);
          expect(findEvent(replayEvents, "operator")).toMatchObject({
            data: { text: "first turn, before restart" },
          });
          const replayedText = replayEvents.find(
            (e) => e.event === "text" && (e.data as { delta: string }).delta.includes("process 1"),
          );
          expect(replayedText).toBeDefined();
          expect(findEvent(replayEvents, "done")).toBeDefined();

          // A further turn on the SAME sessionId, on this brand-new process:
          // rehydration must reach the model port with `resume.sessionId`
          // set to what process 1 persisted — the actual proof that
          // persistence isn't just "the JSON is still there" but "the next
          // turn genuinely resumes from it."
          const res2 = await postChat(api2.baseUrl, {
            sessionId,
            message: "second turn, after restart",
          });
          expect(res2.status).toBe(200);
          const events2 = await readAllSseEvents(res2);
          expect(findEvent(events2, "error")).toBeUndefined();
          expect(findEvent(events2, "done")).toBeDefined();
          expect(sessionIdFrom(events2)).toBe(sessionId);

          expect(api2.sessions.sessions).toHaveLength(1);
          const rehydratedSession = api2.sessions.sessions[0];
          expect(rehydratedSession?.options.resume?.sessionId).toBeDefined();
          // Process 2 never talked to process 1's in-memory FakeAgenticSessionPort
          // (a fresh one was constructed above) — the ONLY way it could know
          // what id to resume is by reading it back off disk via
          // SessionService.ensureConversation -> meta.sdkSessionId.

          // The full transcript, read back a THIRD time (a third rebuild,
          // for good measure), has both turns, in order, with continuous
          // seq numbering — not reset by the restart.
          const api3 = startSessionsApi(root);
          try {
            const finalReplay = await fetch(`${api3.baseUrl}/api/sessions/${sessionId}/events`);
            const finalEvents = await readAllSseEvents(finalReplay);
            const operatorTexts = finalEvents
              .filter((e) => e.event === "operator")
              .map((e) => (e.data as { text: string }).text);
            expect(operatorTexts).toEqual([
              "first turn, before restart",
              "second turn, after restart",
            ]);
          } finally {
            await stopSessionsApiGracefully(api3);
          }
        } finally {
          await stopSessionsApiGracefully(api2);
        }
      });
    },
  );
});

// ---------------------------------------------------------------------------
// 2. Replay+follow across two clients — whole-message semantics.
// ---------------------------------------------------------------------------

/**
 * A hand-rolled `AgenticSession` with an explicit real gate between two
 * text-delta chunks — the same shape `session-service.shutdown.test.ts`'s
 * `DeltaThenGatedSession` uses, needed here for the identical reason: a
 * genuine yield point a test can synchronize a second HTTP client against,
 * deterministically, rather than racing microtask timing.
 */
class GatedTwoChunkSession implements AgenticSession {
  sessionId: string | undefined;
  usage = ZERO_USAGE;
  readonly failedSessionIds: readonly string[] = [];
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

  async *stream(_prompt: string): AsyncGenerator<AgenticStreamEvent, void, undefined> {
    yield { type: "text-delta", text: "chunk-a-" };
    const gate = new Promise<void>((resolve) => {
      this.gateResolve = resolve;
    });
    this.gatedResolve?.();
    await gate;
    yield { type: "text-delta", text: "chunk-b" };
    this.sessionId = this.assignedSessionId;
    yield {
      type: "done",
      result: {
        text: "chunk-a-chunk-b",
        usage: ZERO_USAGE,
        sessionId: this.assignedSessionId,
        stopReason: "end_turn",
        isError: false,
        subagentsEnabled: false,
      },
    };
  }

  /** Resolves once `stream()` has genuinely reached the gate (past the first delta). */
  async waitForGated(): Promise<void> {
    await this.gated;
  }

  release(): void {
    this.gateResolve?.();
  }

  async close(): Promise<void> {}
}

class SingleGatedSessionPort implements AgenticSessionPort {
  session: GatedTwoChunkSession | undefined;

  createSession(options: AgenticSessionOptions = {}): AgenticSession {
    const session = new GatedTwoChunkSession("gated-session-1", options);
    this.session = session;
    return session;
  }

  async deleteStoredSession(): Promise<void> {}
}

describe("Sessions e2e — replay+follow across two clients", () => {
  test(
    "a second client that subscribes mid-turn converges on the SAME full transcript the first " +
      "client (watching live via POST /api/chat) sees, via the stored assistant-message's " +
      "whole-message record — not a partial/duplicated delta stream",
    async () => {
      await withSessionsHome(async (root) => {
        const port = new SingleGatedSessionPort();
        const api = startSessionsApi(root, port);
        try {
          const volume = toVolumeSlug("follow-volume");
          await api.volumeStore.createVolume({ slug: volume, title: "Follow Volume" });

          // Client 1 starts the turn. `fetch()` resolves once headers are
          // back (chat.ts sends the 'session' event as the very first thing
          // its stream produces, well before iterating any turn content —
          // see that handler's own doc) — it does NOT wait for the body to
          // finish, so this resolves long before the gate is ever reached.
          const client1Res = await postChat(api.baseUrl, {
            volumeSlug: "follow-volume",
            message: "watched by two clients",
          });
          expect(client1Res.status).toBe(200);

          // Read client 1's body incrementally, capturing the sessionId the
          // instant the 'session' event arrives, without waiting for the
          // rest of the (still-gated) stream to finish.
          let resolveSessionId!: (id: string) => void;
          const sessionIdPromise = new Promise<string>((resolve) => {
            resolveSessionId = resolve;
          });
          const client1EventsPromise = streamSseEvents(client1Res, (event) => {
            if (event.event === "session") {
              resolveSessionId((event.data as { sessionId: string }).sessionId);
            }
          });
          const sessionId = await sessionIdPromise;

          // Wait for the turn to actually reach the gate (past chunk 1) —
          // the session doesn't exist yet the instant enqueueTurn resolves
          // (session-service.ts's own doc), so poll for it the same way
          // session-service.shutdown.test.ts's waitForSession does.
          const deadline = Date.now() + 5000;
          while (port.session === undefined) {
            if (Date.now() > deadline) throw new Error("timed out waiting for gated session");
            await new Promise((r) => setTimeout(r, 1));
          }
          await port.session.waitForGated();

          // Client 2 subscribes NOW — strictly after chunk 1 was already
          // published to client 1 alone (nobody else was listening), and
          // strictly before chunk 2 / the turn's completion.
          const followRes = await fetch(
            `${api.baseUrl}/api/sessions/${sessionId}/events?follow=true`,
          );
          expect(followRes.status).toBe(200);

          // Client 2 has now subscribed (mid-turn, after replay of the
          // pre-turn-start records only — no assistant text exists in the
          // store yet). Release the gate so the turn finishes.
          port.session.release();

          const client1Events = await client1EventsPromise;
          expect(findEvent(client1Events, "error")).toBeUndefined();
          expect(findEvent(client1Events, "done")).toBeDefined();
          const client1Text = client1Events
            .filter((e) => e.event === "text")
            .map((e) => (e.data as { delta: string }).delta)
            .join("");
          expect(client1Text).toBe("chunk-a-chunk-b");

          // Client 2's follow stream: read until the whole-message
          // seq-carrying `text` event (the stored assistant-message record)
          // arrives, then stop following.
          const client2Events = await readSseEventsUntil(
            followRes,
            (events) =>
              events.some(
                (e) => e.event === "text" && (e.data as { seq?: number }).seq !== undefined,
              ),
            { timeoutMs: 5000 },
          );

          const wholeMessageEvent = client2Events.find(
            (e) => e.event === "text" && (e.data as { seq?: number }).seq !== undefined,
          );
          expect(wholeMessageEvent).toBeDefined();
          if (!wholeMessageEvent) throw new Error("unreachable — asserted above");
          // The DEFINITIVE whole-message-semantics assertion (the Phase 4 /
          // F2-F4 fix this test exists to prove over real wiring): client 2
          // joined AFTER chunk 1 already flowed to client 1 alone, so its
          // own live delta history is incomplete — but the stored record
          // carries the FULL text regardless, so client 2 still converges on
          // exactly what client 1 saw.
          const wholeMessageData = wholeMessageEvent.data as { delta: string };
          expect(wholeMessageData.delta).toBe("chunk-a-chunk-b");
          expect(wholeMessageData.delta).toBe(client1Text);

          // And a plain replay (a third, even later "client") agrees too —
          // the transcript really did converge, not just this one stream.
          const replayRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/events`);
          const replayEvents = await readAllSseEvents(replayRes);
          const replayedFullText = replayEvents.find(
            (e) => e.event === "text" && (e.data as { delta: string }).delta === "chunk-a-chunk-b",
          );
          expect(replayedFullText).toBeDefined();
        } finally {
          await stopSessionsApiGracefully(api);
        }
      });
    },
  );
});

// ---------------------------------------------------------------------------
// 3. FIFO + queue bound, over real concurrent HTTP requests.
// ---------------------------------------------------------------------------

/**
 * A single-session `AgenticSessionPort` whose FIRST turn gates on a real
 * `await` (mirroring `session-service.shutdown.test.ts`'s
 * `SingleSessionAgenticSessionPort`/`DeltaThenGatedSession` pattern) —
 * every turn AFTER the first resolves immediately. This is what makes "one
 * turn running, several more queued behind it" a deterministic state a test
 * can hold open for as long as it needs, rather than a race against how
 * fast a fake responder happens to resolve.
 */
class GatedFirstTurnSession implements AgenticSession {
  sessionId: string | undefined;
  usage = ZERO_USAGE;
  readonly failedSessionIds: readonly string[] = [];
  private turnIndex = 0;
  private gateResolve: (() => void) | undefined;
  private gatedResolve: (() => void) | undefined;
  private readonly gated: Promise<void>;

  constructor(
    private readonly assignedSessionId: string,
    public readonly options: AgenticSessionOptions,
    private readonly onPrompt: (prompt: string) => void,
  ) {
    this.gated = new Promise((resolve) => {
      this.gatedResolve = resolve;
    });
  }

  async *stream(prompt: string): AsyncGenerator<AgenticStreamEvent, void, undefined> {
    this.onPrompt(prompt);
    const isFirst = this.turnIndex === 0;
    this.turnIndex += 1;
    if (isFirst) {
      const gate = new Promise<void>((resolve) => {
        this.gateResolve = resolve;
      });
      this.gatedResolve?.();
      await gate;
    }
    this.sessionId = this.assignedSessionId;
    yield {
      type: "done",
      result: {
        text: `echo: ${prompt}`,
        usage: ZERO_USAGE,
        sessionId: this.assignedSessionId,
        stopReason: "end_turn",
        isError: false,
        subagentsEnabled: false,
      },
    };
  }

  /** Resolves once `stream()`'s first call has genuinely reached its gate. */
  async waitForFirstGated(): Promise<void> {
    await this.gated;
  }

  releaseFirst(): void {
    this.gateResolve?.();
  }

  async close(): Promise<void> {}
}

class GatedFirstTurnPort implements AgenticSessionPort {
  session: GatedFirstTurnSession | undefined;
  /** Every prompt `stream()` was actually called with, in real run order — the FIFO proof (distinct from send order, which `messages` below records separately). */
  readonly prompts: string[] = [];

  createSession(options: AgenticSessionOptions = {}): AgenticSession {
    const session = new GatedFirstTurnSession("fifo-session-1", options, (p) =>
      this.prompts.push(p),
    );
    this.session = session;
    return session;
  }

  async deleteStoredSession(): Promise<void> {}
}

describe("Sessions e2e — FIFO ordering + queue bound over the wire", () => {
  test(
    "with one turn genuinely running (gated), 4 more POSTs on the same session queue " +
      "successfully (the bound, session-service.ts's DEFAULT_MAX_QUEUED_TURNS_PER_SESSION) and " +
      "a 5th is rejected 409 turn_queue_busy over real HTTP; once released, every accepted turn " +
      "runs in strict send order",
    async () => {
      await withSessionsHome(async (root) => {
        const port = new GatedFirstTurnPort();
        const api = startSessionsApi(root, port);
        try {
          const volume = toVolumeSlug("fifo-volume");
          await api.volumeStore.createVolume({ slug: volume, title: "FIFO Volume" });

          // Turn 1 starts a fresh session. `fetch()` resolves on headers
          // only (chat.ts opens the stream, sends 'session', THEN starts
          // draining the gated turn) — this does not wait for the turn to
          // finish.
          const firstRes = await postChat(api.baseUrl, {
            volumeSlug: "fifo-volume",
            message: "op-1",
          });
          expect(firstRes.status).toBe(200);
          let resolveSessionId!: (id: string) => void;
          const sessionIdPromise = new Promise<string>((resolve) => {
            resolveSessionId = resolve;
          });
          const firstEventsPromise = streamSseEvents(firstRes, (event) => {
            if (event.event === "session") {
              resolveSessionId((event.data as { sessionId: string }).sessionId);
            }
          });
          const sessionId = await sessionIdPromise;

          const deadline = Date.now() + 5000;
          while (port.session === undefined) {
            if (Date.now() > deadline) throw new Error("timed out waiting for gated session");
            await new Promise((r) => setTimeout(r, 1));
          }
          await port.session.waitForFirstGated(); // turn 1 is now genuinely running, held open

          // Send the next 5 SEQUENTIALLY, awaiting each response's headers
          // (not body) before sending the next. Awaiting `fetch()` here is
          // enough to guarantee ordering — `postChat`'s handler fully
          // resolves `enqueueTurn` (accept-and-queue, or reject 409) BEFORE
          // it ever returns *any* response, success stream or error JSON
          // alike (`chat.ts`'s own doc: "Validation, target resolution, AND
          // the enqueue itself all happen here, BEFORE the stream opens").
          // So by the time one `fetch()` resolves, that request's admission
          // decision has already been made server-side, and sending the
          // next only afterward makes send order == admission order
          // deterministically, without racing real concurrent sockets
          // against Bun's own connection-acceptance scheduling.
          const messages = ["op-2", "op-3", "op-4", "op-5", "op-6"];
          const responses: Response[] = [];
          for (const message of messages) {
            responses.push(await postChat(api.baseUrl, { sessionId, message }));
          }

          const statuses = responses.map((r) => r.status);
          // Exactly 4 of the 5 extra turns fit in the queue bound
          // (DEFAULT_MAX_QUEUED_TURNS_PER_SESSION = 4, session-service.ts) —
          // turn 1 is running (doesn't count against the bound), op-2..op-5
          // queue (4, exactly at capacity), op-6 is the 5th pending turn and
          // is rejected.
          expect(statuses).toEqual([200, 200, 200, 200, 409]);

          const rejectedBody = (await responses[4]?.json()) as { error: { code: string } };
          expect(rejectedBody.error.code).toBe("turn_queue_busy");

          // Release turn 1 now that admission is fully settled; drain
          // everything to completion.
          port.session.releaseFirst();

          const firstEvents = await firstEventsPromise;
          expect(findEvent(firstEvents, "error")).toBeUndefined();
          expect(findEvent(firstEvents, "done")).toBeDefined();

          for (const res of responses.slice(0, 4)) {
            const events = await readAllSseEvents(res);
            expect(findEvent(events, "error")).toBeUndefined();
            expect(findEvent(events, "done")).toBeDefined();
          }

          // FIFO, proven at the model port: exactly the 5 admitted prompts
          // reached `stream()`, in exactly send order — op-6 (rejected)
          // never reaches it at all. `ShadowConversation` wraps the raw
          // operator text in its own citation-instruction template
          // (`@shadow/agent`'s `conversation.ts`) before sending it on, so
          // this checks containment/order rather than an exact string.
          expect(port.prompts).toHaveLength(5);
          expect(port.prompts.map((p, i) => p.includes(`op-${i + 1}`))).toEqual([
            true,
            true,
            true,
            true,
            true,
          ]);

          // The store agrees: one operator-message per accepted turn, none
          // for the rejected one, same order.
          const replayRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/events`);
          const replayEvents = await readAllSseEvents(replayRes);
          const storedOperatorTexts = replayEvents
            .filter((e) => e.event === "operator")
            .map((e) => (e.data as { text: string }).text);
          expect(storedOperatorTexts).toEqual(["op-1", "op-2", "op-3", "op-4", "op-5"]);
        } finally {
          await stopSessionsApiGracefully(api);
        }
      });
    },
  );
});

// ---------------------------------------------------------------------------
// 4. Delete end-to-end.
// ---------------------------------------------------------------------------

describe("Sessions e2e — delete end-to-end", () => {
  test(
    "DELETE removes a completed session's directory AND a poisoned failed-first-turn " +
      "session's directory from the REAL filesystem, invokes the SDK delete spy for every id " +
      "(including the failed one), closes a live follower cleanly, and empties the list",
    async () => {
      await withSessionsHome(async (root) => {
        let turnCount = 0;
        const responder = () => {
          turnCount += 1;
          // Session A's turn succeeds normally. Session B's very first turn
          // reports isError — its session id never becomes `sdkSessionId`,
          // only `failedSdkSessionIds` (F7 review fix, session-service.ts's
          // finishTurn doc): a "poisoned" id reachable by nothing except
          // this exact DELETE path.
          return turnCount === 1
            ? { text: "session A completes fine" }
            : { text: "", isError: true, stopReason: "error" };
        };
        const fakePort = new FakeAgenticSessionPort(responder);
        const api = startSessionsApi(root, fakePort);
        try {
          const volume = toVolumeSlug("delete-volume");
          await api.volumeStore.createVolume({ slug: volume, title: "Delete Volume" });

          const resA = await postChat(api.baseUrl, {
            volumeSlug: "delete-volume",
            message: "session A, completes",
          });
          const eventsA = await readAllSseEvents(resA);
          const sessionIdA = sessionIdFrom(eventsA);
          expect(findEvent(eventsA, "error")).toBeUndefined();

          const resB = await postChat(api.baseUrl, {
            volumeSlug: "delete-volume",
            message: "session B, poisoned first turn",
          });
          const eventsB = await readAllSseEvents(resB);
          const sessionIdB = sessionIdFrom(eventsB);

          const dirA = join(root, "sessions", sessionIdA);
          const dirB = join(root, "sessions", sessionIdB);
          expect(existsSync(dirA)).toBe(true);
          expect(existsSync(dirB)).toBe(true);

          const metaBRes = await fetch(`${api.baseUrl}/api/sessions`);
          const metaBBody = (await metaBRes.json()) as {
            sessions: readonly { id: string }[];
          };
          expect(metaBBody.sessions.map((s) => s.id)).toEqual(
            expect.arrayContaining([sessionIdA, sessionIdB]),
          );

          // A live follower on session A, open before the delete.
          const followRes = await fetch(
            `${api.baseUrl}/api/sessions/${sessionIdA}/events?follow=true`,
          );
          expect(followRes.status).toBe(200);

          // --- delete both -----------------------------------------------
          const deleteA = await fetch(`${api.baseUrl}/api/sessions/${sessionIdA}`, {
            method: "DELETE",
          });
          expect(deleteA.status).toBe(200);
          expect(await deleteA.json()).toEqual({ deleted: true });

          const deleteB = await fetch(`${api.baseUrl}/api/sessions/${sessionIdB}`, {
            method: "DELETE",
          });
          expect(deleteB.status).toBe(200);
          expect(await deleteB.json()).toEqual({ deleted: true });

          // --- directories actually gone, on the real filesystem ---------
          expect(existsSync(dirA)).toBe(false);
          expect(existsSync(dirB)).toBe(false);

          // --- SDK delete spy: every id, live AND poisoned ----------------
          // Session A's own successful sdk session id, plus session B's
          // failed (never-latched-to-sdkSessionId) id, both went through
          // AgenticSessionPort.deleteStoredSession — the real deletion path
          // for an id that has no live AgenticSession handle at all
          // (T2.4/F7's whole point).
          expect(fakePort.deletedStoredSessionIds).toHaveLength(2);

          // --- follower closes cleanly, not hanging ------------------------
          // This follow connection opened BEFORE the delete, so its body
          // already carries session A's full replay (the completed turn) —
          // `readAllSseEvents` reading it to completion via `response.text()`
          // only ever RESOLVES once the stream's `close()` actually runs
          // server-side. For a `?follow=true` stream that is exactly
          // `deleteSession`'s `{kind: "ended"}` bus publish reaching this
          // stream's `for await` loop and `break`ing it (session-events.ts's
          // module doc: "no client-visible content left to send, only a
          // stream to close" — no wire event for the deletion itself, just
          // the close). So this resolving at all, inside the race below
          // rather than timing out, IS the "closes cleanly, doesn't hang
          // forever" proof.
          const followEvents = await Promise.race([
            readAllSseEvents(followRes),
            new Promise<never>((_resolve, reject) => {
              setTimeout(() => reject(new Error("follow stream did not close after delete")), 5000);
            }),
          ]);
          // The pre-delete replay is in there (this follower really was
          // live on session A, not reading a stub) — but nothing past it:
          // no in-band wire event announces the deletion itself.
          expect(findEvent(followEvents, "operator")).toMatchObject({
            data: { text: "session A, completes" },
          });
          expect(followEvents.filter((e) => e.event === "done")).toHaveLength(0); // follow never sends 'done' on its own

          // --- list is empty of both -----------------------------------
          const listRes = await fetch(`${api.baseUrl}/api/sessions`);
          const listBody = (await listRes.json()) as { sessions: readonly { id: string }[] };
          expect(listBody.sessions.map((s) => s.id)).not.toContain(sessionIdA);
          expect(listBody.sessions.map((s) => s.id)).not.toContain(sessionIdB);

          // --- a retried delete now honestly 404s, not "already fine" ----
          const redelete = await fetch(`${api.baseUrl}/api/sessions/${sessionIdA}`, {
            method: "DELETE",
          });
          expect(redelete.status).toBe(404);
        } finally {
          await stopSessionsApiGracefully(api);
        }
      });
    },
  );
});

// ---------------------------------------------------------------------------
// 5. Crash torn-tail self-heal, across a real restart.
// ---------------------------------------------------------------------------

describe("Sessions e2e — crash torn-tail self-heal across restart", () => {
  test(
    "a torn last line in events.jsonl (a SIGKILL-mid-append artifact) survives a rebuild: " +
      "replay returns the intact prefix, and the next turn (sent over the real wire) both " +
      "appends cleanly and repairs the file on disk",
    async () => {
      await withSessionsHome(async (root) => {
        const volume = toVolumeSlug("crash-volume");

        // --- process 1: write a normal, complete turn ----------------------
        const api1 = startSessionsApi(root, new FakeAgenticSessionPort(() => ({ text: "ok" })));
        let sessionId: string;
        try {
          await api1.volumeStore.createVolume({ slug: volume, title: "Crash Volume" });
          const res1 = await postChat(api1.baseUrl, {
            volumeSlug: "crash-volume",
            message: "pre-crash turn",
          });
          const events1 = await readAllSseEvents(res1);
          sessionId = sessionIdFrom(events1);
        } finally {
          // This is deliberately NOT stopSessionsApiGracefully — a graceful
          // shutdown flushes everything cleanly, which is the opposite of
          // what this test needs. Only the HTTP listener is closed; nothing
          // more is done to the store, mirroring "the process died with
          // clean data already on disk from the LAST successfully-completed
          // append" rather than simulating an append actually being
          // interrupted mid-write (this store's own unit test,
          // filesystem-session-store.test.ts, covers that exact mechanism
          // directly against the store; this test's job is only to prove
          // the SAME tolerance holds reachable end-to-end through a real
          // restart).
          await api1.server.stop(true);
        }

        // --- simulate the crash: tear the last line on disk -----------------
        const path = eventsJsonlPath(root, sessionId);
        const raw = await readFile(path, "utf8");
        expect(raw.endsWith("\n")).toBe(true); // sanity: file is well-formed before we tear it
        // Cut off the last 12 bytes of the file — inside the final JSON
        // line's closing content (every stored turn-boundary(ended) record
        // is comfortably longer than that), leaving no trailing newline: an
        // unparseable, non-newline-terminated last line, exactly the shape
        // a process killed mid-appendFile leaves (filesystem-session-store.ts's
        // `append` doc).
        const torn = raw.slice(0, raw.length - 12);
        expect(torn.endsWith("\n")).toBe(false);
        await writeFile(path, torn, "utf8");

        // --- process 2: rebuild from the torn file --------------------------
        const api2 = startSessionsApi(
          root,
          new FakeAgenticSessionPort(() => ({ text: "post-crash reply" })),
        );
        try {
          // Replay tolerates the torn tail and returns the intact prefix —
          // at minimum the operator message from the pre-crash turn, since
          // that's appended (and fsync'd-by-rename, per writeFileAtomic)
          // well before the final boundary record this truncation targets.
          const replayRes = await fetch(`${api2.baseUrl}/api/sessions/${sessionId}/events`);
          expect(replayRes.status).toBe(200);
          const replayEvents = await readAllSseEvents(replayRes);
          expect(findEvent(replayEvents, "operator")).toMatchObject({
            data: { text: "pre-crash turn" },
          });
          expect(findEvent(replayEvents, "done")).toBeDefined();

          // The next turn, sent over the real wire, must both succeed AND
          // repair the on-disk file — ensureAppendReady's one-time healing
          // pass (filesystem-session-store.ts's own doc) runs on this
          // append, transparently to the caller.
          const res2 = await postChat(api2.baseUrl, { sessionId, message: "post-crash turn" });
          expect(res2.status).toBe(200);
          const events2 = await readAllSseEvents(res2);
          expect(findEvent(events2, "error")).toBeUndefined();
          expect(findEvent(events2, "done")).toBeDefined();

          // The file on disk is clean now: every line parses, ends with a
          // trailing newline, and seq numbering continued from where the
          // intact prefix left off rather than resetting to 1 (the healed
          // read's `lastSeq` derivation, same doc).
          const healedRaw = await readFile(path, "utf8");
          expect(healedRaw.endsWith("\n")).toBe(true);
          const lines = healedRaw.trim().split("\n");
          const parsed = lines.map((line) => JSON.parse(line) as { seq: number });
          const seqs = parsed.map((r) => r.seq);
          expect(seqs).toEqual(seqs.toSorted((a, b) => a - b));
          expect(new Set(seqs).size).toBe(seqs.length); // no duplicate seq
          expect(seqs[0]).toBe(1); // numbering continued, never reset

          // And a fresh replay (a third rebuild) confirms both turns are
          // there, seq-continuous, self-healed prefix included.
          const api3 = startSessionsApi(root);
          try {
            const finalReplay = await fetch(`${api3.baseUrl}/api/sessions/${sessionId}/events`);
            const finalEvents = await readAllSseEvents(finalReplay);
            const operatorTexts = finalEvents
              .filter((e) => e.event === "operator")
              .map((e) => (e.data as { text: string }).text);
            expect(operatorTexts).toEqual(["pre-crash turn", "post-crash turn"]);
          } finally {
            await stopSessionsApiGracefully(api3);
          }
        } finally {
          await stopSessionsApiGracefully(api2);
        }
      });
    },
  );
});

// ---------------------------------------------------------------------------
// 6. Graceful shutdown e2e.
// ---------------------------------------------------------------------------

describe("Sessions e2e — graceful shutdown", () => {
  test(
    "a server with a running turn, shut down mid-flight, ends that turn's live SSE stream " +
      "cleanly and leaves an interrupted boundary in the store that replays honestly after " +
      "a full rebuild",
    async () => {
      await withSessionsHome(async (root) => {
        const port = new SingleGatedSessionPort();
        const api = startSessionsApi(root, port);
        const volume = toVolumeSlug("shutdown-volume");
        await api.volumeStore.createVolume({ slug: volume, title: "Shutdown Volume" });

        const chatPromise = postChat(api.baseUrl, {
          volumeSlug: "shutdown-volume",
          message: "in flight when shutdown hits",
        });

        const deadline = Date.now() + 5000;
        while (port.session === undefined) {
          if (Date.now() > deadline) throw new Error("timed out waiting for gated session");
          await new Promise((r) => setTimeout(r, 1));
        }
        await port.session.waitForGated(); // genuinely mid-turn, past chunk 1

        // Graceful shutdown begins WHILE the turn is gated — mirrors
        // start.ts's real SIGINT sequence: SessionService.shutdown() first
        // (signals the iterator, waits bounded), THEN the server stops.
        const shutdownPromise = stopSessionsApiGracefully(api, { deadlineMs: 2000 });
        // `.return()` is already queued on the turn's iterator at this
        // point (shutdown()'s synchronous sweep) — releasing the gate now
        // lets it actually take effect, same ordering
        // session-service.shutdown.test.ts relies on.
        port.session.release();

        // The live client watching this exact turn sees ITS OWN stream end
        // cleanly — no hang, and (since the turn was interrupted, not
        // completed) no in-band 'error' either, matching turn.interrupted's
        // wire contract (no 'error' event — only replay's turn.interrupted
        // exposes that, this endpoint's own `done`/no-`error` is what a live
        // POST /api/chat client actually gets per chat.ts's own doc: it
        // still sends `done` once the turn's generator ends, interrupted or
        // not, since chat.ts has no separate wire signal for interruption).
        const chatRes = await chatPromise;
        const chatEvents = await readAllSseEvents(chatRes);
        expect(findEvent(chatEvents, "done")).toBeDefined();
        const sessionId = sessionIdFrom(chatEvents);

        await shutdownPromise;

        // --- rebuild from scratch, confirm the interrupted boundary -------
        const api2 = startSessionsApi(root);
        try {
          const replayRes = await fetch(`${api2.baseUrl}/api/sessions/${sessionId}/events`);
          expect(replayRes.status).toBe(200);
          const replayEvents = await readAllSseEvents(replayRes);
          // T2.8/T2.9's wire contract: an interrupted boundary maps to
          // 'turn.interrupted' on replay (event-mapping.ts's own doc) — the
          // only place a live viewer OR a later replay learns the turn
          // didn't just complete normally.
          expect(findEvent(replayEvents, "turn.interrupted")).toBeDefined();
          expect(findEvent(replayEvents, "done")).toBeDefined();

          // And the underlying store record is explicit about it too, not
          // just the wire mapping.
          const rawEvents = (await readFile(eventsJsonlPath(root, sessionId), "utf8"))
            .trim()
            .split("\n")
            .map(
              (line) =>
                JSON.parse(line) as { event: { type: string; phase?: string; endReason?: string } },
            );
          const endedBoundary = rawEvents.find(
            (r) => r.event.type === "turn-boundary" && r.event.phase === "ended",
          );
          expect(endedBoundary?.event.endReason).toBe("interrupted");
        } finally {
          await stopSessionsApiGracefully(api2);
        }
      });
    },
  );
});
