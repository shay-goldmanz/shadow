/**
 * Pure reducer turning the chat SSE stream (docs/API.md) into a transcript
 * the UI renders. Kept separate from any component so event-ordering and
 * text-delta coalescing are unit-testable without a DOM.
 */

import type { AuditFinding, ChatStreamEvent, IndexStats } from "../api/types.ts";

export type TranscriptItem =
  | { readonly id: string; readonly type: "user"; readonly text: string }
  | { readonly id: string; readonly type: "assistant"; readonly text: string }
  | { readonly id: string; readonly type: "research.started"; readonly brief: string }
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
      readonly findings: string;
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
      readonly chapter: string;
      readonly verdict: "pass" | "fail";
      readonly findings: readonly AuditFinding[];
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
      readonly type: "indexed";
      readonly volume: string;
      readonly stats: IndexStats;
    }
  | {
      readonly id: string;
      readonly type: "error";
      readonly message: string;
      readonly code: string;
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

    case "chapter.drafted":
      return withItem(state, {
        type: "chapter.drafted",
        volume: event.data.volume,
        chapter: event.data.chapter,
      });

    case "audit":
      return withItem(state, {
        type: "audit",
        chapter: event.data.chapter,
        verdict: event.data.verdict,
        findings: event.data.findings,
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

    case "indexed":
      return withItem(state, {
        type: "indexed",
        volume: event.data.volume,
        stats: event.data.stats,
      });

    case "error":
      return {
        ...withItem(state, { type: "error", message: event.data.message, code: event.data.code }),
        streaming: false,
      };

    case "done":
      return { ...state, streaming: false };
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
