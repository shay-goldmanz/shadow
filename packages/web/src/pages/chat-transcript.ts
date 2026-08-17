/**
 * Pure reducer turning the chat SSE stream (`@shadow/api`'s real
 * `handlers/chat.ts` mapping, not `docs/API.md`'s table verbatim — see
 * `../api/types.ts`'s `ChatStreamEvent` doc) into a transcript the UI
 * renders. Kept separate from any component so event-ordering and
 * text-delta coalescing are unit-testable without a DOM.
 *
 * The `switch` in `applyStreamEvent` is exhaustive over every
 * `ChatStreamEvent` variant on purpose: a missing `case` used to fall
 * through with no `default`, so `applyStreamEvent` implicitly returned
 * `undefined` and silently wiped the whole transcript the next time an
 * unhandled event (`chapter.published`/`chapter.rejected`/`research.failed`
 * — real events the server sends, just never handled here) arrived
 * mid-stream. `event satisfies never` below is what makes a future
 * unhandled variant a compile error instead of a repeat of that bug.
 */

import type {
  ChatStreamEvent,
  CheckIssue,
  Finding,
  RepairDecision,
  ResearchBrief,
} from "../api/types.ts";

export type TranscriptItem =
  | { readonly id: string; readonly type: "user"; readonly text: string }
  | { readonly id: string; readonly type: "assistant"; readonly text: string }
  | { readonly id: string; readonly type: "research.started"; readonly brief: ResearchBrief }
  | {
      readonly id: string;
      readonly type: "research.source";
      readonly sourceId: string;
      readonly url: string;
      readonly title: string;
    }
  | {
      readonly id: string;
      readonly type: "research.finished";
      readonly briefId: string;
      readonly findings: readonly Finding[];
    }
  | {
      readonly id: string;
      readonly type: "research.failed";
      readonly briefId: string;
      readonly brief: ResearchBrief;
      readonly error: string;
    }
  | {
      readonly id: string;
      readonly type: "chapter.drafted";
      readonly volume: string;
      readonly chapter: string;
    }
  | {
      readonly id: string;
      readonly type: "audit";
      readonly volume: string;
      readonly chapter: string;
      readonly passed: boolean;
      readonly repairs: readonly RepairDecision[];
    }
  | {
      readonly id: string;
      readonly type: "chapter.restated";
      readonly claim: string;
      readonly from: string;
      readonly to: string;
      readonly reason: string;
      readonly outcome: "applied" | "escalated";
    }
  | {
      readonly id: string;
      readonly type: "chapter.published";
      readonly volume: string;
      readonly chapter: string;
    }
  | {
      readonly id: string;
      readonly type: "chapter.rejected";
      readonly volume: string;
      readonly chapter: string;
      readonly issues: readonly CheckIssue[];
    }
  | {
      readonly id: string;
      readonly type: "error";
      readonly message: string;
      readonly code: string;
      /**
       * Set when this error terminated the turn that was sending `text` —
       * the failed operator message, retained so `ChatPage` can offer
       * "Retry last message" and re-send the same text. `undefined` when
       * there was no preceding operator message to retry (shouldn't happen
       * in practice — every turn starts with one — but keeps the type
       * honest) or once superseded by a later send (see `appendUserMessage`).
       */
      readonly retry: { readonly text: string } | undefined;
    };

export interface ChatState {
  readonly sessionId: string | undefined;
  readonly items: readonly TranscriptItem[];
  readonly streaming: boolean;
  readonly nextId: number;
}

export const INITIAL_CHAT_STATE: ChatState = {
  sessionId: undefined,
  items: [],
  streaming: false,
  nextId: 0,
};

/**
 * F4 review fix — product-safety gating for the web "Retry last message"
 * affordance. Before this, EVERY terminal error offered a retry, including
 * codes guaranteed to refail identically. An ALLOWLIST, not a blocklist:
 * an unrecognized/future code defaults to NOT retryable, the safe choice
 * when its transience is unverified — matches `@shadow/model`'s
 * `conservativeRetryPolicy` philosophy one layer up (retry only known-good
 * signatures, never "anything not explicitly bad").
 *
 * Source of the vocabulary: `packages/api/src/error-mapping.ts`'s
 * `PILLAR_ERROR_TABLE` (every code the JSON error envelope can carry) plus
 * the two codes minted outside that table for chat's in-band SSE `error`
 * event specifically — `shadow_turn_error` (`handlers/chat.ts`'s own
 * `ShadowEvent` "error" case) and `stream_failed` (`ChatPage.tsx`'s
 * catch-all for a broken fetch/stream, a client-side fault with nothing to
 * do with `error-mapping.ts` at all).
 */
