/**
 * `GET /api/sessions/:id/events` (T2.7) — replay + follow, the read side of
 * PLAN.md's Tier 2 "any number [of viewers], read-only" refinement.
 *
 * ## Two modes, one wire mapping
 *
 * Default (`?follow` absent or not `"true"`): pure replay. Every stored
 * event from `?fromSeq` onward (default: the whole transcript), mapped
 * through `../event-mapping.ts`'s `wireEventsFromStored` — the exact same
 * pure function chat.ts's live path is *not* using here, because a replay
 * reader has no live delta history to lean on (see that module's doc for
 * why `wireEventsForLive` differs only in suppressing `assistant-message`).
 * The stream ends with a `done` event once the stored transcript is
 * exhausted.
 *
 * `?follow=true`: replay, then stay live. `SessionService.subscribeToSession`
 * (T2.5's "small, natural extension," finally landing here) is called
 * *before* replay starts reading — see "Bus-first-buffer" below for why
 * that ordering is the whole point — and the stream never sends `done`;
 * it stays open until the client disconnects.
 *
 * ## Wire encoding: `seq` on every record-derived event
 *
 * Every `WireEvent` this handler sends that came from a `StoredEventRecord`
 * — replay or live tail alike — carries `data.seq` set to that record's
 * `seq` (`../event-mapping.ts`'s `withSeq`). This is deliberately the same
 * encoding on both paths: a client reconnecting via `?fromSeq=` needs the
 * `seq` of the last event it saw regardless of whether that event arrived
 * during replay or after the stream had already gone live, and PLAN.md is
 * explicit that `fromSeq` — not `Last-Event-ID` (`web/src/api/sse.ts`'s
 * fetch-based reader ignores `id:` lines) — is the *only* reconnect
 * mechanism. Live `text-delta` chunks (`textDeltaWireEvent`) have no
 * backing record and therefore no `seq` — they're transient, chunked
 * pieces of a `text` the eventual `assistant-message` record will already
 * carry a `seq` for. This `seq` encoding is scoped to this endpoint only;
 * `chat.ts`'s own `POST /api/chat` stream is a separate, already-shipped
 * wire contract this task has no reason to touch.
 *
 * ## Bus-first-buffer: closing the replay-end/subscribe gap
 *
 * If this handler replayed first and only subscribed to the bus afterward,
 * any record a running turn appends *during* that replay read would be
 * lost forever — appended to the store (so a *later* reconnect would see
 * it), published to a bus nobody was listening to yet (so THIS viewer
 * never would). PLAN.md is explicit about the fix: subscribe first, buffer,
 * then replay, then drain the buffer deduped by `seq`. The implementation
 * here doesn't need a separate "buffer" data structure or an explicit
 * "drain" phase at all — `PushChannel` (`../session-bus.ts`) already *is*
 * a buffer: `push`ing into it before anyone calls `next()` accumulates,
 * and a `for await` over it drains whatever accumulated before delivering
 * anything new, with no distinction in the code between "was buffered
 * during the gap" and "arrived after we started truly waiting." Subscribing
 * unconditionally routes every message — buffered-during-replay and
 * genuinely-live alike — through the exact same dedup check: skip any
 * `record` message whose `seq` is `<= lastSeq` (already delivered by
 * replay), forward everything else. `text-delta` messages have no `seq`
 * and are therefore never subject to dedup — they can't be, since replay
 * never re-derives them (see `../event-mapping.ts`'s module doc).
 *
 * ## Turn end is not a close condition
 *
 * Unlike `enqueueTurn`'s per-turn subscription (`session-service.ts`'s
 * `isTurnEndedRecord` — that channel ends the instant its one turn's
 * boundary arrives, because that's the only turn its caller asked to
 * watch), this handler's subscription is session-wide and never ends
 * itself: a `turn-boundary(ended, ...)` record is just one more record on
 * the wire, dequeued and forwarded like any other. A passive second tab
 * must not go blind the moment the turn it happened to be watching
 * finishes — it should keep seeing whatever session activity comes next,
 * possibly turns from now, which is exactly what never letting the
 * `for await` below terminate on its own achieves. The stream survives
 * idle the same way `chat.ts`'s already does: an SSE comment line on a
 * 5s interval, invisible to any real client but real traffic to the
 * connection and any proxy in front of it.
 *
 * ## Close conditions, and the seam left for T3.1
 *
 * Today there are exactly two ways this stream ends: the client
 * disconnects (`cancel()` — unsubscribes and ends the channel, unblocking
 * a `for await` that would otherwise wait forever) or the process exits.
 * Session *deletion* (T3.1) has no signal to react to yet — deleting a
 * session out from under an open follow stream today would simply leave
 * the stream open, quietly subscribed to a session id the store no longer
 * knows about, never receiving anything further (nothing can `append` to a
 * deleted session, so nothing new is ever published for it either) until
 * the client eventually gives up or disconnects. That's inert, not wrong,
 * but not the same as an explicit close. The seam: `SessionBusMessage`
 * (`../session-bus.ts`) would grow a third case (e.g. `{ kind: "ended" }`)
 * that a delete path publishes before tearing down the store row, and the
 * `for await` loop below would treat it as a terminal signal — `channel.end()`
 * itself, or a `break` — the same way `isTurnEndedRecord` already does for
 * `enqueueTurn`'s narrower per-turn case. Not built here: T3.1 is where
 * DELETE lands, and this endpoint has no delete path to react to before
 * then.
 */

