/**
 * Bounded, LRU-evicting registry for live `ShadowConversation`s
 * (`ApiDeps.conversations`, `handlers/chat.ts`'s `Map<sessionId,
 * ShadowConversation>` — now this instead of a raw `Map`).
 *
 * Every conversation now persists its underlying `AgenticSession`'s
 * transcript on disk for the life of the handle (session persistence is
 * required for D6's multi-turn `resume` to work at all — see
 * `@shadow/agent`'s `conversation.ts`), so an unbounded registry isn't just
 * an in-memory leak, it accumulates real files under `~/.claude/projects/`.
 * As of T2.4/D6b, though, this class's job is only to bound *memory* —
 * `ShadowConversation.release()` drops the in-memory handle and deletes
 * nothing, so the on-disk transcript outlives eviction (and outlives
 * shutdown too, D6b's inversion of D6a). This class calls `release()` on
 * two paths:
 *   - eviction: the registry holds at most `maxSize` conversations, skipping
 *     any a turn is currently running/queued against (see `evict()` below).
 *     Inserting past the cap evicts and releases the least-recently-used
 *     *evictable* one.
 *   - shutdown: `releaseAll()` (`start.ts` on `SIGINT`/`SIGTERM`) releases
 *     everything still held.
 *
 * Deliberately simple — this is a local, single-operator prototype. An idle
 * timeout would also bound growth but needs a timer per entry and a clock
 * to fake in tests; a size-capped LRU needs neither and is bounded the same
 * way. "Least-recently-*resumed*" (touched on `get`, not just `set`) is what
 * makes the cap track actual usage rather than just insertion order.
 *
 * ## The busy-skip seam (T2.4 mechanism; T2.5 is the intended caller)
 *
 * This registry has no notion of "turn" — that concept doesn't exist until
 * `@shadow/api`'s `SessionService` (T2.5) does. But eviction must never rip
 * a handle out from under a turn that's still writing through it (nothing
 * would abort the turn — `@shadow/agent`'s generator keeps its own
 * reference — but the registry would lose its only way to hand the *next*
 * request the same handle, forcing an unnecessary cold rehydrate, or worse,
 * racing a rehydrate against the still-running turn). So eviction is wired
 * through an injected predicate, `isSessionBusy`, consulted fresh on every
 * eviction pass rather than captured once — busy-ness changes constantly
 * (a turn starts, queues, settles), so this has to be a live callback into
 * whatever owns that state, not a snapshot. Nothing in this codebase sets
 * turns in motion outside one request/response cycle yet, so the default
 * (`() => false`, "nothing is ever busy") reproduces this class's pre-T2.4
 * behavior exactly for every current caller; `SessionService` is expected
 * to pass the real answer once it exists.
 *
 * This weakens the size invariant from `size <= maxSize` to
 * `size <= maxSize + busy-count` (documented in the plan) — a busy session
 * left in place past the cap is not a bug, it is the point: releasing it is
 * optional right up until the turn settles, never mandatory. `evict()` is
 * public precisely so a caller that just learned a turn settled (T2.5) can
 * re-run eviction immediately rather than waiting for some unrelated `set()`
 * to happen to trigger it again — a busy session that outstays the cap
 * should not linger a moment longer than it has to once it's safe to let go.
 */

import type { ShadowConversation } from "@shadow/agent";

/**
 * Reports whether `sessionId` currently has a running or queued turn.
 * Consulted fresh on every eviction pass (see this module's doc) — a
 * session it reports busy for is skipped this pass, not banned from ever
 * being evicted.
 */
export type SessionBusyPredicate = (sessionId: string) => boolean;

export interface ConversationRegistryOptions {
  /** Conversations held before the least-recently-used *evictable* one is evicted and released. @default 50 */
  readonly maxSize?: number;
  /**
   * Consulted by `evict()` to skip a session with a running/queued turn.
   * @default () => false — nothing is ever busy, matching this class's
   * behavior before T2.4 introduced the concept. `@shadow/api`'s
   * `SessionService` (T2.5) is the intended real caller — see this module's
   * doc.
   */
  readonly isSessionBusy?: SessionBusyPredicate;
}

