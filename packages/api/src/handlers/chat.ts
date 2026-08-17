/**
 * `POST /api/chat` (`docs/API.md` §Chat). Enqueues one turn on
 * `deps.sessionService` (T2.5) and streams it back as SSE — this handler is
 * "the first viewer of the turn it enqueued" (PLAN.md's Tier 2 intro), not
 * the thing driving the turn: `SessionService.enqueueTurn` owns creating/
 * rehydrating the session, appending the operator/boundary records, and
 * draining `ShadowConversation.sendMessage()`; this handler only maps what
 * it observes onto the wire and manages its own SSE controller.
 *
 * ## The turn survives this handler going away
 *
 * Before T2.5, `cancel()` called `iterator.return()` on the conversation's
 * own generator, killing the turn the instant a client disconnected. Now
 * `cancel()` only stops iterating `enqueued.events` (a generator over a
 * session-bus subscription, `session-service.ts`'s `drainChannel`) — its
 * `finally` unsubscribes this one viewer, nothing more. The turn keeps
 * draining server-side regardless of whether this handler, or any other
 * viewer, is still watching (this module's whole reason for existing under
 * T2.5, vs. the old request-scoped design).
 *
 * ## Session id resolution stays a pre-stream, ordinary HTTP concern
 *
 * `resolveTarget` below does exactly what `resolveConversation` used to:
 * validate the request shape and, for a new conversation, confirm the
 * volume exists (`docs/API.md`'s `volume_not_found`) — all BEFORE the SSE
 * stream opens, so those failures stay ordinary JSON error responses
 * (`error-mapping.ts`), not in-band `error` SSE events. `SessionService`
 * itself resolves `{sessionId}` existence (`session_not_found`) and the
 * turn-queue bound (`turn_queue_busy`) inside `enqueueTurn`, which this
 * handler awaits before opening the stream — same pre-stream guarantee,
 * just resolved one layer down.
 *
 * ## Mapping ShadowEvent -> docs/API.md's SSE table
 *
 * The mapping itself — every `ShadowEvent` case, every wire field, and why
 * each gap from `docs/API.md`'s table is what it is — lives in
 * `../event-mapping.ts` (T2.2), shared with replay (T2.7). This handler's
 * job is just the live-specific wiring around it: forward `text-delta`
 * chunks straight through (they have no stored shape at all), and run every
 * other observed record's stored event through `wireEventsForLive`. The
 * `operator-message` record and `turn-boundary(started)` record —
 * synthesized by `SessionService` itself, at run start — arrive through the
 * exact same subscription as everything else, so this handler no longer
 * synthesizes the operator wire event itself the way it used to.
 */

import { toVolumeSlug } from "@shadow/core";
import type { BunRequest } from "bun";
import type { ApiDeps } from "../deps.ts";
import { InvalidRequestError } from "../errors.ts";
import { errorEventForBoundary, textDeltaWireEvent, wireEventsForLive } from "../event-mapping.ts";
import type { EnqueuedTurn, EnqueueTarget } from "../session-service.ts";
import { encodeSseEvent } from "../sse.ts";

interface ChatBody {
  readonly volumeSlug?: unknown;
  readonly message?: unknown;
  readonly sessionId?: unknown;
}

async function resolveTarget(deps: ApiDeps, body: ChatBody): Promise<EnqueueTarget> {
  if (body.sessionId !== undefined) {
    if (typeof body.sessionId !== "string") {
      throw new InvalidRequestError("sessionId must be a string when provided");
    }
    return { sessionId: body.sessionId };
  }

  if (typeof body.volumeSlug !== "string" || body.volumeSlug.trim().length === 0) {
    throw new InvalidRequestError("volumeSlug is required to start a new conversation");
  }
  const volume = toVolumeSlug(body.volumeSlug);
  await deps.volumeStore.getVolume(volume); // 404 volume_not_found if it doesn't exist
  return { volume };
}

