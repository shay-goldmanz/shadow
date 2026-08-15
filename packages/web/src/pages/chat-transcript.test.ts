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

  test("rulebook.started, rulebook.planned, rulebook.merged, rulebook.completed, and rulebook.failed each get their own row", () => {
    let state = INITIAL_CHAT_STATE;
    state = applyStreamEvent(state, {
      event: "rulebook.started",
      data: { slug: "loan-rules", docPath: "/rnb_loan.pdf" },
    });
    state = applyStreamEvent(state, {
      event: "rulebook.planned",
      data: { slug: "loan-rules", chunkCount: 4, groups: ["Interest & Fees"] },
    });
    state = applyStreamEvent(state, {
      event: "rulebook.merged",
      data: { slug: "loan-rules", ruleCount: 8, droppedQuotes: 0, consolidated: 1 },
    });
    state = applyStreamEvent(state, {
      event: "rulebook.completed",
      data: {
        slug: "loan-rules",
        result: {
          slug: "loan-rules",
          sourceId: "src_loan",
          ruleCount: 8,
          groupCount: 1,
          publishedGroups: ["interest-and-fees"],
          rejectedGroups: [],
          failedChunks: 0,
          assemblyDroppedQuotes: 0,
          assemblyDroppedRules: 0,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          status: "stable",
        },
      },
    });
    state = applyStreamEvent(state, {
      event: "rulebook.failed",
      data: { slug: "loan-rules", error: "extraction crashed" },
    });

    expect(types(state.items)).toEqual([
      "rulebook.started",
      "rulebook.planned",
      "rulebook.merged",
      "rulebook.completed",
      "rulebook.failed",
    ]);
  });

  test("rulebook.group.audited is kept as its own row, one per group, not swallowed", () => {
    let state = INITIAL_CHAT_STATE;
    state = applyStreamEvent(state, {
      event: "rulebook.group.audited",
      data: { slug: "loan-rules", group: "interest-and-fees", passed: true, repairs: 0, issues: [] },
    });
    state = applyStreamEvent(state, {
      event: "rulebook.group.audited",
      data: {
        slug: "loan-rules",
        group: "default-and-remedies",
        passed: false,
        repairs: 1,
        issues: ["generalizes beyond the cited clause"],
      },
    });

    expect(types(state.items)).toEqual(["rulebook.group.audited", "rulebook.group.audited"]);
    expect(state.items[0]).toMatchObject({ group: "interest-and-fees", passed: true });
    expect(state.items[1]).toMatchObject({
      group: "default-and-remedies",
      passed: false,
      issues: ["generalizes beyond the cited clause"],
    });
  });

  test("two rulebook.chunk events coalesce into ONE progress item with updated numbers, not two rows", () => {
    let state = INITIAL_CHAT_STATE;
    state = applyStreamEvent(state, {
      event: "rulebook.chunk",
      data: { slug: "loan-rules", completed: 1, total: 4, rulesSoFar: 2, cached: false, failed: false },
    });
    state = applyStreamEvent(state, {
      event: "rulebook.chunk",
      data: { slug: "loan-rules", completed: 2, total: 4, rulesSoFar: 5, cached: true, failed: false },
    });

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      type: "rulebook.progress",
      slug: "loan-rules",
      completed: 2,
      total: 4,
      rulesSoFar: 5,
      cachedCount: 1,
      failedCount: 0,
    });
  });

  test("rulebook.chunk's cached/failed counts accumulate across every chunk, not just the latest", () => {
    let state = INITIAL_CHAT_STATE;
    const chunks = [
      { completed: 1, total: 3, rulesSoFar: 1, cached: false, failed: false },
      { completed: 2, total: 3, rulesSoFar: 2, cached: true, failed: false },
      { completed: 3, total: 3, rulesSoFar: 3, cached: false, failed: true },
    ];
    for (const chunk of chunks) {
      state = applyStreamEvent(state, {
        event: "rulebook.chunk",
        data: { slug: "loan-rules", ...chunk },
      });
    }

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      completed: 3,
      total: 3,
      rulesSoFar: 3,
      cachedCount: 1,
      failedCount: 1,
    });
  });

  test("rulebook.chunk events for different slugs (two concurrent runs) coalesce independently", () => {
    let state = INITIAL_CHAT_STATE;
    state = applyStreamEvent(state, {
      event: "rulebook.chunk",
      data: { slug: "rules-a", completed: 1, total: 2, rulesSoFar: 1, cached: false, failed: false },
    });
    state = applyStreamEvent(state, {
      event: "rulebook.chunk",
      data: { slug: "rules-b", completed: 1, total: 2, rulesSoFar: 1, cached: false, failed: false },
    });
    state = applyStreamEvent(state, {
      event: "rulebook.chunk",
      data: { slug: "rules-a", completed: 2, total: 2, rulesSoFar: 3, cached: false, failed: false },
    });

    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toMatchObject({ slug: "rules-a", completed: 2, rulesSoFar: 3 });
    expect(state.items[1]).toMatchObject({ slug: "rules-b", completed: 1, rulesSoFar: 1 });
  });

  test("an unhandled rulebook event never silently wipes the transcript (same exhaustiveness guarantee as research/chapter events)", () => {
    let state = INITIAL_CHAT_STATE;
    state = applyStreamEvent(state, { event: "text", data: { delta: "before" } });
    state = applyStreamEvent(state, {
      event: "rulebook.started",
      data: { slug: "s", docPath: "/doc.pdf" },
    });
    state = applyStreamEvent(state, {
      event: "rulebook.planned",
      data: { slug: "s", chunkCount: 1, groups: [] },
    });
    state = applyStreamEvent(state, {
      event: "rulebook.chunk",
      data: { slug: "s", completed: 1, total: 1, rulesSoFar: 1, cached: false, failed: false },
    });
    state = applyStreamEvent(state, {
      event: "rulebook.merged",
      data: { slug: "s", ruleCount: 1, droppedQuotes: 0, consolidated: 0 },
    });
    state = applyStreamEvent(state, {
      event: "rulebook.group.audited",
      data: { slug: "s", group: "g", passed: true, repairs: 0, issues: [] },
    });
    state = applyStreamEvent(state, {
      event: "rulebook.failed",
      data: { slug: "s", error: "e" },
    });

    expect(state).toBeDefined();
    // 1 assistant bubble ("before") + 6 rulebook rows.
    expect(state.items.length).toBe(7);
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
