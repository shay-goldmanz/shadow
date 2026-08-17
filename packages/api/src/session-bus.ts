/**
 * `SessionEventBus` — the per-session, in-memory fan-out point T2.5's plan
 * entry calls for: "a per-session in-memory event bus (subscribe/
 * unsubscribe; publishes seq-stamped `StoredEventRecord`s POST-append so
 * consumers dedupe by `seq`)." `SessionService` is the only publisher
 * (`session-service.ts`'s `runTurn`, always *after* `store.append` has
 * returned — see that method for why "post-append" matters); any number of
 * subscribers can listen to one session's stream, and a subscriber
 * unsubscribing never affects the turn producing the events, or any other
 * subscriber (PLAN.md: "the turn does not stop when viewers detach").
 *
 * ## Why the payload is a union, not just `StoredEventRecord`
 *
 * `text-delta` has no stored shape at all (`@shadow/sessions`' `events.ts`)
 * — it is never appended, never `seq`-stamped, and therefore never a
 * `StoredEventRecord`. But `SessionService.enqueueTurn`'s caller
 * (`handlers/chat.ts`) is "the first viewer of the turn it enqueued"
 * (PLAN.md's Tier 2 intro) and still needs to stream those chunks live, the
 * same way it always has. Rather than giving the enqueuer a second, special
 * channel just for deltas, `SessionBusMessage` is a three-case union:
 * `record` (a real, `seq`-stamped, stored append — what T2.7's replay+follow
 * dedupes by `seq`), `text-delta` (transient, `turnId`-scoped, no `seq`,
 * published but never persisted), and `ended` (T3.1 — the session itself was
 * deleted; no `turnId`/`seq`, since it isn't scoped to any one turn). Every
 * subscriber sees all three kinds interleaved in true production order,
 * because they're published from the same single-threaded call sites that
 * produced them: `record`/`text-delta` from `session-service.ts`'s
 * `runTurn`, `ended` from `SessionService.deleteSession`.
 *
 * ## `ended` — T2.7's documented seam, finally built (T3.1)
 *
 * `handlers/session-events.ts`'s `?follow=true` stream subscribes
 * session-wide and, before this case existed, had no way to react to its
 * session being deleted out from under it — the stream just sat there,
 * quietly subscribed to an id the store no longer knew about, until the
 * client eventually gave up (that module's own doc, "Close conditions, and
 * the seam left for T3.1"). `SessionService.deleteSession` publishes `{kind:
 * "ended"}` once the store row and every SDK transcript are gone; that
 * handler's `for await` loop treats it as terminal (`break`, same shape
 * `isTurnEndedRecord` already used for `enqueueTurn`'s narrower per-turn
 * case) instead of forwarding it as an ordinary message — there is no wire
 * event for it (a deleted session has no client left to notify beyond
 * simply closing the stream).
 *
 * ## Why this lives apart from `SessionLock`
 *
 * The lock and the bus are two independent mechanisms `SessionService`
 * composes, not one: the lock serializes *writes* (turns, rehydration); the
 * bus fans out *reads* (anyone watching). Nothing about "how many turns can
 * a session have queued" belongs in a pub/sub class, and nothing about "who
 * gets told when an event happens" belongs in a mutex — keeping them
 * separate is what lets each stay small enough to read in one pass.
 */

import type { StoredEventRecord } from "@shadow/sessions";

/** One message published on a session's bus. See this module's doc for why the payload isn't just `StoredEventRecord`. */
export type SessionBusMessage =
  | { readonly kind: "record"; readonly record: StoredEventRecord }
  | { readonly kind: "text-delta"; readonly turnId: string; readonly text: string }
  | { readonly kind: "ended" };

type SessionBusListener = (message: SessionBusMessage) => void;

export class SessionEventBus {
  private readonly listenersBySession = new Map<string, Set<SessionBusListener>>();

  /**
   * Registers `listener` for every message published on `sessionId` from
   * this call onward (no replay — `@shadow/sessions`' `SessionStore.readEvents`
   * is the seam for anything that happened before subscribing, T2.7's job).
   * Returns an idempotent unsubscribe function; calling it more than once is
   * a harmless no-op, matching `VolumeLocks`-style cleanup semantics
   * elsewhere in this codebase.
   */
  subscribe(sessionId: string, listener: SessionBusListener): () => void {
    let listeners = this.listenersBySession.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.listenersBySession.set(sessionId, listeners);
    }
    listeners.add(listener);

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      listeners?.delete(listener);
      if (listeners && listeners.size === 0) {
        this.listenersBySession.delete(sessionId);
      }
    };
  }

  /** Delivers `message` to every listener currently subscribed to `sessionId`, synchronously, in subscription order. A no-op if nobody is listening — publishing is never gated on there being a viewer (the turn keeps draining either way). */
  publish(sessionId: string, message: SessionBusMessage): void {
    const listeners = this.listenersBySession.get(sessionId);
    if (!listeners) return;
    // Snapshot before iterating: a listener that unsubscribes itself (or
    // another one) mid-delivery must not corrupt the `Set` being iterated.
    for (const listener of Array.from(listeners)) {
      listener(message);
    }
  }

  /** Test-only (F5 review fix): how many listeners `sessionId` currently has — 0 both for "never subscribed" and "every subscriber's `unsubscribe()` has run" (the same map entry is deleted at zero, per `subscribe`'s own cleanup). Not used by any production path; exists so a leaked-subscription test can assert directly on this class rather than inferring a leak indirectly. */
  listenerCount(sessionId: string): number {
    return this.listenersBySession.get(sessionId)?.size ?? 0;
  }
}

/**
 * A single-consumer async queue: `push`ed values are buffered until a
 * pending `next()` call is waiting, in which case they're delivered
 * directly; `end()` makes every future (and any currently-pending) `next()`
 * resolve `done: true` once the buffer drains. The mechanism
 * `SessionService` uses to turn `SessionEventBus.subscribe`'s
 * callback-shaped API into the `AsyncGenerator` `enqueueTurn` hands back to
 * its caller (`session-service.ts`'s `drainChannel`).
 */
export class PushChannel<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | undefined;
  private ended = false;

  push(value: T): void {
    if (this.ended) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value, done: false });
      return;
    }
    this.buffered.push(value);
  }

  /** Idempotent: a second `end()` call is a no-op, so a subscriber that races store-append failure against a normal boundary record can call this defensively without double-signaling. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: undefined, done: true });
    }
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.buffered.length > 0) {
      // Buffered values always drain before a `done: true` is ever handed
      // out, even if `end()` was already called — a subscriber that pushed
      // a burst of events and then ended must not lose the tail of the
      // burst to a premature "done."
      // Non-null by the `length > 0` check above — `Array.prototype.shift`
      // is just typed loosely for the general (possibly-empty) case.
      const value = this.buffered.shift();
      return Promise.resolve({ value, done: false } as IteratorResult<T>);
    }
    if (this.ended) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: (): Promise<IteratorResult<T>> => this.next() };
  }
}
