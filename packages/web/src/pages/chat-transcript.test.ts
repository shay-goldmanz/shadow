import { describe, expect, test } from "bun:test";
import type { ChatStreamEvent } from "../api/types.ts";
import {
  appendUserMessage,
  applyStreamEvent,
  INITIAL_CHAT_STATE,
  type TranscriptItem,
} from "./chat-transcript.ts";

function types(items: readonly TranscriptItem[]): readonly string[] {
  return items.map((i) => i.type);
}

describe("chat transcript reducer", () => {
  test("renders streamed events in arrival order, including research progress", () => {
    const events: ChatStreamEvent[] = [
      { event: "session", data: { sessionId: "sess_1" } },
      { event: "text", data: { delta: "Looking into it." } },
      {
        event: "research.started",
        data: { briefId: "b1", brief: { volume: "v", goal: "How does Linear design UI?" } },
      },
      {
        event: "research.source",
        data: { sourceId: "src_1", url: "https://linear.app", title: "Linear" },
      },
      {
        event: "research.finished",
        data: { briefId: "b1", findings: [{ text: "4px scale", citations: [] }] },
      },
      { event: "chapter.drafted", data: { volume: "v", chapter: "c" } },
      { event: "audit", data: { volume: "v", chapter: "c", passed: true, repairs: [] } },
      { event: "chapter.published", data: { volume: "v", chapter: "c" } },
      { event: "done", data: {} },
    ];

    let state = appendUserMessage(INITIAL_CHAT_STATE, "I believe in Linear's design.");
    for (const event of events) state = applyStreamEvent(state, event);

    expect(types(state.items)).toEqual([
      "user",
      "assistant",
      "research.started",
      "research.source",
      "research.finished",
      "chapter.drafted",
      "audit",
      "chapter.published",
    ]);
    expect(state.sessionId).toBe("sess_1");
    expect(state.streaming).toBe(false);
  });

  test("consecutive text deltas coalesce into one growing assistant message", () => {
    let state = INITIAL_CHAT_STATE;
    state = applyStreamEvent(state, { event: "text", data: { delta: "Hello" } });
    state = applyStreamEvent(state, { event: "text", data: { delta: ", operator" } });
    state = applyStreamEvent(state, { event: "text", data: { delta: "." } });

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ type: "assistant", text: "Hello, operator." });
  });

  test("a chapter.restated event is kept as its own visible item, not swallowed", () => {
    let state = INITIAL_CHAT_STATE;
    state = applyStreamEvent(state, {
      event: "chapter.restated",
      data: {
        claim: "epoch-three-colours",
        from: "always uses exactly three colours",
        to: "this issue uses exactly three colours",
        reason: "overreached the source",
        outcome: "applied",
      },
    });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      type: "chapter.restated",
      claim: "epoch-three-colours",
    });
  });

  test("a research.failed event is kept, not swallowed and not a state-wiping crash", () => {
    let state = INITIAL_CHAT_STATE;
    state = applyStreamEvent(state, {
      event: "research.failed",
      data: {
        briefId: "b1",
        brief: { volume: "v", goal: "goal" },
        error: "network unavailable",
      },
    });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ type: "research.failed", error: "network unavailable" });
  });

  test("chapter.published and chapter.rejected are both kept, not swallowed", () => {
    let state = INITIAL_CHAT_STATE;
    state = applyStreamEvent(state, {
      event: "chapter.published",
      data: { volume: "v", chapter: "c1" },
    });
    state = applyStreamEvent(state, {
      event: "chapter.rejected",
      data: { volume: "v", chapter: "c2", issues: [{ code: "C3", message: "unsupported" }] },
    });
    expect(types(state.items)).toEqual(["chapter.published", "chapter.rejected"]);
  });

  test("an unhandled event never silently wipes the transcript (regression: reducer used to have no default and returned undefined)", () => {
    let state = INITIAL_CHAT_STATE;
    state = applyStreamEvent(state, { event: "text", data: { delta: "before" } });
    // Every real `ChatStreamEvent` variant is handled; feed each of the
    // "forwarded but no doc row" ones through in sequence and confirm the
    // transcript accumulates rather than ever collapsing to nothing.
    state = applyStreamEvent(state, {
      event: "research.failed",
      data: { briefId: "b1", brief: { volume: "v", goal: "g" }, error: "e" },
    });
    state = applyStreamEvent(state, {
      event: "chapter.published",
      data: { volume: "v", chapter: "c" },
    });
    state = applyStreamEvent(state, {
      event: "chapter.rejected",
      data: { volume: "v", chapter: "c", issues: [] },
    });
    expect(state).toBeDefined();
    expect(state.items.length).toBe(4);
  });

  test("an error event stops streaming but is preserved in the transcript", () => {
    let state = { ...INITIAL_CHAT_STATE, streaming: true };
    state = applyStreamEvent(state, {
      event: "error",
      data: { message: "research failed", code: "research_failed" },
    });
    expect(state.streaming).toBe(false);
    expect(state.items[0]).toMatchObject({ type: "error", message: "research failed" });
  });

  describe("T1.4: retryable errors", () => {
    test("a terminal error marks itself retryable, retaining the failed operator text", () => {
      let state = appendUserMessage(INITIAL_CHAT_STATE, "believe X and write it up");
      state = applyStreamEvent(state, {
        event: "error",
        data: { message: "overloaded", code: "upstream_error" },
      });

      const errorItem = state.items[state.items.length - 1];
      expect(errorItem).toMatchObject({
        type: "error",
        retry: { text: "believe X and write it up" },
      });
    });

    test("an error with no preceding operator message is not retryable", () => {
      let state = INITIAL_CHAT_STATE;
      state = applyStreamEvent(state, {
        event: "error",
        data: { message: "boom", code: "stream_failed" },
      });
      expect(state.items[0]).toMatchObject({ type: "error", retry: undefined });
    });

    test("an error mid-turn retains the operator text even after other events landed first", () => {
      let state = appendUserMessage(INITIAL_CHAT_STATE, "second attempt please");
      state = applyStreamEvent(state, { event: "text", data: { delta: "working on it" } });
      state = applyStreamEvent(state, {
        event: "research.started",
        data: { briefId: "b1", brief: { volume: "v", goal: "g" } },
      });
      state = applyStreamEvent(state, {
        event: "error",
        data: { message: "network drop", code: "stream_failed" },
      });

      const errorItem = state.items[state.items.length - 1];
      expect(errorItem).toMatchObject({
        type: "error",
        retry: { text: "second attempt please" },
      });
    });

    test("a subsequent send supersedes (clears) a prior retryable error", () => {
      let state = appendUserMessage(INITIAL_CHAT_STATE, "first attempt");
      state = applyStreamEvent(state, {
        event: "error",
        data: { message: "overloaded", code: "upstream_error" },
      });
      const firstErrorId = state.items[state.items.length - 1]?.id;
      expect(state.items.find((i) => i.id === firstErrorId)).toMatchObject({
        retry: { text: "first attempt" },
      });

      // Retrying re-sends the same text through the ordinary send path,
      // which is just another `appendUserMessage` call.
      state = appendUserMessage(state, "first attempt");

      // The old error item is still in the transcript (history is kept),
      // but it is no longer retryable — a new turn has begun.
      expect(state.items.find((i) => i.id === firstErrorId)).toMatchObject({ retry: undefined });
      expect(types(state.items)).toEqual(["user", "error", "user"]);
    });

    test("non-error flows are unaffected: no retry field appears anywhere else", () => {
      let state = INITIAL_CHAT_STATE;
      state = applyStreamEvent(state, {
        event: "chapter.published",
        data: { volume: "v", chapter: "c" },
      });
      for (const item of state.items) {
        expect(item).not.toHaveProperty("retry");
      }
    });
  });

  test("text after a non-assistant item starts a new bubble rather than merging", () => {
    let state = INITIAL_CHAT_STATE;
    state = applyStreamEvent(state, { event: "text", data: { delta: "first" } });
    state = applyStreamEvent(state, {
      event: "research.started",
      data: { briefId: "b1", brief: { volume: "v", goal: "b" } },
    });
    state = applyStreamEvent(state, { event: "text", data: { delta: "second" } });

    expect(types(state.items)).toEqual(["assistant", "research.started", "assistant"]);
    expect(state.items[2]).toMatchObject({ text: "second" });
  });
});