export class ConversationRegistry {
  private readonly maxSize: number;
  private readonly isSessionBusy: SessionBusyPredicate;
  private readonly byId = new Map<string, ShadowConversation>();

  constructor(options: ConversationRegistryOptions = {}) {
    this.maxSize = options.maxSize ?? 50;
    this.isSessionBusy = options.isSessionBusy ?? (() => false);
  }

  get size(): number {
    return this.byId.size;
  }

  get(sessionId: string): ShadowConversation | undefined {
    const conversation = this.byId.get(sessionId);
    if (!conversation) return undefined;
    // Touch: delete-then-reinsert moves it to the most-recently-used end —
    // a `Map` iterates in insertion order, so the oldest entry is always
    // whatever `.keys().next()` yields.
    this.byId.delete(sessionId);
    this.byId.set(sessionId, conversation);
    return conversation;
  }

  set(sessionId: string, conversation: ShadowConversation): void {
    this.byId.set(sessionId, conversation);
    this.evict();
  }

  /**
   * Release conversations, oldest (least-recently-used) first, until the
   * registry is back at `maxSize` or every remaining entry over the cap is
   * busy — see this module's doc for why a busy session is skipped rather
   * than waited for. Called automatically by `set()` on every insert (the
   * original eviction trigger), and safe/useful to call again with no new
   * insert — T2.5's `SessionService` calls this whenever a turn settles, so
   * a session skipped earlier for being busy gets released as soon as it's
   * safe rather than lingering until some unrelated `set()` retriggers
   * eviction.
   *
   * Terminates in a single pass over the current entries: each iteration
   * either releases the entry at hand (shrinking `byId.size` by one) or
   * skips it for being busy (leaving `byId.size` unchanged, but that entry
   * is never revisited *this call* — `Map` iteration only ever advances).
   * So the loop makes bounded progress or ends outright; it can never spin.
   */
  evict(): void {
    for (const sessionId of this.byId.keys()) {
      if (this.byId.size <= this.maxSize) return;
      if (this.isSessionBusy(sessionId)) continue; // left in place — the documented size <= maxSize + busy-count overshoot
      const conversation = this.byId.get(sessionId);
      this.byId.delete(sessionId);
      void conversation?.release().catch(() => {
        // Best-effort: an already-gone/never-started session's release
        // failing must not take the registry (or the request that
        // triggered this eviction) down with it.
      });
    }
  }

  /**
   * Removes and releases `sessionId`'s live handle, if present — a no-op
   * (not an error) if it isn't registered, the ordinary shape for a cold
   * session `DELETE /api/sessions/:id` (T3.1) targets. Unlike `evict()`,
   * which fires-and-forgets `release()` (best-effort, background eviction
   * pressure), this AWAITS it: deletion is a foreground, explicit,
   * operator-initiated action whose caller (`SessionService.deleteSession`)
   * wants the in-memory handle genuinely gone before it moves on to
   * deleting the underlying SDK transcript by id — release failing is still
   * swallowed (`.catch`), matching `evict()`'s stance that a handle's own
   * teardown failure must never block the caller that asked for it.
   */
  async remove(sessionId: string): Promise<void> {
    const conversation = this.byId.get(sessionId);
    if (!conversation) return;
    this.byId.delete(sessionId);
    await conversation.release().catch(() => {});
  }

  /** Release every held conversation and empty the registry — server shutdown. Ignores busy-ness: shutdown means nothing is going to keep running these turns anyway (T2.9 owns winding turns down *before* this is called). */
  async releaseAll(): Promise<void> {
    const conversations = [...this.byId.values()];
    this.byId.clear();
    await Promise.all(conversations.map((conversation) => conversation.release().catch(() => {})));
  }
}
