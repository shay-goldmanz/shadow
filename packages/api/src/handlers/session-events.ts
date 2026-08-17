/**
 * `GET /api/sessions/:id/events` (T2.7) — replay + follow, the read side of
 * PLAN.md's Tier 2 "any number [of viewers], read-only" refinement.
 *
 * ## Two modes, one wire mapping
 *
 * Default (`?follow` absent or not `"true"`): pure replay. Every stored
 * event from `?fromSeq` onward (default: the whole transcript), mapped
 * through `../event-mapping.ts`'s `wireEventsFromStored`. The stream ends
 * with a `done` event once the stored transcript is exhausted.
 *
 * `?follow=true`: replay, then stay live. `SessionService.subscribeToSession`
 * (T2.5's "small, natural extension," finally landing here) is called
 * *before* replay starts reading — see "Bus-first-buffer" below for why
 * that ordering is the whole point — and the stream never sends `done`;
 * it stays open until the client disconnects.
 *
 * **F2/F4 review fix — the live tail also uses `wireEventsFromStored`, not
 * `wireEventsForLive`.** Before this fix, a `record` message on the live
 * tail was mapped through `wireEventsForLive` — the same suppression
 * `chat.ts`'s OWN live stream needs, so it never double-sends text it
 * already streamed chunk by chunk as `text-delta`s. But this endpoint's
 * live tail is a DIFFERENT viewer's stream: a follow subscriber has no live
 * delta history of their own to avoid duplicating (they may have just this
 * instant subscribed, mid-message). Reusing `wireEventsForLive` here meant
 * the one stored record carrying a message's FULL, authoritative text — the
 * `assistant-message` record, appended once the message completes — was
 * silently dropped for every follow viewer, permanently, with no way to
 * ever recover a prefix they missed by joining mid-message. `record`
 * messages on the live tail now go through the SAME `wireEventsFromStored`
 * replay already uses, so that record arrives as an ordinary, `seq`-stamped
 * `text` event — see "Wire encoding" below for how the client tells it
 * apart from a live delta, and `../../web/src/api/types.ts`'s
 * `SessionEventEnvelope` doc for the full story. `text-delta` bus messages
 * are unaffected — they never had a stored shape to map through either
 * function (this module's own doc, below) and keep flowing straight to the
 * wire via `textDeltaWireEvent`, exactly as before.
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
 * backing record and therefore no `seq` — they're transient, and (as of the
 * F2/F4 fix above) the client-visible DIFFERENCE between them and the
 * eventual `seq`-stamped `assistant-message`-derived `text` event is exactly
 * the point: a `seq`-less `text` is a delta to APPEND, a `seq`-carrying
 * `text` is the full message to REPLACE with. This `seq` encoding is scoped
 * to this endpoint only; `chat.ts`'s own `POST /api/chat` stream is a
 * separate, already-shipped wire contract this task has no reason to touch.
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
 * ## Close conditions
 *
 * Three ways this stream ends: the client disconnects (`cancel()` —
 * unsubscribes and ends the channel, unblocking a `for await` that would
 * otherwise wait forever), the process exits, or the session is deleted
 * (T3.1). `SessionService.deleteSession` publishes `{ kind: "ended" }`
 * (`../session-bus.ts`'s three-case `SessionBusMessage`) after the store row
 * and every SDK transcript are gone; the `for await` loop below `break`s on
 * it — the same shape `isTurnEndedRecord` already used for `enqueueTurn`'s
 * narrower per-turn case, just session-wide and unconditional rather than
 * filtered to one turn. No wire event accompanies it: a deleted session has
 * no client-visible content left to send, only a stream to close.
 */

