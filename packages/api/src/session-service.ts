/**
 * `SessionService` — T2.5, the structural heart of the Shadow Sessions plan
 * (PLAN.md, Tier 2 intro's refinements 1 and 2). This is the new owner of
 * session lifecycle, replacing direct `ConversationRegistry`/`ShadowAgent`
 * access in handlers (`handlers/chat.ts`).
 *
 * ## What it owns
 *
 * - The `SessionStore` (`@shadow/sessions`) — the transcript of record.
 * - A `ConversationRegistry` (demoted to a cache of live handles — refinement
 *   1: "sessions are entities; turns are jobs." The in-memory
 *   `ShadowConversation` is never the identity, only a cache entry the
 *   store's row outlives).
 * - A `SessionLock` (`session-lock.ts`), one per session id, serializing
 *   *everything* stateful against that id — turns and rehydration alike.
 *   This is the only same-session write path (refinement 2), which is what
 *   makes concurrent `POST /api/chat` calls on one session safe: two
 *   `AgenticSession.stream()` calls resuming the same SDK session id from
 *   two subprocesses would corrupt one transcript; the lock makes that
 *   unrepresentable, full stop, not just unlikely.
 * - A `SessionEventBus` (`session-bus.ts`) — the per-session fan-out point
 *   every viewer (today: `handlers/chat.ts`, "the first viewer of the turn
 *   it enqueued"; later: T2.7's replay+follow) subscribes to.
 *
 * ## The turn does not stop when viewers detach
 *
 * `enqueueTurn`'s returned `events` generator is a *view* onto a turn that
 * runs to completion regardless of who's watching — `runTurn` below never
 * checks whether anyone is subscribed before appending or publishing.
 * Cancelling the generator (`.return()`, a `for await` `break`, or an SSE
 * response's `cancel()`) only unsubscribes that one viewer from the bus; the
 * turn's own draining loop, and the store appends it produces, are
 * untouched. This is what makes "survive a page reload mid-turn" true: the
 * next `GET .../events?follow=true` (T2.7) picks the turn back up from the
 * store + a fresh bus subscription, not from anything this generator held.
 *
 * ## Single-flighted rehydration
 *
 * A session with no live `ConversationRegistry` entry (evicted, or cold
 * after a server restart) gets rehydrated by `ensureConversation`, called
 * from *inside* `runTurn` — i.e. inside the same per-session lock every turn
 * already goes through. Two concurrent `POST /api/chat` calls for the same
 * cold session both pass `enqueueTurn`'s pre-check (registry miss, store
 * hit) and both get queued on the lock; only the first one to actually run
 * calls `ensureConversation` while the registry is still empty, constructs
 * one `ShadowConversation`, and registers it — the second one's turn, queued
 * strictly behind the first by the same lock, finds a warm registry entry
 * when its turn comes and never rehydrates at all. One construction, both
 * turns run FIFO — exactly PLAN.md's "concurrent first messages to a cold
 * session" row.
 */

import { randomUUID } from "node:crypto";
import type {
  ShadowAgent,
  ShadowConversation,
  ShadowEvent,
  StartConversationOptions,
} from "@shadow/agent";
import type { VolumeSlug } from "@shadow/core";
import type { AgenticSessionPort } from "@shadow/model";
import type {
  SessionListFilter,
  SessionMeta,
  SessionMetaPatch,
  SessionStore,
  StoredEventRecord,
  StoredSessionEvent,
  TurnBoundaryEndReason,
} from "@shadow/sessions";
import { ConversationRegistry, type ConversationRegistryOptions } from "./conversation-registry.ts";
import { toErrorResponse } from "./error-mapping.ts";
import {
  ServiceShuttingDownError,
  SessionBusyError,
  SessionNotFoundError,
  TurnQueueBusyError,
} from "./errors.ts";
import {
  operatorMessageEvent,
  StoredEventStamper,
  turnBoundaryEnded,
  turnBoundaryStarted,
} from "./event-mapping.ts";
import { PushChannel, type SessionBusMessage, SessionEventBus } from "./session-bus.ts";
import { SessionLock } from "./session-lock.ts";

/** `enqueueTurn`'s target: resume an existing session, or start a fresh one on `volume`. */
export type EnqueueTarget = { readonly sessionId: string } | { readonly volume: VolumeSlug };

/** Bound on FIFO-queued (not yet running) turns per session, per PLAN.md's Tier 2 concurrency model — "queue bound: 4 pending." */
export const DEFAULT_MAX_QUEUED_TURNS_PER_SESSION = 4;

/** Last 12 operator/assistant messages, per PLAN.md's T2.5 entry ("deterministic, no LLM call"). */
const FALLBACK_SUMMARY_MAX_MESSAGES = 12;
/** Per-message clip length, same source. */
const FALLBACK_SUMMARY_CLIP_LENGTH = 500;
/** The "fixed header" PLAN.md's T2.5 entry requires — exported so tests can pin the exact format without duplicating the literal string. */
export const FALLBACK_SUMMARY_HEADER =
  "Summary of the most recent messages from a previous conversation " +
  "(recovered because its transcript could not be resumed):";

/** First operator message's first line, clipped — T3.1's default-title rule, implemented here (at first-turn time) per this task's instruction; T3.1 layers `PATCH` override on top. */
const DEFAULT_TITLE_MAX_LENGTH = 60;