const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  // Shadow's own turn failed — an `isError` model result narrated in-band.
  // The same shape `@shadow/model`'s `conservativeRetryPolicy` already
  // retries a couple of times automatically before giving up; the
  // operator's manual retry is the same bet one layer up, for whatever
  // survived that automatic budget.
  "shadow_turn_error",
  // A broken fetch/stream on the client (network drop, an unparseable SSE
  // chunk) — nothing about the operator's message caused this.
  "stream_failed",
  // @shadow/agent's ShadowTurnFailedError / @shadow/model's
  // AgenticSessionError: transport/process faults on the model call itself,
  // never tied to a specific bad input — the same transient family
  // `conservativeRetryPolicy` treats as worth another attempt.
  "shadow_turn_failed",
  "agentic_session_failed",
  // @shadow/research: genuine network-layer faults reaching a source.
  "retrieval_network_error",
  "retrieval_timeout",
  // The catch-all for a truly unclassified server fault
  // (`error-mapping.ts`'s final fallback) — "unknown-ish" is more likely a
  // one-off than something a resend reproduces exactly.
  "internal_error",
]);
/*
 * Excluded, by category (never in the allowlist above) — why retrying the
 * SAME operator text cannot help:
 * - Validation / malformed input (`invalid_slug`, `reserved_frontmatter_key`,
 *   `invalid_id`, `invalid_digest`, `invalid_routing_field`,
 *   `claim_missing_required_field`, `unknown_source`,
 *   `unresolved_evidence_quote`, `chapter_has_no_claims`,
 *   `shadow_malformed_directive`, `invalid_json`) — the same input produces
 *   the same malformed request/directive every time.
 * - Not-found / already-exists (`volume_not_found`, `chapter_not_found`,
 *   `source_not_found`, `snapshot_not_found`, `claim_sidecar_not_found`,
 *   `node_not_found`, `volume_already_exists`) — a fact about the corpus's
 *   current state a resend cannot change.
 * - Quota / budget (`auto_turn_budget_exceeded`, `source_budget_exceeded`,
 *   `retrieval_payload_too_large`) — a hard cap already hit; retrying
 *   spends another turn to hit the exact same cap (this is the
 *   `AutoTurnBudgetExceededError` case the review flagged by name).
 * - Credentials (`subscription_auth_error`) — D5's guardrail; retrying
 *   cannot fix a bad/missing credential.
 * - Deterministic parse/config faults (`chapter_parse_error`,
 *   `volume_parse_error`, `ledger_corrupt`, `lint_config_error`,
 *   `chapter_index_build_failed`, `structured_generation_failed`,
 *   `retrieval_unsupported_content_type`, `skill_install_failed`) — on-disk
 *   state or a schema mismatch a resend of the same message does not touch.
 * - Ambiguous, defaulted to no (`retrieval_http_error`, `fixture_miss`,
 *   `fixture_corpus_error`, `live_search_unavailable`, `unbound_citation`,
 *   `no_findings_produced`, `research_turn_failed`, `research_agent_busy`) —
 *   plausible-but-unverified transience; the allowlist's safe default wins
 *   until one of these is confirmed worth retrying.
 */

function isRetryableErrorCode(code: string): boolean {
  return RETRYABLE_ERROR_CODES.has(code);
}

export function appendUserMessage(state: ChatState, text: string): ChatState {
  // Retry-flag clearing for a new user item lives in `withItem` itself now
  // (F5 review fix, see that function) — this is just the local-send path
  // to a user item, same as any future one (e.g. T2.8's `operator` wire
  // event) would be.
  return withItem(state, { type: "user", text });
}

export function beginStreaming(state: ChatState): ChatState {
  return { ...state, streaming: true };
}