import type { StoredEventRecord } from "@shadow/sessions";
import { SessionNotFoundError as StoreSessionNotFoundError } from "@shadow/sessions";
import type { BunRequest } from "bun";
import type { ApiDeps } from "../deps.ts";
import { InvalidRequestError, SessionNotFoundError } from "../errors.ts";
import {
  errorEventForBoundary,
  textDeltaWireEvent,
  type WireEvent,
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

/**
 * Maps one stored record to its wire event(s) via `wireEventsFromStored`,
 * applying the shared `turn-boundary(ended, error)` synthesis both replay
 * and the live tail need identically, and stamping `seq` on everything that
 * comes out. Used by both call sites below — replay and the live tail alike
 * (F2/F4 review fix: they used to differ, one via `wireEventsForLive`; see
 * this module's doc for why that was the bug, and why both now need the
 * SAME mapping). No `mapper` parameter any more since there is only ever
 * one to pass.
 */
function recordToWireEvents(record: StoredEventRecord): readonly WireEvent[] {
  const errorWire = errorEventForBoundary(record.event);
  if (errorWire) return [withSeq(errorWire, record.seq)];
  return wireEventsFromStored(record.event).map((wire) => withSeq(wire, record.seq));
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
    // F7-review fix (a): the session could have been deleted in the gap
    // between the `hasSession` check above and this `subscribeToSession`
    // call — deletion publishes `{ kind: "ended" }` on the bus (T3.1)
    // BEFORE this subscription ever existed to hear it, so without this
    // re-check the stream below would open and then follow a session
    // that's already gone, forever (no "ended" message is ever coming for
    // it now). Re-checked here, still before the `Response`/stream is ever
    // created, so a session lost in exactly this window gets the SAME
    // ordinary 404 the top-of-handler check would have given it had the
    // race landed the other way, instead of an SSE connection with nothing
    // left to tell it to close.
    if (!(await deps.sessionService.hasSession(sessionId))) {
      unsubscribe();
      throw new SessionNotFoundError(sessionId);
    }
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
          for (const wire of recordToWireEvents(record)) {
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
          if (message.kind === "ended") {
            // T3.1: the session was deleted out from under this stream
            // (`session-bus.ts`'s module doc — the seam this module used to
            // just document as "not built here"). No wire event: a deleted
            // session has no client-visible content left to send, only a
            // stream to close, same as any other close condition below.
            break;
          }
          if (message.kind === "text-delta") {
            const wire = textDeltaWireEvent(message.text);
            send(wire.event, wire.data);
            continue;
          }
          if (message.record.seq <= lastSeq) continue; // already delivered via replay
          lastSeq = message.record.seq;
          // F2/F4 review fix: `wireEventsFromStored`, not `wireEventsForLive`
          // — see this module's doc for why the live tail needs the SAME
          // mapping replay uses (a completed `assistant-message` record's
          // full text must reach a follow viewer, seq-stamped, or a viewer
          // who joined mid-message permanently loses the prefix).
          for (const wire of recordToWireEvents(message.record)) {
            send(wire.event, wire.data);
          }
        }
      } catch (error) {
        // F7-review fix (b): a `SessionStore`-level `SessionNotFoundError`
        // (`@shadow/sessions`'s own class — distinct from this package's
        // `../errors.ts` one of the same name, imported above as
        // `StoreSessionNotFoundError`) means the session was deleted
        // mid-replay: the store row vanished between this stream starting
        // and `readEvents` actually reading it. That is the exact same
        // "the session is gone" outcome the bus's `{ kind: "ended" }`
        // message closes cleanly for above — just observed through a
        // thrown error instead of a bus message, since a delete's publish
        // can only reach a subscriber whose `readEvents` call has already
        // returned. Closed the same way: no wire event, just a clean end —
        // reporting this as `internal_error` (every other failure here
        // still does) would misrepresent an ordinary delete race as a
        // server fault.
        if (error instanceof StoreSessionNotFoundError) {
          // Fall through to `finally` below, which closes cleanly.
        } else if (!closed) {
          send("error", {
            message: error instanceof Error ? error.message : String(error),
            code: "internal_error",
          });
        }
      } finally {
        // F5 review fix: `cancel()` (below) already unsubscribes for the
        // ordinary client-disconnect path, but a throw from THIS block
        // (`readEvents` failing, say) reaches this `finally` WITHOUT ever
        // going through `cancel()` — nothing else in that path ever called
        // `unsubscribe()`. Left out, that leaked the bus listener forever:
        // registered in `subscribeToSession` above, never removed, quietly
        // pushing into a `channel` nobody drains from that point on.
        // Idempotent (`SessionEventBus.subscribe`'s contract), so calling it
        // here AND in `cancel()` on whichever path actually runs is safe —
        // neither call assumes the other hasn't already happened.
        unsubscribe?.();
        clearInterval(heartbeat);
        close();
      }
    },
    // Client disconnect (nav away, tab close, aborted fetch) — one of the
    // three close conditions this endpoint reacts to (this module's
    // "Close conditions" doc has the other two: the process exiting, and
    // session deletion, both handled above in `start()`'s own `try`/`catch`
    // rather than through this `cancel()` callback at all). Ending the
    // channel unblocks a `for await` that would otherwise wait forever for
    // a message that may never come.
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