export async function postChat(deps: ApiDeps, req: BunRequest<"/api/chat">): Promise<Response> {
  const body = (await req.json()) as ChatBody;
  if (typeof body.message !== "string" || body.message.trim().length === 0) {
    throw new InvalidRequestError("message is required and must be a non-empty string");
  }
  const message = body.message;

  // Validation, target resolution, AND the enqueue itself all happen here,
  // BEFORE the stream opens — failures here (`invalid_request`,
  // `volume_not_found`, `session_not_found`, `turn_queue_busy`) are ordinary
  // JSON error responses (`error-mapping.ts`), not in-band SSE `error`
  // events, because headers/status can still change at this point. Only
  // failures *during* the turn itself (inside the `ReadableStream`, below)
  // become in-band `error` events, per `docs/API.md`: "error — terminal for
  // this turn."
  const target = await resolveTarget(deps, body);
  const enqueued: EnqueuedTurn = await deps.sessionService.enqueueTurn(target, message);

  // Guards against a disconnected client (`cancel()` below) racing the
  // draining loop: without `closed`, a client that goes away mid-turn lets
  // this loop keep pulling from `enqueued.events`, `send()` then throws
  // trying to `enqueue` on an already-closed/errored controller, the
  // `catch` below turns that into an `error` SSE event on a dead stream
  // (itself another `enqueue` on a closed controller), and `finally` then
  // double-closes. `closed` short-circuits every one of those once either
  // `cancel()` fires or the loop finishes on its own.
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encodeSseEvent(event, data));
        } catch {
          // Controller already closed/errored out from under us — nothing
          // left to do; `closed` should already be true, but set it
          // defensively so no later `send`/`close` call tries again.
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
      send("session", { sessionId: enqueued.sessionId });

      // Shadow can be legitimately silent for a long time — a research brief
      // that fetches several pages, then a Tier 2 audit, can easily outlast any
      // fixed server timeout. An SSE comment line is a no-op to every client
      // (EventSource and our own parser both ignore lines beginning with ":")
      // but counts as traffic, so it keeps both this connection and the dev
      // proxy's from going idle. Without it the stream is severed mid-turn and
      // the operator sees a bare "network error" rather than whatever Shadow
      // was about to report.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
        } catch {
          closed = true;
        }
      }, 5_000);

      // Set the instant an `error` wire event is sent (either from a
      // thrown-error boundary record, or an agent-emitted `{type:"error"}`
      // `ShadowEvent`) — `docs/API.md`: "error — terminal for this turn," so
      // `done` must never follow it on the same turn. Deferring the `done`
      // decision to after the loop (rather than an early `close(); return;`
      // the moment an error is seen, the old design) is safe here because
      // the underlying turn generator always ends right after an error
      // anyway (`@shadow/agent`'s `sendMessage` returns as soon as a turn
      // fails) — there is nothing more to drain either way.
      let errorSent = false;

      try {
        for await (const msg of enqueued.events) {
          if (closed) break; // client disconnected (cancel()) mid-turn — stop reading, the turn keeps running server-side regardless
          if (msg.kind === "text-delta") {
            // No stored shape at all (`@shadow/sessions` never persists
            // deltas) — forwarded straight to the wire via the same
            // mapping T2.7's replay+follow uses for its own live tail.
            const wire = textDeltaWireEvent(msg.text);
            send(wire.event, wire.data);
            continue;
          }
          if (msg.kind === "ended") {
            // Structurally unreachable here (T3.1): `enqueueTurn`'s own
            // per-turn bus filter (`session-service.ts`) never forwards an
            // `"ended"` message to a specific turn's channel — deleting a
            // session 409s while any turn is running/queued, so this turn's
            // channel is always already closed by the time one could ever be
            // published. Handled for type-safety/forward-compat, not because
            // this path is expected to run.
            continue;
          }
          const { event } = msg.record;
          if (event.type === "turn-boundary") {
            // No wire representation for the boundary record itself
            // (`wireEventsFromStored` already maps it to `[]`) — but a
            // thrown-error `ended` boundary is the ONE place a thrown
            // failure's message/code survive for the wire (T2.1's schema;
            // an agent-emitted `{type:"error"}` event, by contrast, is an
            // ordinary stored event already handled by `wireEventsForLive`
            // below). `errorEventForBoundary` is the shared synthesis T2.7's
            // replay+follow reuses for the identical case.
            const errorWire = errorEventForBoundary(event);
            if (errorWire) {
              send(errorWire.event, errorWire.data);
              errorSent = true;
            }
            continue;
          }
          for (const wire of wireEventsForLive(event)) {
            send(wire.event, wire.data);
            if (wire.event === "error") errorSent = true;
          }
        }
        if (!errorSent) send("done", {});
      } catch (error) {
        // Reachable only for a failure in THIS handler's own consumption
        // (e.g. `send` throwing into a genuinely broken controller state
        // `closed` didn't already catch) — the turn's own failures are
        // delivered as ordinary events through the loop above, never thrown
        // out of it.
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
    // Fires when the client disconnects (nav away, tab close, aborted
    // fetch) before the turn finishes. Unlike the pre-T2.5 design, calling
    // `.return()` here does NOT kill the turn — `enqueued.events` is a
    // generator over a session-bus *subscription*
    // (`session-service.ts`'s `drainChannel`), not over the turn's own
    // draining loop; `.return()` only runs that generator's `finally`
    // (unsubscribe) and stops this handler's own loop promptly instead of
    // leaving it blocked waiting on the next bus message. The turn itself
    // keeps running server-side, tee'd into the store, exactly as if this
    // viewer had never disconnected (T2.5's whole point).
    async cancel() {
      closed = true;
      await enqueued.events.return(undefined);
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