/** Folds one SSE event into the transcript, in arrival order. Consecutive `text` deltas coalesce into one growing assistant bubble. */
export function applyStreamEvent(state: ChatState, event: ChatStreamEvent): ChatState {
  switch (event.event) {
    case "session":
      return { ...state, sessionId: event.data.sessionId };

    case "operator":
      // Defensive default (F7 review fix): swallowed for now — `ChatPage`
      // already appends its own local "user" transcript item the instant
      // the operator hits send (`appendUserMessage`), so rendering this
      // wire event too would duplicate the bubble. T2.8 is expected to
      // replace that local append with this wire event as the single
      // source of truth (so a second live viewer, or a replayed session,
      // sees the same user bubbles) — until then, this case exists so a
      // future stream carrying `operator` doesn't fall through to the
      // exhaustiveness check below and so the intent is on record, but it
      // deliberately leaves `state` untouched.
      return state;

    case "text": {
      const last = state.items[state.items.length - 1];
      if (last?.type === "assistant") {
        const merged: TranscriptItem = { ...last, text: last.text + event.data.delta };
        return { ...state, items: [...state.items.slice(0, -1), merged] };
      }
      return withItem(state, { type: "assistant", text: event.data.delta });
    }

    case "research.started":
      return withItem(state, { type: "research.started", brief: event.data.brief });

    case "research.source":
      return withItem(state, {
        type: "research.source",
        sourceId: event.data.sourceId,
        url: event.data.url,
        title: event.data.title,
      });

    case "research.finished":
      return withItem(state, {
        type: "research.finished",
        briefId: event.data.briefId,
        findings: event.data.findings,
      });

    case "research.failed":
      return withItem(state, {
        type: "research.failed",
        briefId: event.data.briefId,
        brief: event.data.brief,
        error: event.data.error,
      });

    case "chapter.drafted":
      return withItem(state, {
        type: "chapter.drafted",
        volume: event.data.volume,
        chapter: event.data.chapter,
      });

    case "audit":
      return withItem(state, {
        type: "audit",
        volume: event.data.volume,
        chapter: event.data.chapter,
        passed: event.data.passed,
        repairs: event.data.repairs,
      });

    case "chapter.restated":
      return withItem(state, {
        type: "chapter.restated",
        claim: event.data.claim,
        from: event.data.from,
        to: event.data.to,
        reason: event.data.reason,
        outcome: event.data.outcome,
      });

    case "chapter.published":
      return withItem(state, {
        type: "chapter.published",
        volume: event.data.volume,
        chapter: event.data.chapter,
      });

    case "chapter.rejected":
      return withItem(state, {
        type: "chapter.rejected",
        volume: event.data.volume,
        chapter: event.data.chapter,
        issues: event.data.issues,
      });

    case "error": {
      // The failed turn's operator message is the most recent "user" item —
      // input is disabled while a turn streams, so exactly one turn (and
      // therefore at most one candidate) can be in flight when it errors.
      let lastUserIndex = -1;
      for (let i = state.items.length - 1; i >= 0; i--) {
        if (state.items[i]?.type === "user") {
          lastUserIndex = i;
          break;
        }
      }
      const lastUserItem =
        lastUserIndex >= 0
          ? (state.items[lastUserIndex] as Extract<TranscriptItem, { type: "user" }>)
          : undefined;

      // F4 review fix (a): a chapter that already published between the
      // failed turn's operator message and this error is a COMMITTED side
      // effect — resending the same text would re-run the whole turn and
      // risk a duplicate publication, not just retry a no-op. Suppressed
      // regardless of the error code's own retryability below.
      const publishedSinceLastUser =
        lastUserIndex >= 0 &&
        state.items.slice(lastUserIndex + 1).some((item) => item.type === "chapter.published");

      // F4 review fix (b): even absent a committed side effect, only a
      // plausibly-transient code is worth resending for — see
      // `RETRYABLE_ERROR_CODES`'s doc above.
      const canRetry =
        lastUserItem !== undefined &&
        !publishedSinceLastUser &&
        isRetryableErrorCode(event.data.code);

      return {
        ...withItem(state, {
          type: "error",
          message: event.data.message,
          code: event.data.code,
          retry: canRetry ? { text: lastUserItem.text } : undefined,
        }),
        streaming: false,
      };
    }

    case "done":
      return { ...state, streaming: false };

    default:
      // Exhaustiveness check: a `ChatStreamEvent` variant added to
      // `../api/types.ts` without a matching `case` above is now a
      // compile error here, not a silent `undefined` return at runtime.
      event satisfies never;
      return state;
  }
}

/** `Omit` over a discriminated union collapses to the shared keys only; this distributes per member instead, so each variant keeps its own fields. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/**
 * Appends one item, minting its `id`. A new `"user"` item supersedes any
 * retryable error left over from a prior turn — its "Retry last message"
 * affordance would otherwise still offer to resend text that a fresh turn
 * has already moved past (T1.4). F5 review fix: this clearing used to live
 * only in `appendUserMessage`, the sole place that minted a `"user"` item —
 * but T2.8 will add a second source (the `operator` wire event, replacing
 * local user-bubble appending), which would have shipped with stale retry
 * buttons surviving a replay. Living here instead means ANY future source
 * of user items gets the clearing for free, by construction, without
 * having to remember to duplicate it.
 */
function withItem(state: ChatState, item: DistributiveOmit<TranscriptItem, "id">): ChatState {
  const id = `evt-${state.nextId}`;
  const items =
    item.type === "user"
      ? state.items.map((existing) =>
          existing.type === "error" && existing.retry
            ? { ...existing, retry: undefined }
            : existing,
        )
      : state.items;
  return {
    ...state,
    items: [...items, { ...item, id } as TranscriptItem],
    nextId: state.nextId + 1,
  };
}
