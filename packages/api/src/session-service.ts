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
import type { ShadowAgent, ShadowConversation, StartConversationOptions } from "@shadow/agent";
import type { VolumeSlug } from "@shadow/core";
import type {
  SessionMeta,
  SessionMetaPatch,
  SessionStore,
  StoredSessionEvent,
  TurnBoundaryEndReason,
} from "@shadow/sessions";
import { ConversationRegistry, type ConversationRegistryOptions } from "./conversation-registry.ts";
import { toErrorResponse } from "./error-mapping.ts";
import { SessionNotFoundError, TurnQueueBusyError } from "./errors.ts";
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

export class SessionService {
  private readonly store: SessionStore;
  private readonly shadowAgent: ShadowAgent;
  private readonly lock = new SessionLock();
  private readonly bus = new SessionEventBus();
  private readonly maxQueuedTurnsPerSession: number;

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
   * partially started): `SessionNotFoundError` (404) if `target.sessionId`
   * is absent from both the registry and the store, `TurnQueueBusyError`
   * (409) if that session already has `maxQueuedTurnsPerSession` turns
   * queued ahead of this one. Both are typed `ShadowApiError`s
   * (`errors.ts`) — `error-mapping.ts` needs no new table row for either:
   * its `error instanceof ShadowApiError` branch already maps a subclass's
   * own `status`/`code` fields generically, which is why this task's
   * "add the error-mapping row now, or leave for T3.1" decision resolves to
   * *neither* — there is no row to add.
   */
  async enqueueTurn(target: EnqueueTarget, message: string): Promise<EnqueuedTurn> {
    const sessionId = await this.resolveSessionId(target);

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
      const belongsToThisTurn =
        published.kind === "text-delta"
          ? published.turnId === turnId
          : published.record.turnId === turnId;
      if (!belongsToThisTurn) return;
      channel.push(published);
      if (isTurnEndedRecord(published)) {
        channel.end();
      }
    });

    const settled = this.lock.runReserved(sessionId, () =>
      this.runTurn(sessionId, turnId, message),
    );
    // Re-run eviction once this turn's lock hold fully releases (i.e. once
    // `hasActivity(sessionId)` can honestly flip to `false` for it) — a
    // session another turn's eviction pass skipped for being busy gets
    // released the moment it's safe, per `ConversationRegistry.evict()`'s
    // doc, rather than waiting for some unrelated `set()` to retrigger it.
    // `runTurn` itself never throws (see that method's doc), but this
    // `catch` is defense-in-depth against an unhandled rejection regardless.
    void settled.finally(() => this.registry.evict()).catch(() => {});

    return { sessionId, turnId, events: drainChannel(channel, unsubscribe) };
  }

  /** Resolves `target` to a session id, minting a fresh session row for a `{volume}` target or validating an existing `{sessionId}` target exists somewhere (registry or store) — WITHOUT rehydrating it yet. Rehydration itself only ever happens inside the per-session lock (`ensureConversation`, called from `runTurn`), so this is deliberately just an existence check for `{sessionId}`. */
  private async resolveSessionId(target: EnqueueTarget): Promise<string> {
    if ("volume" in target) {
      return this.createSessionRow(target.volume);
    }
    const { sessionId } = target;
    if (this.registry.get(sessionId)) {
      return sessionId;
    }
    const meta = await this.store.get(sessionId);
    if (!meta) {
      throw new SessionNotFoundError(sessionId);
    }
    return sessionId;
  }

  /** Mints a fresh session id and its store row. Nothing else can race this — the id is freshly minted (`randomUUID()`), so no other caller could possibly already know it, unlike an operator-supplied `sessionId`. */
  private async createSessionRow(volume: VolumeSlug): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.store.create({ id, volume, title: null, createdAt: now, lastActiveAt: now });
    return id;
  }

  /**
   * Runs one turn end to end: append `operator-message` + `turn-boundary
   * (started)` at run start (not at enqueue — PLAN.md's "a queued turn must
   * not interleave its records into the running turn's seq range, and a
   * crash while queued should lose the queued message cleanly"), drain
   * `conversation.sendMessage()` teeing every stored-shape event to the
   * store and bus, then append `turn-boundary(ended, …)` in a `finally`.
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
  private async runTurn(sessionId: string, turnId: string, operatorText: string): Promise<void> {
    let endReason: TurnBoundaryEndReason = "completed";
    let errorInfo: { message: string; code: string } | undefined;
    let conversation: ShadowConversation | undefined;
    let priorTitle: string | null = null;

    try {
      const ensured = await this.ensureConversation(sessionId);
      conversation = ensured.conversation;
      priorTitle = ensured.meta.title;

      await this.appendAndPublish(sessionId, turnId, operatorMessageEvent(operatorText));
      await this.appendAndPublish(sessionId, turnId, turnBoundaryStarted());

      const stamper = new StoredEventStamper(turnId);
      for await (const event of conversation.sendMessage(operatorText)) {
        if (event.type === "text-delta") {
          // No stored shape at all (`@shadow/sessions` never persists
          // deltas) — published straight to the bus, never appended.
          this.bus.publish(sessionId, { kind: "text-delta", turnId, text: event.text });
          continue;
        }
        await this.appendAndPublish(sessionId, turnId, stamper.stampAgentEvent(event));
      }
    } catch (error) {
      endReason = "error";
      const mapped = toErrorResponse(error);
      errorInfo = { message: mapped.body.error.message, code: mapped.body.error.code };
    } finally {
      await this.finishTurn(
        sessionId,
        turnId,
        conversation,
        priorTitle,
        operatorText,
        endReason,
        errorInfo,
      );
    }
  }

  /** The `finally` half of `runTurn`: append the closing boundary, update session meta, and make sure this turn's bus subscribers are guaranteed to terminate even if the boundary append itself fails. */
  private async finishTurn(
    sessionId: string,
    turnId: string,
    conversation: ShadowConversation | undefined,
    priorTitle: string | null,
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
