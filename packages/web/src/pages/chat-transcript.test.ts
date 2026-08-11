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
      { event: "research.started", data: { brief: "How does Linear design UI?" } },
      {
        event: "research.source",
        data: { sourceId: "src_1", url: "https://linear.app", title: "Linear" },
      },
      { event: "research.finished", data: { briefId: "b1", findings: "4px scale" } },
      { event: "chapter.drafted", data: { volume: "v", chapter: "c" } },
      { event: "audit", data: { chapter: "c", verdict: "pass", findings: [] } },
      { event: "indexed", data: { volume: "v", stats: { volumes: 1, chapters: 1, tokens: 10 } } },
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
      "indexed",
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

  test("an error event stops streaming but is preserved in the transcript", () => {
    let state = { ...INITIAL_CHAT_STATE, streaming: true };
    state = applyStreamEvent(state, {
      event: "error",
      data: { message: "research failed", code: "research_failed" },
    });
    expect(state.streaming).toBe(false);
    expect(state.items[0]).toMatchObject({ type: "error", message: "research failed" });
  });

  test("text after a non-assistant item starts a new bubble rather than merging", () => {
    let state = INITIAL_CHAT_STATE;
    state = applyStreamEvent(state, { event: "text", data: { delta: "first" } });
    state = applyStreamEvent(state, {
      event: "research.started",
      data: { brief: "b" },
    });
    state = applyStreamEvent(state, { event: "text", data: { delta: "second" } });

    expect(types(state.items)).toEqual(["assistant", "research.started", "assistant"]);
    expect(state.items[2]).toMatchObject({ text: "second" });
  });
});