function clip(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function defaultTitleFrom(operatorText: string): string {
  const firstLine = (operatorText.split("\n")[0] ?? "").trim();
  return clip(firstLine, DEFAULT_TITLE_MAX_LENGTH);
}

/** What `enqueueTurn` hands back — everything `handlers/chat.ts` needs to answer its own `POST /api/chat` before the turn has necessarily even started running. */
export interface EnqueuedTurn {
  /** Stable from the moment `enqueueTurn` resolves, before this turn (or any turn queued ahead of it) has run — what the wire `session` SSE event carries. */
  readonly sessionId: string;
  /** This turn's id — scopes the stamped `briefId`s the tee assigns, and is stamped onto every `StoredEventRecord`/`text-delta` this turn produces (`@shadow/sessions`' `StoredEventRecord.turnId`). */
  readonly turnId: string;
  /**
   * This turn's own wire-shape events, live, in production order — text
   * deltas pass through untouched, everything else arrives as the stored
   * shape a caller can run through `event-mapping.ts`'s `wireEventsForLive`.
   * Cancelling this generator (`.return()`, a `for await` `break`) only
   * unsubscribes from the session bus; the turn itself keeps draining
   * server-side regardless (this module's doc). Ends once this turn's own
   * `turn-boundary(ended, …)` record has been delivered.
   */
  readonly events: AsyncGenerator<SessionBusMessage, void, undefined>;
}

export interface SessionServiceDeps {
  readonly store: SessionStore;
  readonly shadowAgent: ShadowAgent;
  /**
   * The model-layer port whose `deleteStoredSession(sdkSessionId)` (T2.4) is
   * `deleteSession`'s (T3.1) only way to remove an SDK transcript that has
   * no live `AgenticSession` handle — a cold session, or a failed-first-turn
   * id in `SessionMeta.failedSdkSessionIds` (F7 review fix), neither of
   * which any `ShadowConversation` this service holds can reach. The SAME
   * port instance `shadowAgent` was constructed with (`composition.ts`),
   * threaded here directly rather than reached through `ShadowAgent` — that
   * class exposes only volume/reindex locking (`withVolumeLock`/
   * `withReindexLock`), not the model port itself, and adding a
   * passthrough there for one caller's sake would widen its surface for no
   * reason beyond this constructor's own convenience.
   */
  readonly agenticSessionPort: AgenticSessionPort;
}

export interface SessionServiceOptions {
  /** Forwarded to the internal `ConversationRegistry`'s `maxSize`. @default 50 (that class's own default). */
  readonly registryMaxSize?: ConversationRegistryOptions["maxSize"];
  /** @default `DEFAULT_MAX_QUEUED_TURNS_PER_SESSION` (4). */
  readonly maxQueuedTurnsPerSession?: number;
}

/** Drains an already-subscribed `PushChannel`, unsubscribing on any exit path (normal completion, `.return()`, or an exception propagating through `for await`). Kept as a free function rather than a private method so `enqueueTurn` can subscribe *before* handing back the generator — see `session-lock.ts`'s module doc for why that ordering matters. */
async function* drainChannel<T>(
  channel: PushChannel<T>,
  unsubscribe: () => void,
): AsyncGenerator<T, void, undefined> {
  try {
    for await (const message of channel) {
      yield message;
    }
  } finally {
    unsubscribe();
  }
}

function isTurnEndedRecord(message: SessionBusMessage): boolean {
  return (
    message.kind === "record" &&
    message.record.event.type === "turn-boundary" &&
    message.record.event.phase === "ended"
  );
}

/**
 * `SessionService.shutdown`'s wind-down bound (T2.9's "~10s deadline") —
 * PLAN.md's T2.9 entry: "bounded by a ~10s deadline after which it exits
 * anyway (the torn-tail read tolerance from T2.1 is the backstop, not the
 * norm)." Injectable per call (`shutdown({ deadlineMs })`) so tests don't
 * need a real 10-second wait to exercise the deadline-exceeded path.
 */
export const DEFAULT_SHUTDOWN_DEADLINE_MS = 10_000;

/**
 * Resolves once `promise` settles OR `deadlineMs` elapses, whichever comes
 * first — never rejects, never waits past the deadline. `shutdown`'s only
 * use of this: waiting for in-flight turns to wind down is a best-effort
 * courtesy, not something a hung turn (T2.9's "refuses to wind down" case —
 * an internal await that never resolves, e.g. a subprocess that never exits)
 * gets to hold the whole process hostage over.
 */
function raceWithDeadline(promise: Promise<unknown>, deadlineMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deadlineMs);
  });
  // `.then(() => undefined, () => undefined)` — this method's own contract
  // ("never rejects") applies even if `promise` itself rejects (shouldn't
  // happen; `runTurn` never throws — see that method's doc — but defended
  // here anyway since a hung/rejected turn is exactly the case this
  // function exists to not get stuck on).
  return Promise.race([
    promise.then(
      () => undefined,
      () => undefined,
    ),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

export class SessionService {
  private readonly store: SessionStore;
  private readonly shadowAgent: ShadowAgent;
  private readonly agenticSessionPort: AgenticSessionPort;
  private readonly lock = new SessionLock();
  private readonly bus = new SessionEventBus();
  private readonly maxQueuedTurnsPerSession: number;

  /**
   * `true` from the first `shutdown()` call onward — checked synchronously,
   * as the very first thing, by both `enqueueTurn` (new turns get
   * `ServiceShuttingDownError`, 503) and `runTurn` (a turn `tryReserve`d
   * before shutdown began but not yet running when its turn in the FIFO
   * comes up is dropped cleanly instead of starting — T2.9's extension of
   * the "crash while queued" row to the graceful path). Never reset: once a
   * `SessionService` starts shutting down, it stays shut down.
   */
  private shuttingDown = false;
  /**
   * Every currently-running turn's own `conversation.sendMessage()`
   * iterator, keyed by `turnId` — registered the instant `runTurn` creates
   * it (before draining starts), removed the instant draining ends (however
   * it ends). `shutdown()`'s "signal running turns to wind down" step
   * (PLAN.md's T2.9 entry) is exactly `iterator.return()` on every value
   * here.
   */
  private readonly activeIterators = new Map<
    string,
    AsyncGenerator<ShadowEvent, void, undefined>
  >();
  /**
   * `turnId`s `shutdown()` has called `.return()` on — consulted (and
   * cleared) by `runTurn`'s own `finally` to decide `endReason:
   * "interrupted"` vs `"completed"`. Needed because native async-generator
   * `.return()` semantics don't themselves distinguish "the caller asked me
   * to stop" from "I was going to end here anyway" — from `runTurn`'s
   * `for await` loop's point of view, both look like the loop simply ending
   * without a thrown exception. This set is what makes that distinction.
   */
  private readonly interruptedTurnIds = new Set<string>();
  /**
   * Every turn's own settlement promise (`SessionLock.runReserved`'s return
   * value), from the moment `enqueueTurn` reserves it — running *or* still
   * queued — removed once it settles. `shutdown()`'s deadline race waits on
   * a snapshot of this set: everything reserved at the moment `shutdown()`
   * was called, whether it's the one turn currently draining or three more
   * still queued behind it in the same session's FIFO.
   */
  private readonly inFlightTurns = new Set<Promise<void>>();

  /**
   * The cache of live `ShadowConversation` handles (T2.4's demoted
   * registry). Exposed (not private) because two existing callers still
   * need it directly: `start.ts`'s shutdown path (`releaseAll()`) and
   * `ApiDeps.conversations`, kept for backward compatibility with code that
   * predates this class — both point at this exact instance, not a copy.
   */
  readonly registry: ConversationRegistry;

  constructor(deps: SessionServiceDeps, options: SessionServiceOptions = {}) {
    this.store = deps.store;
    this.shadowAgent = deps.shadowAgent;
    this.agenticSessionPort = deps.agenticSessionPort;
    this.maxQueuedTurnsPerSession =
      options.maxQueuedTurnsPerSession ?? DEFAULT_MAX_QUEUED_TURNS_PER_SESSION;
    // `isSessionBusy` closes over `this.lock` by reference, not by value —
    // safe even though `this.lock` is a field on the same object being
    // constructed, because the closure is only ever *invoked* later
    // (`ConversationRegistry.evict()`), well after this constructor and
    // every field assignment in it has finished.
    this.registry = new ConversationRegistry({
      maxSize: options.registryMaxSize,
      isSessionBusy: (sessionId) => this.lock.hasActivity(sessionId),
    });
  }

  /**
   * Enqueue one operator turn. Resolves once the turn has either been
   * accepted into its session's FIFO queue or rejected outright — it does
   * NOT wait for the turn to run, let alone finish; that happens in the
   * background, observed (optionally) via the returned `events` generator.
   *
   * Rejections happen synchronously relative to this call (no turn is ever
   * partially started): `ServiceShuttingDownError` (503) once `shutdown()`
   * has begun (T2.9 — checked first, before touching the store at all),
   * `SessionNotFoundError` (404) if `target.sessionId` is absent from both
   * the registry and the store, `TurnQueueBusyError` (409) if that session
   * already has `maxQueuedTurnsPerSession` turns queued ahead of this one.
   * All three are typed `ShadowApiError`s (`errors.ts`) — `error-mapping.ts`
   * needs no new table row for any of them: its `error instanceof
   * ShadowApiError` branch already maps a subclass's own `status`/`code`
   * fields generically, which is why this task's "add the error-mapping row
   * now, or leave for T3.1" decision resolves to *neither* — there is no row
   * to add.
   */
  async enqueueTurn(target: EnqueueTarget, message: string): Promise<EnqueuedTurn> {
    if (this.shuttingDown) {
      throw new ServiceShuttingDownError();
    }

    const resolved = await this.resolveSessionId(target);
    const sessionId = resolved.sessionId;

    // Synchronous check-and-reserve (`session-lock.ts`'s module doc) —
    // nothing awaits between resolving `sessionId` above and this call that
    // could let a second `enqueueTurn` interleave and slip past the bound.
    if (!this.lock.tryReserve(sessionId, this.maxQueuedTurnsPerSession)) {
      throw new TurnQueueBusyError(sessionId);
    }

    const turnId = randomUUID();
    const channel = new PushChannel<SessionBusMessage>();
    // Subscribed BEFORE `runReserved` is even called, so the very first
    // record this turn appends (`operator-message`, at run start) can never
    // be published to a bus nobody is listening to yet — see
    // `session-lock.ts`'s module doc for why `tryReserve`/`runReserved` are
    // two calls instead of one, specifically to make this ordering possible.
    const unsubscribe = this.bus.subscribe(sessionId, (published) => {
      // `"ended"` (T3.1: the session was deleted) never belongs to a
      // specific turn — and can't reach a still-live per-turn subscription
      // in practice anyway, since `deleteSession` 409s while any turn is
      // running or queued (`SessionBusyError`); this channel's own turn will
      // already have unsubscribed via `isTurnEndedRecord` below by the time
      // a delete could ever succeed. Filtered out defensively regardless,
      // rather than assumed unreachable.
      const belongsToThisTurn =
        published.kind === "text-delta"
          ? published.turnId === turnId
          : published.kind === "record" && published.record.turnId === turnId;
      if (!belongsToThisTurn) return;
      channel.push(published);
      if (isTurnEndedRecord(published)) {
        channel.end();
      }
    });

    const settled = this.lock.runReserved(sessionId, () =>
      this.runTurn(sessionId, turnId, message, resolved.pendingVolume),
    );
    // Tracked from reservation (running *or* still queued) until settlement
    // — `shutdown()`'s deadline race waits on a snapshot of this set (T2.9).
    this.inFlightTurns.add(settled);
    // Re-run eviction once this turn's lock hold fully releases (i.e. once
    // `hasActivity(sessionId)` can honestly flip to `false` for it) — a
    // session another turn's eviction pass skipped for being busy gets
    // released the moment it's safe, per `ConversationRegistry.evict()`'s
    // doc, rather than waiting for some unrelated `set()` to retrigger it.
    // `runTurn` itself never throws (see that method's doc), but this
    // `catch` is defense-in-depth against an unhandled rejection regardless.
    void settled
      .finally(() => {
        this.registry.evict();
        this.inFlightTurns.delete(settled);
      })
      .catch(() => {});

    return { sessionId, turnId, events: drainChannel(channel, unsubscribe) };
  }

  /**
   * Resolves `target` to a session id — for `{sessionId}`, validates it
   * exists somewhere (registry or store) WITHOUT rehydrating it yet
   * (rehydration only ever happens inside the per-session lock,
   * `ensureConversation`, called from `runTurn`); for `{volume}`, mints a
   * FRESH id synchronously (`randomUUID()` — no other caller could possibly
   * already know it) but does NOT create its store row here any more.
   *
   * **F8 review fix.** This used to create the row for a `{volume}` target
   * right here, unconditionally — an `await this.store.create(...)` call
   * OUTSIDE the per-session lock and, crucially, outside `runTurn`'s own
   * `shuttingDown` re-check. A `{volume}` enqueue that raced a concurrent
   * `shutdown()` landing in that `await` gap would have this call finish
   * creating the row regardless, then have `runTurn`'s early-return (T2.9's
   * "queued turn dropped cleanly" check, at the top of that method) drop the
   * turn without ever appending anything to it — leaving a permanent,
   * zero-event "phantom" session row behind: a session that exists forever,
   * with nothing in it, dropped from a list view. Deferring the actual
   * `store.create` into `runTurn`, immediately after (no `await` in
   * between) the SAME `shuttingDown` check that guards everything else that
   * method writes, closes the gap structurally: the row is now created only
   * once that check has ALREADY passed, atomically, with no window for a
   * later `shutdown()` to land in between "checked" and "created."
   */
  private async resolveSessionId(
    target: EnqueueTarget,
  ): Promise<{ readonly sessionId: string; readonly pendingVolume?: VolumeSlug }> {
    if ("volume" in target) {
      return { sessionId: randomUUID(), pendingVolume: target.volume };
    }
    const { sessionId } = target;
    if (this.registry.get(sessionId)) {
      return { sessionId };
    }
    const meta = await this.store.get(sessionId);
    if (!meta) {
      throw new SessionNotFoundError(sessionId);
    }
    return { sessionId };
  }

  /**
   * Runs one turn end to end: append `operator-message` + `turn-boundary
   * (started)` at run start (not at enqueue — PLAN.md's "a queued turn must
   * not interleave its records into the running turn's seq range, and a
   * crash while queued should lose the queued message cleanly"), drain
   * `conversation.sendMessage()` teeing every stored-shape event to the
   * store and bus, then append `turn-boundary(ended, …)` in a `finally`.
   *
   * **Dropped cleanly if shutdown began before this turn ever started
   * running (T2.9).** `tryReserve`d turns queued behind a currently-running
   * one reach this method only once the `SessionLock` FIFO gets to them —
   * possibly well after `shutdown()` set `shuttingDown`. The check below is
   * the graceful-path twin of PLAN.md's "server crash with a turn queued"
   * row: nothing has been appended for this turn yet (operator-message is
   * the *first* thing this method would otherwise write), so returning here
   * leaves genuinely nothing behind — no operator-message, no boundary, no
   * meta touch.
   *
   * Never lets an exception escape: every failure this method can observe —
   * `ensureConversation` throwing, `conversation.sendMessage()` throwing —
   * is caught and folded into the `turn-boundary(ended, "error", …)` record
   * instead, because this method's return value is not awaited by its
   * caller in any way that would observe a rejection (`enqueueTurn` only
   * chains `.finally` off it for eviction bookkeeping) — the turn's outcome
   * is communicated entirely through the store/bus, not through this
   * method's own promise.
   */
  private async runTurn(
    sessionId: string,
    turnId: string,
    operatorText: string,
    pendingVolume?: VolumeSlug,
  ): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    let endReason: TurnBoundaryEndReason = "completed";
    let errorInfo: { message: string; code: string } | undefined;
    let conversation: ShadowConversation | undefined;
    let priorTitle: string | null = null;
    let priorFailedSdkSessionIds: readonly string[] = [];

    try {
      // F8 review fix: the store row for a fresh `{volume}` target is
      // created HERE, immediately after the `shuttingDown` check above with
      // no `await` in between — not in `resolveSessionId` any more (that
      // method's own doc has the full story on the phantom-row race this
      // closes). `pendingVolume` is `undefined` for a `{sessionId}` target,
      // whose row already exists (`resolveSessionId` already validated it).
      if (pendingVolume !== undefined) {
        const now = new Date().toISOString();
        await this.store.create({
          id: sessionId,
          volume: pendingVolume,
          title: null,
          createdAt: now,
          lastActiveAt: now,
        });
      }

      const ensured = await this.ensureConversation(sessionId);
      conversation = ensured.conversation;
      priorTitle = ensured.meta.title;
      priorFailedSdkSessionIds = ensured.meta.failedSdkSessionIds ?? [];

      await this.appendAndPublish(sessionId, turnId, operatorMessageEvent(operatorText));
      await this.appendAndPublish(sessionId, turnId, turnBoundaryStarted());

      const stamper = new StoredEventStamper(turnId);
      // Held explicitly (not just looped over via `for await`) so
      // `shutdown()` — running concurrently, on a different call stack —
      // can reach this exact turn's iterator and call `.return()` on it
      // (T2.9's interruption seam: "the generator's finally blocks and the
      // service's finally still run" — `.return()` unwinds
      // `ShadowConversation.sendMessage`'s own `try/finally` at whatever
      // yield point it next reaches, same as any other generator
      // early-exit). Registered before draining starts and removed the
      // instant draining ends, however it ends.
      const iterator = conversation.sendMessage(operatorText);
      this.activeIterators.set(turnId, iterator);
      if (this.shuttingDown) {
        // Shutdown began in the narrow window between the top-of-method
        // check and here (inside `ensureConversation`/the two boundary
        // appends above) — `shutdown()`'s own sweep already ran and never
        // saw this iterator, so signal it right away instead of letting a
        // turn shutdown meant to interrupt run to completion unchecked.
        this.interruptedTurnIds.add(turnId);
        void iterator.return(undefined).catch(() => {});
      }
      try {
        for await (const event of iterator) {
          if (event.type === "text-delta") {
            // No stored shape at all (`@shadow/sessions` never persists
            // deltas) — published straight to the bus, never appended.
            this.bus.publish(sessionId, { kind: "text-delta", turnId, text: event.text });
            continue;
          }
          await this.appendAndPublish(sessionId, turnId, stamper.stampAgentEvent(event));
        }
      } finally {
        this.activeIterators.delete(turnId);
      }
    } catch (error) {
      endReason = "error";
      const mapped = toErrorResponse(error);
      errorInfo = { message: mapped.body.error.message, code: mapped.body.error.code };
    } finally {
      // Consulted (and cleared) regardless of how the try block above
      // ended: a `for await` loop that stops because `.return()` was called
      // on its iterator exits *without* throwing — from this method's own
      // point of view that's indistinguishable from a turn that simply had
      // nothing left to say, which is exactly why `shutdown()` has to leave
      // a separate breadcrumb (`interruptedTurnIds`) for `runTurn` to check.
      // An error takes precedence if both happened (e.g. the interrupted
      // generator's own cleanup threw): the boundary's error content is
      // more informative than a bare "interrupted" would be.
      const wasInterrupted = this.interruptedTurnIds.delete(turnId);
      if (wasInterrupted && endReason !== "error") {
        endReason = "interrupted";
      }
      await this.finishTurn(
        sessionId,
        turnId,
        conversation,
        priorTitle,
        priorFailedSdkSessionIds,
        operatorText,
        endReason,
        errorInfo,
      );
    }
  }

  /**
   * The `finally` half of `runTurn`: append the closing boundary, update
   * session meta — including, as of F7 (T3.1), merging in any SDK session
   * ids this turn's conversation handle reported as failed — and make sure
   * this turn's bus subscribers are guaranteed to terminate even if the
   * boundary append itself fails.
   */
  private async finishTurn(
    sessionId: string,
    turnId: string,
    conversation: ShadowConversation | undefined,
    priorTitle: string | null,
    priorFailedSdkSessionIds: readonly string[],
    operatorText: string,
    endReason: TurnBoundaryEndReason,
    errorInfo: { message: string; code: string } | undefined,
  ): Promise<void> {
    const boundary =
      endReason === "error"
        ? turnBoundaryEnded(
            "error",
            errorInfo ?? { message: "unknown error", code: "internal_error" },
          )
        : turnBoundaryEnded(endReason);
    try {
      await this.appendAndPublish(sessionId, turnId, boundary);
    } catch {
      // The session row is gone — shouldn't happen in Tier 2's scope
      // (deletion is T3.1's job), but if it ever does, there is nothing left
      // to record it against. Publish a synthetic, unstored terminal record
      // directly so any subscriber (this turn's own enqueuer included) is
      // still guaranteed to see its channel end, rather than hanging
      // forever waiting for a boundary that can never arrive. `seq: -1`
      // marks it as never-really-appended — no real record ever carries a
      // non-positive `seq` (`@shadow/sessions`' `SessionStore.append` doc).
      this.bus.publish(sessionId, {
        kind: "record",
        record: { seq: -1, turnId, at: new Date().toISOString(), event: boundary },
      });
    }

    if (!conversation) return; // ensureConversation itself failed — no meta to touch.

    // F7 review fix (T3.1): merge in any SDK session ids this turn's
    // conversation handle now reports as failed — most notably a failed
    // FIRST turn's `isError` result id, which never becomes `sdkSessionId`
    // (that field is written only from a successful `conversation.sessionId`
    // below) and is therefore otherwise unreachable by anything, including
    // `DELETE /api/sessions/:id`. `ShadowConversation.failedSdkSessionIds` is
    // a live read of the underlying handle's own tracking (`@shadow/model`'s
    // `AgenticSession.failedSessionIds`), not turn-scoped — union with the
    // meta's prior value (a `Set`, so idempotent across repeated turns on
    // the same handle) rather than replacing it, since an earlier turn's
    // failed id must never be forgotten just because this turn didn't fail.
    // Only patched when something is actually new, to avoid a no-op write on
    // every ordinary successful turn.
    const mergedFailedSdkSessionIds = new Set([
      ...priorFailedSdkSessionIds,
      ...conversation.failedSdkSessionIds,
    ]);
    const failedSdkSessionIds: readonly string[] | undefined =
      mergedFailedSdkSessionIds.size > priorFailedSdkSessionIds.length
        ? [...mergedFailedSdkSessionIds]
        : undefined;

    const patch: SessionMetaPatch = {
      lastActiveAt: new Date().toISOString(),
      // Written on first-turn completion, and again — overwriting the dead
      // id — after a successful fallback rebuild: `conversation.sessionId`
      // reflects whichever underlying `AgenticSession` is live right now
      // (`@shadow/agent`'s `ShadowConversation.sessionId` doc), so this is
      // correct either way without this method needing to know which case
      // it is. `undefined` here means "don't touch it" (`SessionMetaPatch`'s
      // doc), which is exactly right before the first turn ever completes.
      sdkSessionId: conversation.sessionId,
      // Only the very first turn (still-null title) sets a default; T3.1's
      // `PATCH` override is the only other writer of this field.
      title: priorTitle === null ? defaultTitleFrom(operatorText) : undefined,
      failedSdkSessionIds,
    };
    try {
      await this.store.update(sessionId, patch);
    } catch {
      // Same "session row gone" defense as the boundary append above.
    }
  }

  /** Appends one event to the store and publishes the resulting `seq`-stamped record to the bus, in that order — "post-append," per PLAN.md, so bus consumers can trust every delivered record's `seq` is already durable. */
  private async appendAndPublish(
    sessionId: string,
    turnId: string,
    event: StoredSessionEvent,
  ): Promise<void> {
    const [record] = await this.store.append(sessionId, [
      { turnId, at: new Date().toISOString(), event },
    ]);
    if (!record) return; // `append([one event])` always returns one record; defensive only.
    this.bus.publish(sessionId, { kind: "record", record });
  }

  /**
   * Returns `sessionId`'s live `ShadowConversation`, from the registry if
   * present, otherwise constructing (and registering) one — the rehydration
   * path (PLAN.md's T2.5 entry). Always called from inside `runTurn`, itself
   * always called from inside `SessionLock.runReserved` — see this module's
   * doc for why that makes rehydration single-flighted for free, with no
   * separate locking of its own.
   */
  private async ensureConversation(
    sessionId: string,
  ): Promise<{ conversation: ShadowConversation; meta: SessionMeta }> {
    const cached = this.registry.get(sessionId);
    const meta = await this.store.get(sessionId);
    if (!meta) {
      throw new SessionNotFoundError(sessionId);
    }
    if (cached) {
      return { conversation: cached, meta };
    }

    let resume: StartConversationOptions["resume"];
    if (meta.sdkSessionId !== undefined) {
      // A real prior turn completed and left an SDK session id behind —
      // genuine rehydration. `meta.sdkSessionId === undefined` (a brand new
      // session, or a cold one whose first turn never completed) starts
      // WITHOUT resume instead, per PLAN.md's T2.5 entry.
      resume = {
        sdkSessionId: meta.sdkSessionId,
        fallbackSummary: await this.buildFallbackSummary(sessionId),
      };
    }

    const conversation = this.shadowAgent.startConversation(meta.volume, {
      conversationId: sessionId,
      resume,
    });
    this.registry.set(sessionId, conversation);
    return { conversation, meta };
  }

  /**
   * Whether `sessionId` is known to this service — present in the registry
   * (a live handle) OR the store (on disk, cold or warm) — WITHOUT
   * rehydrating it. T2.7's replay+follow endpoint uses this for its 404
   * check: PLAN.md's T2.7 entry is explicit that "replay is read-only;
   * rehydration happens on the next turn," so this deliberately mirrors
   * `resolveSessionId`'s registry-then-store existence check rather than
   * `ensureConversation`'s (which constructs a conversation on a miss).
   * A registry hit already implies a store hit (nothing ever registers a
   * conversation without first confirming its store row exists —
   * `ensureConversation`'s own doc) — checked separately anyway so this
   * reads as the same existence contract every other entry point uses,
   * not a proof obligation callers have to trust.
   */
  async hasSession(sessionId: string): Promise<boolean> {
    if (this.registry.get(sessionId)) return true;
    return (await this.store.get(sessionId)) !== undefined;
  }

  /**
   * Graceful shutdown (T2.9, PLAN.md's Tier 2 entry and the failure table's
   * "SIGINT with a turn running" row). `start.ts` calls this from its
   * SIGINT/SIGTERM handler, ahead of `server.stop()`; tests call it directly
   * with a small `deadlineMs` to exercise the wind-down and deadline paths
   * without a real ~10s wait.
   *
   * Once turns can outlive the request that started them (T2.5), the old
   * SIGINT path — release handles, stop the server, exit — would hard-kill
   * an SDK subprocess mid-turn and tear a `store.append` mid-write, turning
   * *every* Ctrl-C during a turn into the crash path. The sequence here
   * instead:
   *
   * 1. **Stop accepting turns.** `this.shuttingDown = true`, set
   *    synchronously as the very first statement — `enqueueTurn` checks the
   *    same flag as *its* first statement, so no new turn can be accepted
   *    after this point (JS's single-threaded execution rules out a race
   *    between the two checks).
   * 2. **Signal running turns to wind down.** `iterator.return()` on every
   *    currently-draining turn's own `conversation.sendMessage()` generator
   *    (`activeIterators`) — queued behind whatever internal work is
   *    already in flight if the generator isn't idle right now (native
   *    async-generator semantics: a `.return()` call made while a `.next()`
   *    is still being processed is queued, not applied immediately), taking
   *    effect the moment the generator next reaches a suspend point. This
   *    is "the turn stops at its next yield point," not instantly — an
   *    in-flight model round genuinely has to finish before the generator
   *    can unwind through its own `try/finally`.
   * 3. **`turn-boundary(ended, interrupted)`, flush appends, release
   *    handles.** `runTurn`'s own `finally` (unchanged code path — it runs
   *    exactly the same whether the loop ended on its own or because
   *    `.return()` was called) is what actually appends the boundary and
   *    updates meta; this method only waits for that to happen
   *    (`inFlightTurns`) before calling `this.registry.releaseAll()` —
   *    T2.4's `release()`, not delete: nothing on disk is touched, every SDK
   *    transcript stays resumable next launch (D6b).
   * 4. **Bounded by `deadlineMs`.** A turn stuck on an internal await that
   *    never resolves (a wedged subprocess, say) would otherwise hold
   *    `shutdown()` open forever — PLAN.md's own words: "bounded by a ~10s
   *    deadline after which it exits anyway (the torn-tail read tolerance
   *    from T2.1 is the backstop, not the norm)." `raceWithDeadline` is what
   *    enforces that; a turn abandoned this way is simply never marked
   *    `interrupted` — the store shows an opened-but-never-closed turn,
   *    which is exactly the torn-tail shape T2.1's `readEvents` already
   *    tolerates on read.
   *
   * A turn `tryReserve`d but not yet running when `shutdown()` is called
   * gets neither of steps 2/3 — it has no iterator yet — but IS in
   * `inFlightTurns`, so this method still waits (bounded) for it to either
   * settle via `runTurn`'s own top-of-method `shuttingDown` check (drops
   * cleanly, no records — T2.9's extension of "crash while queued" to the
   * graceful path) or hit the deadline alongside everything else.
   *
   * Idempotent enough to call more than once (a second SIGINT arriving
   * before the first finishes winding down, say): `shuttingDown` is already
   * `true`, `activeIterators`/`inFlightTurns` simply reflect whatever's
   * still outstanding, and `releaseAll()` on an empty/already-released
   * registry is a no-op.
   */
  async shutdown(options: { readonly deadlineMs?: number } = {}): Promise<void> {
    const deadlineMs = options.deadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS;
    this.shuttingDown = true;

    for (const [turnId, iterator] of this.activeIterators) {
      this.interruptedTurnIds.add(turnId);
      void iterator.return(undefined).catch(() => {});
    }

    await raceWithDeadline(Promise.allSettled(this.inFlightTurns), deadlineMs);

    await this.registry.releaseAll();
  }

  /**
   * The stored transcript from `fromSeq` onward (inclusive — see
   * `SessionStore.readEvents`'s doc: a reconnecting client that has already
   * consumed through `seq` N passes `N + 1`, not `N`). Read-only: never
   * rehydrates, never touches the registry — T2.7's replay step, and the
   * reason a cold session's replay leaves the registry exactly as empty as
   * it found it.
   */
  async readEvents(sessionId: string, fromSeq?: number): Promise<StoredEventRecord[]> {
    return this.store.readEvents(sessionId, fromSeq);
  }

  /**
   * Session-wide subscribe — the "small, natural extension" this module's
   * doc flagged as the seam T2.7 would need. Unlike `enqueueTurn`'s bus
   * subscription (filtered to one `turnId`, torn down the instant that
   * turn's boundary arrives), this delivers every `SessionBusMessage`
   * published for `sessionId` from this call onward, across every turn —
   * queued, running, or not even enqueued yet — for as long as the caller
   * holds the returned unsubscribe function unused. Text-deltas flow
   * through too (the same `bus.publish` call `runTurn` already makes for
   * them reaches every subscriber, not just the enqueuing turn's own), so a
   * live follow viewer sees streaming text exactly as the turn's own
   * enqueuer does. Returns an idempotent unsubscribe function
   * (`SessionEventBus.subscribe`'s contract).
   *
   * No existence check here on purpose — `hasSession` is the one place
   * that decides "does this session exist," and a caller (T2.7's handler)
   * is expected to have already checked it before subscribing. Subscribing
   * to an unknown session id is harmless (an empty listener set that never
   * fires), just not what any real caller wants.
   */
  subscribeToSession(
    sessionId: string,
    listener: (message: SessionBusMessage) => void,
  ): () => void {
    return this.bus.subscribe(sessionId, listener);
  }

  /** Test-only exposure of the internal bus's per-session listener count (F5 review fix — `SessionEventBus.listenerCount`'s own doc). Not used by any production path; lets a leaked-subscription test assert directly rather than inferring a leak indirectly. */
  listenerCountForTest(sessionId: string): number {
    return this.bus.listenerCount(sessionId);
  }

  /**
   * `GET /api/sessions` (T3.1) — every session's row, newest-first
   * (`SessionStore.list`'s own ordering doc), optionally narrowed to one
   * volume. A thin passthrough to the store: listing needs no lock (nothing
   * here is a write), no registry lookup (a `SessionMeta` carries everything
   * a list view needs — `sdkSessionId`/`failedSdkSessionIds` are internal
   * bookkeeping the handler's own summary mapping leaves off the wire, not
   * this method's concern).
   */
  async listSessions(filter?: SessionListFilter): Promise<SessionMeta[]> {
    return this.store.list(filter);
  }

  /**
   * `PATCH /api/sessions/:id { title }` (T3.1) — the operator-set title
   * overrides `finishTurn`'s first-turn default (`defaultTitleFrom`) for
   * good; nothing else in this class writes `title` after this call. 404
   * `session_not_found` if `sessionId` has no store row — checked
   * explicitly rather than just letting `store.update` throw, so this
   * method's own 404 reads the same way every other existence check in this
   * class does (`resolveSessionId`, `hasSession`), even though
   * `store.update` would raise the identical `SessionNotFoundError` either
   * way (`@shadow/sessions`' own contract).
   */
  async updateTitle(sessionId: string, title: string): Promise<SessionMeta> {
    const meta = await this.store.get(sessionId);
    if (!meta) {
      throw new SessionNotFoundError(sessionId);
    }
    await this.store.update(sessionId, { title });
    const updated = await this.store.get(sessionId);
    if (!updated) {
      // TOCTOU-only: nothing in this codebase concurrently deletes a
      // session outside `deleteSession` below, and that method 409s while
      // this one's own `store.update` above is still running (both go
      // through the store, not the lock — see `deleteSession`'s doc on why
      // that's fine here). Defensive, not expected to ever fire.
      throw new SessionNotFoundError(sessionId);
    }
    return updated;
  }

  /**
   * `DELETE /api/sessions/:id` (T3.1) — the ONE path, alongside
   * `finishTurn`'s bookkeeping above, this task adds: removes the store
   * directory, the registry entry (if any — cold sessions have none), and
   * every SDK transcript the session ever produced, live or failed
   * (`meta.sdkSessionId` plus every `meta.failedSdkSessionIds` entry — F7
   * review fix, closing `docs/DECISIONS.md` D6b's "orphaned twice over"
   * gap), together — no orphans left in any direction. Publishes `{kind:
   * "ended"}` on the bus afterward so an open `?follow=true` stream
   * (`handlers/session-events.ts`) closes instead of sitting inertly
   * subscribed to an id the store no longer knows (T2.7's documented seam,
   * `session-bus.ts`'s module doc).
   *
   * **409 `SessionBusyError` if a turn is currently running or queued**
   * (`SessionLock.hasActivity` — the same predicate `ConversationRegistry`'s
   * eviction consults) — checked FIRST, before anything else, so a delete
   * racing an in-flight turn never tears the store out from under
   * `runTurn`'s own appends. **404 `SessionNotFoundError`** if the store has
   * no row for `sessionId` — existence is a store-only question here (same
   * reasoning `resolveSessionId`/`hasSession` already document: a registry
   * entry always implies a store row, so checking the store alone is
   * sufficient).
   *
   * **Order matters for crash-safety.** SDK transcripts are deleted BEFORE
   * the store row: if this method (or the process) dies between the two, the
   * store row survives and a retried `DELETE` on the same id finds the
   * session still there — safe to try again, since a repeat
   * `deleteStoredSession` call for an id already gone is a documented no-op
   * (`AgenticSessionPort.deleteStoredSession`'s doc). The reverse order would
   * leave a store row nothing could ever re-target once the SDK ids it
   * pointed at were already forgotten. Registry release happens first and is
   * best-effort (mirrors `ConversationRegistry.evict()`'s own stance,
   * `.catch(() => {})`) — dropping the in-memory handle early is never
   * itself a data-loss risk, only ever a wasted rehydrate if a later step
   * fails and the operator retries.
   */
  async deleteSession(sessionId: string): Promise<void> {
    if (this.lock.hasActivity(sessionId)) {
      throw new SessionBusyError(sessionId);
    }
    const meta = await this.store.get(sessionId);
    if (!meta) {
      throw new SessionNotFoundError(sessionId);
    }

    await this.registry.remove(sessionId);

    const idsToDelete = new Set<string>();
    if (meta.sdkSessionId !== undefined) idsToDelete.add(meta.sdkSessionId);
    for (const id of meta.failedSdkSessionIds ?? []) idsToDelete.add(id);
    for (const id of idsToDelete) {
      await this.agenticSessionPort.deleteStoredSession(id);
    }

    await this.store.delete(sessionId);

    this.bus.publish(sessionId, { kind: "ended" });
  }

  /**
   * Deterministic (no LLM call) prior-conversation context for T2.3's
   * in-conversation resume fallback: the last `FALLBACK_SUMMARY_MAX_MESSAGES`
   * `operator-message`/`assistant-message` texts, each clipped to
   * `FALLBACK_SUMMARY_CLIP_LENGTH` chars, under `FALLBACK_SUMMARY_HEADER` —
   * exactly PLAN.md's T2.5 entry. `ShadowConversation.sendMessage` is what
   * actually *uses* this (prepended to the model prompt only, on a resumed
   * first turn's "No conversation found" — never routed through the
   * recorded operator transcript source); this method only builds the text.
   */
  private async buildFallbackSummary(sessionId: string): Promise<string> {
    const records = await this.store.readEvents(sessionId);
    const lines: string[] = [];
    for (const record of records) {
      const { event } = record;
      // `event.type === "operator-message"` narrows to
      // `OperatorMessageEvent | UnknownStoredEvent` — `UnknownStoredEvent`'s
      // `type: string` index signature overlaps every string literal a
      // plain `if` narrows on, so `.text` would otherwise widen to
      // `unknown` (same overlap `event-mapping.ts`'s `wireEventsFromStored`
      // documents for `research-completed`/`chapter-audit`). Cast to the
      // one real variant explicitly instead.
      if (event.type === "operator-message") {
        const operatorMessage = event as Extract<
          StoredSessionEvent,
          { readonly type: "operator-message" }
        >;
        lines.push(`Operator: ${clip(operatorMessage.text, FALLBACK_SUMMARY_CLIP_LENGTH)}`);
      } else if (event.type === "assistant-message") {
        const assistantMessage = event as Extract<
          StoredSessionEvent,
          { readonly type: "assistant-message" }
        >;
        lines.push(`Shadow: ${clip(assistantMessage.text, FALLBACK_SUMMARY_CLIP_LENGTH)}`);
      }
    }
    const recent = lines.slice(-FALLBACK_SUMMARY_MAX_MESSAGES);
    return [FALLBACK_SUMMARY_HEADER, ...recent].join("\n");
  }
}
