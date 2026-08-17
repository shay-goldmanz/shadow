/**
 * `POST /api/chat` (`docs/API.md` §Chat). Drives one `ShadowConversation`
 * turn and streams its `ShadowEvent`s back as SSE.
 *
 * ## Session reuse (D6) and the divergence in what "sessionId" means
 *
 * `docs/API.md` ties the `session` SSE event to D6's session-reuse
 * argument (the ~18k-token preamble cost), which suggests the underlying
 * `AgenticSession`'s own id. That id (`ShadowConversation.sessionId`,
 * `@shadow/agent`) is `undefined` until the *first* model turn completes —
 * unusable as "the first event" of a turn that hasn't started yet. What
 * actually makes D6 reuse happen in this codebase is holding the same
 * `ShadowConversation` *instance* in memory and calling `sendMessage`
 * again on it (`conversation.ts`'s `getOrCreateSession` caches `this.session`
 * across calls). So this handler exposes `ShadowConversation.id` — stable
 * from construction, before any turn runs — as the wire `sessionId`, and
 * keeps a bounded `sessionId -> ShadowConversation` registry
 * (`ApiDeps.conversations`, `ConversationRegistry`) so a client that echoes
 * it back resumes the same instance, and therefore the same underlying
 * `AgenticSession`. Flagged for `docs/API.md` to confirm or correct.
 *
 * ## Mapping ShadowEvent -> docs/API.md's SSE table
 *
 * The mapping itself — every `ShadowEvent` case, every wire field, and why
 * each gap from `docs/API.md`'s table is what it is — now lives in
 * `../event-mapping.ts` (T2.2), shared with replay (T2.7). This handler's
 * job is just the live-specific wiring around it: stream `text-delta`s
 * straight through (they have no stored shape at all), stamp every other
 * event through a per-turn `StoredEventStamper` (brief-id correlation,
 * `../event-mapping.ts`), and run the stamped result through
 * `wireEventsForLive`.
 */

import { randomUUID } from "node:crypto";
import type { ShadowConversation, ShadowEvent } from "@shadow/agent";
import { toVolumeSlug } from "@shadow/core";
import type { BunRequest } from "bun";
import type { ApiDeps } from "../deps.ts";
import { toErrorResponse } from "../error-mapping.ts";
import { InvalidRequestError, SessionNotFoundError } from "../errors.ts";
import { operatorMessageEvent, StoredEventStamper, wireEventsForLive } from "../event-mapping.ts";
import { encodeSseEvent } from "../sse.ts";

interface ChatBody {
  readonly volumeSlug?: unknown;
  readonly message?: unknown;
  readonly sessionId?: unknown;
}

async function resolveConversation(
  deps: ApiDeps,
  body: ChatBody,
): Promise<{ conversation: ShadowConversation; sessionId: string }> {
  if (body.sessionId !== undefined) {
    if (typeof body.sessionId !== "string") {
      throw new InvalidRequestError("sessionId must be a string when provided");
    }
    const conversation = deps.conversations.get(body.sessionId);
    if (!conversation) throw new SessionNotFoundError(body.sessionId);
    return { conversation, sessionId: body.sessionId };
  }

  if (typeof body.volumeSlug !== "string" || body.volumeSlug.trim().length === 0) {
    throw new InvalidRequestError("volumeSlug is required to start a new conversation");
  }
  const volume = toVolumeSlug(body.volumeSlug);
  await deps.volumeStore.getVolume(volume); // 404 volume_not_found if it doesn't exist

  const conversation = deps.shadowAgent.startConversation(volume);
  deps.conversations.set(conversation.id, conversation);
  return { conversation, sessionId: conversation.id };
}

export async function postChat(deps: ApiDeps, req: BunRequest<"/api/chat">): Promise<Response> {
  const body = (await req.json()) as ChatBody;
  if (typeof body.message !== "string" || body.message.trim().length === 0) {
    throw new InvalidRequestError("message is required and must be a non-empty string");
  }
  const message = body.message;

  // Validation and session lookup happen here, BEFORE the stream opens —
  // failures here are ordinary JSON error responses (`error-mapping.ts`),
  // not in-band SSE `error` events, because headers/status can still
  // change at this point. Only failures *during* the turn itself (inside
  // the `ReadableStream`, below) become in-band `error` events, per
  // `docs/API.md`: "error — terminal for this turn."
  const { conversation, sessionId } = await resolveConversation(deps, body);

  // Guards against a disconnected client (`cancel()` below) racing the
  // generator loop: without `closed`, a client that goes away mid-turn lets
  // `conversation.sendMessage`'s generator keep running, `send()` then
  // throws trying to `enqueue` on an already-closed/errored controller, the
  // `catch` below turns that into an `error` SSE event on a dead stream
  // (itself another `enqueue` on a closed controller), and `finally` then
  // double-closes. `closed` short-circuits every one of those once either
  // `cancel()` fires or the turn finishes on its own.
  let closed = false;
  let iterator: AsyncGenerator<ShadowEvent> | undefined;

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
      send("session", { sessionId });

      // The user bubble. Synthesized here (`@shadow/agent` never emits an
      // `operator-message` `ShadowEvent` — see `../event-mapping.ts`'s
      // doc), at the point the turn starts, so a second live viewer of this
      // same session sees it too, and so live and replayed transcripts
      // render identically (T2.2). Stored-shape identical to what T2.5's
      // tee will later append for this same turn.
      for (const wire of wireEventsForLive(operatorMessageEvent(message))) {
        send(wire.event, wire.data);
      }

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

      // Turn-scoped: mints/stamps `briefId`s while `research-started`'s
      // `ResearchBrief` object identity still correlates it to the same
      // brief's later `research-completed`/`-failed` (`../event-mapping.ts`).
      // A fresh stamper per turn keeps ids unique across turns too — the
      // `turnId` prefix, not just the per-stamper counter.
      const turnId = randomUUID();
      const stamper = new StoredEventStamper(turnId);

      try {
        iterator = conversation.sendMessage(message) as AsyncGenerator<ShadowEvent>;
        for await (const event of iterator) {
          if (closed) break; // client disconnected (cancel()) mid-turn — stop draining the generator
          if (event.type === "text-delta") {
            // No stored shape at all (`@shadow/sessions` never persists
            // deltas) — streamed straight to the wire as `@shadow/agent`
            // produces it, chunk by chunk.
            send("text", { delta: event.text });
            continue;
          }
          const stored = stamper.stampAgentEvent(event);
          for (const wire of wireEventsForLive(stored)) {
            send(wire.event, wire.data);
          }
          if (event.type === "error") {
            close();
            return;
          }
        }
        send("done", {});
      } catch (error) {
        if (!closed) {
          const mapped = toErrorResponse(error);
          send("error", { message: mapped.body.error.message, code: mapped.body.error.code });
        }
      } finally {
        clearInterval(heartbeat);
        close();
      }
    },
    // Fires when the client disconnects (nav away, tab close, aborted
    // fetch) before the turn finishes. Without this, `conversation`'s
    // generator keeps running to completion against a controller nobody
    // can read from anymore — `send()` would throw into the `catch` above,
    // which would `send("error", ...)` on the same dead controller, and
    // `finally` would then close it a second time. Terminating the
    // generator via `.return()` stops that chain at the source rather than
    // papering over its symptoms downstream.
    async cancel() {
      closed = true;
      await iterator?.return?.(undefined);
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
