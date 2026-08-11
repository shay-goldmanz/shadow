import { describe, expect, test } from "bun:test";
import {
  advanceRound,
  canContinue,
  initialRoundState,
  MAX_ROUNDS,
  type NavigateDecision,
  type RoundState,
} from "./round-loop.ts";

function decision(
  chosen: string[],
  rejected: { node_id: string; why: string }[] = [],
): NavigateDecision {
  return { chosen, rejected };
}

describe("initialRoundState", () => {
  test("starts at round 1 with nothing visited and nothing rejected", () => {
    expect(initialRoundState()).toEqual({ round: 1, visited: [], rejections: [] });
  });
});

describe("advanceRound — visited[] and rejections carry forward", () => {
  test("chosen node_ids become visited, so a later round's payload can exclude them", () => {
    const state = advanceRound(initialRoundState(), decision(["N1", "N2"]));
    expect(state.visited).toEqual(["N1", "N2"]);
    expect(state.round).toBe(2);
  });

  test("rejected node_ids also become visited, in addition to being recorded with reasons", () => {
    const state = advanceRound(
      initialRoundState(),
      decision(["N1"], [{ node_id: "N2", why: "not_for lists this use case" }]),
    );
    expect(state.visited).toEqual(["N1", "N2"]);
    expect(state.rejections).toEqual([{ node_id: "N2", why: "not_for lists this use case" }]);
  });

  test("visited[] and rejections accumulate across multiple rounds rather than being replaced", () => {
    let state: RoundState = initialRoundState();
    state = advanceRound(state, decision(["N1"], [{ node_id: "N2", why: "wrong topic" }]));
    state = advanceRound(state, decision(["N3"], [{ node_id: "N4", why: "superseded" }]));
    expect(state.visited).toEqual(["N1", "N2", "N3", "N4"]);
    expect(state.rejections).toEqual([
      { node_id: "N2", why: "wrong topic" },
      { node_id: "N4", why: "superseded" },
    ]);
    expect(state.round).toBe(3);
  });

  test("a round that chooses and rejects nothing still advances the round counter", () => {
    const state = advanceRound(initialRoundState(), decision([]));
    expect(state.round).toBe(2);
    expect(state.visited).toEqual([]);
  });
});

describe("canContinue — hard stop at 3 rounds", () => {
  test("rounds 1 through MAX_ROUNDS may proceed", () => {
    expect(canContinue({ round: 1, visited: [], rejections: [] })).toBe(true);
    expect(canContinue({ round: 2, visited: [], rejections: [] })).toBe(true);
    expect(canContinue({ round: MAX_ROUNDS, visited: [], rejections: [] })).toBe(true);
  });

  test("round MAX_ROUNDS + 1 is refused — the hard stop", () => {
    expect(canContinue({ round: MAX_ROUNDS + 1, visited: [], rejections: [] })).toBe(false);
  });

  test("driving the loop by hand through repeated need-more never executes a 4th round", () => {
    let state = initialRoundState();
    let roundsExecuted = 0;
    while (canContinue(state)) {
      roundsExecuted += 1;
      state = advanceRound(
        state,
        decision([], [{ node_id: `R${roundsExecuted}`, why: "need-more" }]),
      );
    }
    expect(roundsExecuted).toBe(MAX_ROUNDS);
    expect(state.round).toBe(MAX_ROUNDS + 1);
  });
});
