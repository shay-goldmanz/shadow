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

export function appendUserMessage(state: ChatState, text: string): ChatState {
  // A new send supersedes any retryable error left over from a prior turn —
  // its "Retry last message" affordance would otherwise still offer to
  // resend text that a fresh turn has already moved past.
  const items = state.items.map((item) =>
    item.type === "error" && item.retry ? { ...item, retry: undefined } : item,
  );
  return withItem({ ...state, items }, { type: "user", text });
}

export function beginStreaming(state: ChatState): ChatState {
  return { ...state, streaming: true };
}

/** Folds one SSE event into the transcript, in arrival order. Consecutive `text` deltas coalesce into one growing assistant bubble. */
export function applyStreamEvent(state: ChatState, event: ChatStreamEvent): ChatState {
  switch (event.event) {
    case "session":
      return { ...state, sessionId: event.data.sessionId };

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
      const lastUserItem = [...state.items].reverse().find((item) => item.type === "user");
      return {
        ...withItem(state, {
          type: "error",
          message: event.data.message,
          code: event.data.code,
          retry: lastUserItem ? { text: lastUserItem.text } : undefined,
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

function withItem(state: ChatState, item: DistributiveOmit<TranscriptItem, "id">): ChatState {
  const id = `evt-${state.nextId}`;
  return {
    ...state,
    items: [...state.items, { ...item, id } as TranscriptItem],
    nextId: state.nextId + 1,
  };
}
