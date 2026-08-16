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
  RulebookResult,
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
    }
  | {
      readonly id: string;
      readonly type: "rulebook.started";
      readonly slug: string;
      readonly docPath: string;
    }
  | {
      readonly id: string;
      readonly type: "rulebook.planned";
      readonly slug: string;
      readonly chunkCount: number;
      readonly groups: readonly string[];
    }
  | {
      readonly id: string;
      readonly type: "rulebook.progress";
      readonly slug: string;
      readonly completed: number;
      readonly total: number;
      readonly rulesSoFar: number;
      /** Running tally across every `rulebook.chunk` event coalesced into this one row — each event only reports whether *that* chunk was cached/failed, not a cumulative count. */
      readonly cachedCount: number;
      readonly failedCount: number;
    }
  | {
      readonly id: string;
      readonly type: "rulebook.merged";
      readonly slug: string;
      readonly ruleCount: number;
      readonly droppedQuotes: number;
      readonly consolidated: number;
    }
  | {
      readonly id: string;
      readonly type: "rulebook.group.audited";
      readonly slug: string;
      readonly group: string;
      readonly passed: boolean;
      readonly repairs: number;
      readonly issues: readonly string[];
    }
  | {
      readonly id: string;
      readonly type: "rulebook.completed";
      readonly slug: string;
      readonly result: RulebookResult;
    }
  | {
      readonly id: string;
      readonly type: "rulebook.failed";
      readonly slug: string;
      readonly error: string;
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

    case "rulebook.started":
      return withItem(state, {
        type: "rulebook.started",
        slug: event.data.slug,
        docPath: event.data.docPath,
      });

    case "rulebook.planned":
      return withItem(state, {
        type: "rulebook.planned",
        slug: event.data.slug,
        chunkCount: event.data.chunkCount,
        groups: event.data.groups,
      });

    case "rulebook.chunk": {
      // Coalesces, like `text`'s trailing-bubble merge above — but keyed by
      // `slug` rather than "the last item", since a run's chunk events are
      // the only thing streaming for most of a rule book's lifetime and
      // must collapse into one live row, not append dozens (a large source
      // document can emit 100+ of these per run).
      const index = state.items.findIndex(
        (item) => item.type === "rulebook.progress" && item.slug === event.data.slug,
      );
      if (index === -1) {
        return withItem(state, {
          type: "rulebook.progress",
          slug: event.data.slug,
          completed: event.data.completed,
          total: event.data.total,
          rulesSoFar: event.data.rulesSoFar,
          cachedCount: event.data.cached ? 1 : 0,
          failedCount: event.data.failed ? 1 : 0,
        });
      }
      const existing = state.items[index] as Extract<TranscriptItem, { type: "rulebook.progress" }>;
      const updated: TranscriptItem = {
        ...existing,
        completed: event.data.completed,
        total: event.data.total,
        rulesSoFar: event.data.rulesSoFar,
        cachedCount: existing.cachedCount + (event.data.cached ? 1 : 0),
        failedCount: existing.failedCount + (event.data.failed ? 1 : 0),
      };
      const items = [...state.items];
      items[index] = updated;
      return { ...state, items };
    }

    case "rulebook.merged":
      return withItem(state, {
        type: "rulebook.merged",
        slug: event.data.slug,
        ruleCount: event.data.ruleCount,
        droppedQuotes: event.data.droppedQuotes,
        consolidated: event.data.consolidated,
      });

    case "rulebook.group.audited":
      return withItem(state, {
        type: "rulebook.group.audited",
        slug: event.data.slug,
        group: event.data.group,
        passed: event.data.passed,
        repairs: event.data.repairs,
        issues: event.data.issues,
      });

    case "rulebook.completed":
      return withItem(state, {
        type: "rulebook.completed",
        slug: event.data.slug,
        result: event.data.result,
      });

    case "rulebook.failed":
      return withItem(state, {
        type: "rulebook.failed",
        slug: event.data.slug,
        error: event.data.error,
      });

    case "error":
      return {
        ...withItem(state, { type: "error", message: event.data.message, code: event.data.code }),
        streaming: false,
      };

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