import type { StoredEventRecord, StoredSessionEvent } from "@shadow/sessions";
import type { BunRequest } from "bun";
import type { ApiDeps } from "../deps.ts";
import { InvalidRequestError, SessionNotFoundError } from "../errors.ts";
import {
  errorEventForBoundary,
  textDeltaWireEvent,
  type WireEvent,
  wireEventsForLive,
  wireEventsFromStored,
  withSeq,
} from "../event-mapping.ts";
import { PushChannel, type SessionBusMessage } from "../session-bus.ts";
import { encodeSseEvent } from "../sse.ts";

/** `?fromSeq=` — the sole reconnect cursor (PLAN.md: no `Last-Event-ID`). Absent = replay from the start. Must be a positive integer; anything else is a 400, same "shape-level problem a pillar never gets the chance to see" `InvalidRequestError` covers elsewhere in this package. */
function parseFromSeq(url: URL): number | undefined {
  const raw = url.searchParams.get("fromSeq");
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidRequestError(
      `fromSeq must be a positive integer when provided, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

/** Maps one stored record to its wire event(s) via `mapper` (`wireEventsFromStored` for replay, `wireEventsForLive` for the live tail — see this module's doc for why they differ), applying the shared `turn-boundary(ended, error)` synthesis both paths need identically, and stamping `seq` on everything that comes out. */
function recordToWireEvents(
  record: StoredEventRecord,
  mapper: (event: StoredSessionEvent) => readonly WireEvent[],
): readonly WireEvent[] {
  const errorWire = errorEventForBoundary(record.event);
  if (errorWire) return [withSeq(errorWire, record.seq)];
  return mapper(record.event).map((wire) => withSeq(wire, record.seq));
}

export async function getSessionEvents(
  deps: ApiDeps,
  req: BunRequest<"/api/sessions/:id/events">,
): Promise<Response> {
  const sessionId = req.params.id;
  const url = new URL(req.url);
  const follow = url.searchParams.get("follow") === "true";
  const fromSeq = parseFromSeq(url);

  // Existence check up front, BEFORE the stream opens — an ordinary JSON
  // 404 (`error-mapping.ts`), same pre-stream guarantee `chat.ts` documents
  // for its own pre-stream checks. `hasSession` checks registry-or-store
  // without rehydrating: PLAN.md's T2.7 entry is explicit that "replay is
  // read-only; rehydration happens on the next turn" — a registry miss
  // here does NOT construct a `ShadowConversation`.
  if (!(await deps.sessionService.hasSession(sessionId))) {
    throw new SessionNotFoundError(sessionId);
  }

  let closed = false;
  let unsubscribe: (() => void) | undefined;
  // Bus-first-buffer (this module's doc): subscribed HERE, before replay
  // ever reads the store, so nothing a running turn appends between now
  // and the replay read below can ever be missed. `PushChannel` accumulates
  // whatever's pushed before anyone consumes it — that accumulation IS the
  // buffer; there is no separate buffer to manage.
  const channel = follow ? new PushChannel<SessionBusMessage>() : undefined;
  if (follow) {
    unsubscribe = deps.sessionService.subscribeToSession(sessionId, (message) => {
      channel?.push(message);
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Mirrors chat.ts's `send`/`close`/heartbeat trio exactly (same
      // reasoning documented there: guard every enqueue against a
      // concurrently-closed controller, keep the connection alive across
      // work — here, an idle session, not a thinking turn — that can
      // legitimately outlast any fixed proxy timeout).
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encodeSseEvent(event, data));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed (e.g. by a concurrent `cancel()`) — fine.
        }
      };
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
        } catch {
          closed = true;
        }
      }, 5_000);

      try {
        // 1. Replay: the stored transcript from `fromSeq` onward
        // (inclusive — `SessionStore.readEvents`'s doc; a reconnecting
        // client passes `lastSeq + 1`, not `lastSeq`).
        const records = await deps.sessionService.readEvents(sessionId, fromSeq);
        let lastSeq = fromSeq !== undefined ? fromSeq - 1 : 0;
        for (const record of records) {
          for (const wire of recordToWireEvents(record, wireEventsFromStored)) {
            send(wire.event, wire.data);
          }
          lastSeq = record.seq;
        }

        if (!follow) {
          send("done", {});
          return;
        }
        if (closed) return; // client disconnected while replay was reading

        // 2 & 3. Drain whatever the subscription buffered during replay,
        // then stay live — the same loop handles both, per this module's
        // doc: `channel` doesn't distinguish "buffered before we were
        // reading" from "arrived while we're genuinely waiting." Dedup by
        // `seq`: anything already delivered by replay above (`seq <=
        // lastSeq`) is skipped, never forwarded twice. Ends only when
        // `cancel()` below calls `channel.end()` — a `turn-boundary(ended)`
        // record is deliberately just another record here, not a close
        // condition (this module's doc).
        for await (const message of channel as PushChannel<SessionBusMessage>) {
          if (closed) break;
          if (message.kind === "text-delta") {
            const wire = textDeltaWireEvent(message.text);
            send(wire.event, wire.data);
            continue;
          }
          if (message.record.seq <= lastSeq) continue; // already delivered via replay
          lastSeq = message.record.seq;
          for (const wire of recordToWireEvents(message.record, wireEventsForLive)) {
            send(wire.event, wire.data);
          }
        }
      } catch (error) {
        // Reachable only for a failure in THIS handler's own consumption
        // (mirrors chat.ts's identical catch — the store/bus themselves
        // don't throw mid-stream for anything this handler causes).
        if (!closed) {
          send("error", {
            message: error instanceof Error ? error.message : String(error),
            code: "internal_error",
          });
        }
      } finally {
        clearInterval(heartbeat);
        close();
      }
    },
    // Client disconnect (nav away, tab close, aborted fetch) — the only
    // close condition this endpoint reacts to today (see this module's doc
    // for the session-deletion seam T3.1 will need to add a second one).
    // Ending the channel unblocks a `for await` that would otherwise wait
    // forever for a message that may never come.
    async cancel() {
      closed = true;
      unsubscribe?.();
      channel?.end();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
