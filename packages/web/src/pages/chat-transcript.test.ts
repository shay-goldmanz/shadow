import { describe, expect, test } from "bun:test";
import type { ChatStreamEvent } from "../api/types.ts";
import {
  appendUserMessage,
  applyStreamEvent,
  INITIAL_CHAT_STATE,
  markInterruptedIfPending,
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

  // T2.8: the `operator` wire event is now the SINGLE source of user
  // bubbles — `ChatPage` no longer appends its own local one on send (the
  // F7 review fix's original swallow existed only because that local
  // append already covered it). Minting here means the sending tab renders
  // its own message exactly once, from the same event a second live viewer
  // or a replayed session sees.
  test("an operator event mints a user transcript item and marks the turn pending", () => {
    const after = applyStreamEvent(INITIAL_CHAT_STATE, {
      event: "operator",
      data: { text: "Hi Shadow." },
    });

    expect(types(after.items)).toEqual(["user"]);
    expect(after.items[0]).toMatchObject({ type: "user", text: "Hi Shadow." });
    expect(after.turnPending).toBe(true);
  });

  test("two operator events mint two distinct user items — no dedup, no double-append", () => {
    let state = applyStreamEvent(INITIAL_CHAT_STATE, {
      event: "operator",
      data: { text: "first" },
    });
    state = applyStreamEvent(state, { event: "done", data: {} });
    state = applyStreamEvent(state, { event: "operator", data: { text: "second" } });

    expect(types(state.items)).toEqual(["user", "user"]);
    expect(state.items.map((i) => (i.type === "user" ? i.text : undefined))).toEqual([
      "first",
      "second",
    ]);
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
        data: { message: "overloaded", code: "shadow_turn_error" },
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
        data: { message: "overloaded", code: "shadow_turn_error" },
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

    describe("F4 review fix (a): suppressed after a committed chapter publication", () => {
      test("a chapter.published item after the failed turn's user message suppresses retry, even for an otherwise-retryable code", () => {
        let state = appendUserMessage(INITIAL_CHAT_STATE, "believe X and write it up");
        state = applyStreamEvent(state, {
          event: "chapter.published",
          data: { volume: "v", chapter: "c" },
        });
        // A retryable code by itself would offer retry (see the allowlist
        // tests below) — the committed publication overrides that.
        state = applyStreamEvent(state, {
          event: "error",
          data: { message: "something failed after publishing", code: "shadow_turn_error" },
        });

        const errorItem = state.items[state.items.length - 1];
        expect(errorItem).toMatchObject({ type: "error", retry: undefined });
      });

      test("a chapter.published item from an EARLIER turn (before the current user message) does not suppress retry", () => {
        let state = appendUserMessage(INITIAL_CHAT_STATE, "first belief");
        state = applyStreamEvent(state, {
          event: "chapter.published",
          data: { volume: "v", chapter: "c1" },
        });
        // A fresh turn begins — this is a NEW user item; the earlier
        // publication is now before it, not after it.
        state = appendUserMessage(state, "second belief");
        state = applyStreamEvent(state, {
          event: "error",
          data: { message: "overloaded", code: "shadow_turn_error" },
        });

        const errorItem = state.items[state.items.length - 1];
        expect(errorItem).toMatchObject({
          type: "error",
          retry: { text: "second belief" },
        });
      });
    });

    describe("F4 review fix (b): retry gated on an allowlist of plausibly-transient codes", () => {
      const retryableCodes = [
        "shadow_turn_error",
        "stream_failed",
        "shadow_turn_failed",
        "agentic_session_failed",
        "retrieval_network_error",
        "retrieval_timeout",
        "internal_error",
      ];
      for (const code of retryableCodes) {
        test(`"${code}" is retryable`, () => {
          let state = appendUserMessage(INITIAL_CHAT_STATE, "believe X");
          state = applyStreamEvent(state, { event: "error", data: { message: "m", code } });
          expect(state.items[state.items.length - 1]).toMatchObject({
            type: "error",
            retry: { text: "believe X" },
          });
        });
      }

      const nonRetryableCodes = [
        // Guaranteed-refail codes the review flagged by name.
        "auto_turn_budget_exceeded",
        "claim_missing_required_field",
        "subscription_auth_error",
        // A broad sample of the rest of error-mapping.ts's vocabulary —
        // validation, not-found, quota, and deterministic-fault codes.
        "invalid_slug",
        "volume_not_found",
        "source_budget_exceeded",
        "chapter_parse_error",
        "ledger_corrupt",
        // An unrecognized/future code defaults to NOT retryable — the
        // allowlist's safe default.
        "some_brand_new_code_nobody_has_seen_yet",
      ];
      for (const code of nonRetryableCodes) {
        test(`"${code}" is NOT retryable`, () => {
          let state = appendUserMessage(INITIAL_CHAT_STATE, "believe X");
          state = applyStreamEvent(state, { event: "error", data: { message: "m", code } });
          expect(state.items[state.items.length - 1]).toMatchObject({
            type: "error",
            retry: undefined,
          });
        });
      }
    });
  });

  describe("F5 review fix: retry-flag clearing lives where a user item is minted, not only in appendUserMessage", () => {
    test("a user item arriving through the reducer clears every prior retryable error's retry flag", () => {
      let state = appendUserMessage(INITIAL_CHAT_STATE, "first attempt");
      state = applyStreamEvent(state, {
        event: "error",
        data: { message: "overloaded", code: "shadow_turn_error" },
      });
      const firstErrorId = state.items[state.items.length - 1]?.id;
      expect(state.items.find((i) => i.id === firstErrorId)).toMatchObject({
        retry: { text: "first attempt" },
      });

      // Any future source of a "user" item — today only `appendUserMessage`
      // (local send/retry), tomorrow also T2.8's `operator` wire event —
      // goes through the SAME item-minting path (`withItem`) that now owns
      // this clearing, so this assertion holds regardless of which
      // function produced the new user item.
      state = appendUserMessage(state, "first attempt");

      expect(state.items.find((i) => i.id === firstErrorId)).toMatchObject({ retry: undefined });
      expect(types(state.items)).toEqual(["user", "error", "user"]);
    });

    test("multiple prior retryable errors are all cleared by one new user item", () => {
      let state = appendUserMessage(INITIAL_CHAT_STATE, "attempt one");
      state = applyStreamEvent(state, {
        event: "error",
        data: { message: "m1", code: "shadow_turn_error" },
      });
      state = appendUserMessage(state, "attempt two");
      state = applyStreamEvent(state, {
        event: "error",
        data: { message: "m2", code: "shadow_turn_error" },
      });
      expect(state.items.filter((i) => i.type === "error" && i.retry)).toHaveLength(1);

      state = appendUserMessage(state, "attempt three");

      expect(state.items.filter((i) => i.type === "error" && i.retry)).toHaveLength(0);
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

  describe("T2.8: replay = live for the same script", () => {
    test("a stream that reconstructs an assistant reply as one replayed `text` event ends up with the same transcript a live, chunk-by-chunk stream produces", () => {
      // The live path ("chat.ts") streams several `text-delta` chunks as
      // Shadow produces them; replay ("session-events.ts") has no live
      // delta history to lean on, so it reconstructs the SAME reply as one
      // `text` event carrying the full accumulated string
      // (`@shadow/api`'s `event-mapping.ts`, the `assistant-message` case).
      // Both are just `ChatStreamEvent`s to this reducer — the coalescing
      // in the `"text"` case already handles either shape identically.
      const prefix: ChatStreamEvent[] = [
        { event: "session", data: { sessionId: "sess_1" } },
        { event: "operator", data: { text: "believe X and write it up" } },
      ];
      const suffix: ChatStreamEvent[] = [
        {
          event: "research.started",
          data: { briefId: "b1", brief: { volume: "v", goal: "How does X work?" } },
        },
        { event: "research.finished", data: { briefId: "b1", findings: [] } },
        { event: "chapter.drafted", data: { volume: "v", chapter: "c" } },
        { event: "audit", data: { volume: "v", chapter: "c", passed: true, repairs: [] } },
        { event: "chapter.published", data: { volume: "v", chapter: "c" } },
        { event: "done", data: {} },
      ];

      const liveEvents: ChatStreamEvent[] = [
        ...prefix,
        { event: "text", data: { delta: "Got it — " } },
        { event: "text", data: { delta: "I'll look into it. " } },
        { event: "text", data: { delta: "Drafting now." } },
        ...suffix,
      ];
      const replayEvents: ChatStreamEvent[] = [
        ...prefix,
        { event: "text", data: { delta: "Got it — I'll look into it. Drafting now." } },
        ...suffix,
      ];

      const live = liveEvents.reduce(applyStreamEvent, INITIAL_CHAT_STATE);
      const replay = replayEvents.reduce(applyStreamEvent, INITIAL_CHAT_STATE);

      expect(replay).toEqual(live);
      expect(types(live.items)).toEqual([
        "user",
        "assistant",
        "research.started",
        "research.finished",
        "chapter.drafted",
        "audit",
        "chapter.published",
      ]);
      expect(live.items[1]).toMatchObject({
        type: "assistant",
        text: "Got it — I'll look into it. Drafting now.",
      });
    });
  });

  describe("T2.8: truncated-turn rendering (both shapes) with retry", () => {
    test("an explicit turn.interrupted event (wire signal) renders an interrupted marker, retryable", () => {
      let state = applyStreamEvent(INITIAL_CHAT_STATE, {
        event: "operator",
        data: { text: "please finish this" },
      });
      state = applyStreamEvent(state, { event: "text", data: { delta: "partway through" } });
      state = applyStreamEvent(state, { event: "turn.interrupted", data: {} });

      expect(types(state.items)).toEqual(["user", "assistant", "interrupted"]);
      expect(state.items[2]).toMatchObject({
        type: "interrupted",
        retry: { text: "please finish this" },
      });
      expect(state.turnPending).toBe(false);
      expect(state.streaming).toBe(false);
    });

    test("a stream that ends with no boundary at all — markInterruptedIfPending synthesizes the same marker", () => {
      let state = applyStreamEvent(INITIAL_CHAT_STATE, {
        event: "operator",
        data: { text: "please finish this too" },
      });
      state = applyStreamEvent(state, { event: "text", data: { delta: "still going" } });
      // No `done`/`error`/`turn.interrupted` ever arrives — the stream just
      // stopped (T2.1's torn-tail shape: a crash mid-append never even
      // wrote a boundary record for the wire to carry). Whoever noticed the
      // connection end calls this.
      state = markInterruptedIfPending(state);

      expect(types(state.items)).toEqual(["user", "assistant", "interrupted"]);
      expect(state.items[2]).toMatchObject({
        type: "interrupted",
        retry: { text: "please finish this too" },
      });
      expect(state.turnPending).toBe(false);
    });

    test("both shapes produce an identical transcript for the same turn", () => {
      const base = applyStreamEvent(
        applyStreamEvent(INITIAL_CHAT_STATE, {
          event: "operator",
          data: { text: "same turn" },
        }),
        { event: "text", data: { delta: "same text" } },
      );

      const viaWireEvent = applyStreamEvent(base, { event: "turn.interrupted", data: {} });
      const viaLocalInference = markInterruptedIfPending(base);

      expect(viaWireEvent).toEqual(viaLocalInference);
    });

    test("markInterruptedIfPending is a no-op once a turn has already resolved (done, error, or a prior turn.interrupted)", () => {
      let done = applyStreamEvent(INITIAL_CHAT_STATE, {
        event: "operator",
        data: { text: "x" },
      });
      done = applyStreamEvent(done, { event: "done", data: {} });
      expect(markInterruptedIfPending(done)).toEqual(done);

      let errored = applyStreamEvent(INITIAL_CHAT_STATE, {
        event: "operator",
        data: { text: "y" },
      });
      errored = applyStreamEvent(errored, {
        event: "error",
        data: { message: "boom", code: "shadow_turn_error" },
      });
      expect(markInterruptedIfPending(errored)).toEqual(errored);

      // Calling it a second time after it already fired is also a no-op —
      // `turnPending` is already false.
      let interrupted = applyStreamEvent(INITIAL_CHAT_STATE, {
        event: "operator",
        data: { text: "z" },
      });
      interrupted = applyStreamEvent(interrupted, { event: "turn.interrupted", data: {} });
      expect(markInterruptedIfPending(interrupted)).toEqual(interrupted);
    });

    test("markInterruptedIfPending is a no-op before any turn has started", () => {
      expect(markInterruptedIfPending(INITIAL_CHAT_STATE)).toEqual(INITIAL_CHAT_STATE);
    });

    test("an interrupted marker is not retryable once a chapter already published for this turn (F4-equivalent gating, same rule as error)", () => {
      let state = applyStreamEvent(INITIAL_CHAT_STATE, {
        event: "operator",
        data: { text: "write it up" },
      });
      state = applyStreamEvent(state, {
        event: "chapter.published",
        data: { volume: "v", chapter: "c" },
      });
      state = applyStreamEvent(state, { event: "turn.interrupted", data: {} });

      expect(state.items[state.items.length - 1]).toMatchObject({
        type: "interrupted",
        retry: undefined,
      });
    });

    test("a fresh send supersedes (clears) a prior interrupted item's retry affordance", () => {
      let state = applyStreamEvent(INITIAL_CHAT_STATE, {
        event: "operator",
        data: { text: "first try" },
      });
      state = applyStreamEvent(state, { event: "turn.interrupted", data: {} });
      const interruptedId = state.items[state.items.length - 1]?.id;
      expect(state.items.find((i) => i.id === interruptedId)).toMatchObject({
        retry: { text: "first try" },
      });

      state = appendUserMessage(state, "first try");

      expect(state.items.find((i) => i.id === interruptedId)).toMatchObject({ retry: undefined });
    });
  });

  describe("F3 review fix: turn.ended clears turnPending only", () => {
    test("clears turnPending without touching items or streaming", () => {
      let state = applyStreamEvent(INITIAL_CHAT_STATE, {
        event: "operator",
        data: { text: "please finish this" },
      });
      state = applyStreamEvent(state, { event: "text", data: { delta: "working on it" } });
      expect(state.turnPending).toBe(true);
      const beforeItems = state.items;

      state = applyStreamEvent(state, { event: "turn.ended", data: {} });

      expect(state.turnPending).toBe(false);
      // Not a content event — no item appended, transcript untouched.
      expect(state.items).toBe(beforeItems);
    });

    test("a follow stream dropping AFTER turn.ended does not get mis-marked interrupted (the F3 bug)", () => {
      let state = applyStreamEvent(INITIAL_CHAT_STATE, {
        event: "operator",
        data: { text: "please finish this" },
      });
      state = applyStreamEvent(state, { event: "text", data: { delta: "done talking" } });
      state = applyStreamEvent(state, { event: "turn.ended", data: {} });

      // The connection then drops with no further signal — whoever noticed
      // calls this defensively, same as any other stream end. Before F3,
      // `turnPending` would still have been `true` here (nothing else ever
      // cleared it for a follow viewer, since `?follow=true` never sends
      // `done`), so this would have wrongly rendered an interrupted marker
      // with a live Retry on a turn that had already completed.
      const afterDrop = markInterruptedIfPending(state);

      expect(afterDrop).toEqual(state);
      expect(types(afterDrop.items)).toEqual(["user", "assistant"]);
    });

    test("streaming (a different tab's own send() lifecycle) is untouched by turn.ended", () => {
      let state = applyStreamEvent(INITIAL_CHAT_STATE, {
        event: "operator",
        data: { text: "x" },
      });
      state = { ...state, streaming: true }; // simulates this tab's OWN unrelated send() in flight
      state = applyStreamEvent(state, { event: "turn.ended", data: {} });
      expect(state.streaming).toBe(true);
      expect(state.turnPending).toBe(false);
    });
  });

  describe("F2/F4 review fix: a seq-carrying text REPLACES, a seq-less text APPENDS", () => {
    test("seq-less text deltas keep coalescing into one growing assistant bubble (unchanged live behavior)", () => {
      let state = applyStreamEvent(INITIAL_CHAT_STATE, {
        event: "operator",
        data: { text: "hi" },
      });
      state = applyStreamEvent(state, { event: "text", data: { delta: "Hello" } });
      state = applyStreamEvent(state, { event: "text", data: { delta: " there" } });

      expect(types(state.items)).toEqual(["user", "assistant"]);
      expect(state.items[1]).toMatchObject({ type: "assistant", text: "Hello there" });
    });

    test("a seq-carrying text REPLACES the current assistant bubble with its full text, not appends", () => {
      let state = applyStreamEvent(INITIAL_CHAT_STATE, {
        event: "operator",
        data: { text: "hi" },
      });
      // A follow viewer who joined mid-message: some deltas arrived first
      // (no seq — a partial prefix this viewer happens to have seen)...
      state = applyStreamEvent(state, { event: "text", data: { delta: "partial pre" } });
      // ...then the stored assistant-message record lands, carrying the
      // FULL text — self-correcting, not summing onto the partial prefix.
      state = applyStreamEvent(state, {
        event: "text",
        data: { delta: "The complete message.", seq: 4 },
      });

      expect(types(state.items)).toEqual(["user", "assistant"]);
      expect(state.items[1]).toMatchObject({ type: "assistant", text: "The complete message." });
    });

    test("a seq-carrying text with no prior assistant bubble still mints one (the viewer joined exactly at message end)", () => {
      let state = applyStreamEvent(INITIAL_CHAT_STATE, {
        event: "operator",
        data: { text: "hi" },
      });
      state = applyStreamEvent(state, {
        event: "text",
        data: { delta: "The complete message.", seq: 4 },
      });

      expect(types(state.items)).toEqual(["user", "assistant"]);
      expect(state.items[1]).toMatchObject({ type: "assistant", text: "The complete message." });
    });

    test("a seq-carrying text after ANOTHER seq-carrying text replaces again, not duplicates (fromSeq reconnect mid-message, no duplication)", () => {
      let state = applyStreamEvent(INITIAL_CHAT_STATE, {
        event: "operator",
        data: { text: "hi" },
      });
      // Simulates a reconnect that re-delivers the same record twice (e.g.
      // an overlapping `fromSeq` boundary) — each is independently
      // authoritative, so replaying it again must not double the text.
      state = applyStreamEvent(state, {
        event: "text",
        data: { delta: "The complete message.", seq: 4 },
      });
      state = applyStreamEvent(state, {
        event: "text",
        data: { delta: "The complete message.", seq: 4 },
      });

      expect(state.items[1]).toMatchObject({ type: "assistant", text: "The complete message." });
    });

    test("a live delta AFTER a seq-carrying replace still appends onto the replaced text (a new message starting right after)", () => {
      let state = applyStreamEvent(INITIAL_CHAT_STATE, {
        event: "operator",
        data: { text: "hi" },
      });
      state = applyStreamEvent(state, {
        event: "text",
        data: { delta: "First message done.", seq: 4 },
      });
      state = applyStreamEvent(state, { event: "text", data: { delta: " More." } });

      expect(state.items[1]).toMatchObject({
        type: "assistant",
        text: "First message done. More.",
      });
    });
  });
});
