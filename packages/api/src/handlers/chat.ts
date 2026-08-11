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
 * Not one-to-one; see each `case` below for the specific gap. Summary for
 * the task report: `operator-turn-recorded` and `assistant-message` are
 * dropped (no doc row; the latter is redundant with the `text` deltas
 * that already sum to it). `research-failed` and `chapter-published` /
 * `chapter-rejected` have no doc row but are real `ShadowEvent`s Shadow
 * actually emits, so — per instruction to follow the real shape rather
 * than invent nothing — they are forwarded as `research.failed` /
 * `chapter.published` / `chapter.rejected`, dot-named to match the table's
 * own convention. `chapter.restated` (D9's visibility requirement) is
 * synthesized: `chapter-audit`'s `repairs[]` is the only place a
 * `RepairDecision` appears in `ShadowEvent`, so this handler unpacks one
 * `chapter.restated` per decision. `indexed` is never emitted for chat: see
 * the `chapter-audit` case below for why that is a real gap, not an
 * oversight.
 */

import type { ShadowConversation, ShadowEvent } from "@shadow/agent";
import { toVolumeSlug } from "@shadow/core";
import type { ResearchBrief } from "@shadow/research";
import type { BunRequest } from "bun";
import type { ApiDeps } from "../deps.ts";
import { toErrorResponse } from "../error-mapping.ts";
import { InvalidRequestError, SessionNotFoundError } from "../errors.ts";
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

      // Correlates a `research-started` brief with its later `research-completed`
      // / `research-failed` counterpart — `ShadowEvent` carries the same
      // `ResearchBrief` object reference across both yields
      // (`conversation.ts`'s `runResearchDirective`), but has no `briefId`
      // field of its own (`docs/API.md`'s `research.finished: { briefId, ... }`
      // assumes one exists; it doesn't, so this handler mints one).
      const briefIds = new WeakMap<ResearchBrief, string>();
      let briefCounter = 0;

      try {
        iterator = conversation.sendMessage(message) as AsyncGenerator<ShadowEvent>;
        for await (const event of iterator) {
          if (closed) break; // client disconnected (cancel()) mid-turn — stop draining the generator
          switch (event.type) {
            case "operator-turn-recorded":
              // No doc row — internal bookkeeping the operator doesn't need
              // to see; it's implied by having sent the message at all.
              break;
            case "text-delta":
              send("text", { delta: event.text });
              break;
            case "assistant-message":
              // No doc row, and redundant: concatenated `text` deltas
              // already reconstruct this exact string.
              break;
            case "research-started": {
              const briefId = `brief-${++briefCounter}`;
              briefIds.set(event.brief, briefId);
              send("research.started", { briefId, brief: event.brief });
              break;
            }
            case "research-completed": {
              const briefId = briefIds.get(event.brief) ?? "unknown";
              for (const source of event.result.sources) {
                send("research.source", {
                  sourceId: source.id,
                  url: source.url,
                  title: source.title,
                });
              }
              send("research.finished", { briefId, findings: event.result.findings });
              break;
            }
            case "research-failed": {
              // No doc row (the table only has started/source/finished for
              // research) — forwarded anyway: silently dropping a real
              // failure would contradict the table's own stated purpose
              // ("silence reads as failure").
              const briefId = briefIds.get(event.brief) ?? "unknown";
              send("research.failed", { briefId, brief: event.brief, error: event.error });
              break;
            }
            case "chapter-drafted":
              send("chapter.drafted", { volume: event.volume, chapter: event.chapter });
              break;
            case "chapter-audit": {
              // D9: what Shadow softened, and why, stays visible. One
              // `chapter.restated` per `RepairDecision`, emitted before the
              // summary `audit` event they contributed to.
              for (const repair of event.repairs) {
                send("chapter.restated", {
                  claim: repair.label,
                  from: repair.from,
                  to: repair.to,
                  reason: repair.reason,
                  outcome: repair.outcome,
                });
              }
              // `docs/API.md`'s `audit: { chapter, verdict, findings }` names
              // fields `ShadowEvent`'s `chapter-audit` doesn't carry (no
              // `AuditVerdict`, no per-claim findings — only `passed` and
              // `repairs`; the issue list arrives separately, below, on
              // `chapter-published`/`chapter-rejected`). Forwarded with the
              // real fields rather than a fabricated shape.
              send("audit", {
                volume: event.volume,
                chapter: event.chapter,
                passed: event.passed,
                repairs: event.repairs,
              });
              break;
            }
            case "chapter-published":
              // No doc row. `indexed: { volume, stats }` is what the table
              // has here instead, but `@shadow/agent`'s `publishChapter`
              // discards the `Indexer.reindex` result it triggers
              // internally (`packages/agent/src/publish.ts`), so this
              // handler has no `stats` to report without either changing
              // `@shadow/agent` (outside this package's boundary) or
              // re-running `indexer.reindex` itself here — which would
              // reindex twice and is exactly the kind of duplicated
              // domain logic the task rules out. `chapter.published`
              // already tells the operator the reindex succeeded
              // (`publishChapter` only reindexes on a passing verdict).
              send("chapter.published", { volume: event.volume, chapter: event.chapter });
              break;
            case "chapter-rejected":
              send("chapter.rejected", {
                volume: event.volume,
                chapter: event.chapter,
                issues: event.issues,
              });
              break;
            case "error":
              // `docs/API.md`: "terminal for this turn." `ShadowEvent`'s
              // `error` carries only a string, no stable code — this isn't
              // one of the typed pillar errors `error-mapping.ts` maps, it's
              // Shadow's own turn narrating its own failure.
              send("error", { message: event.error, code: "shadow_turn_error" });
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
