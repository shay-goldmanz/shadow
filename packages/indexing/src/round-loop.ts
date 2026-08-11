/**
 * The round loop that carries `visited[]` and rejections across STAGE 3
 * (NAVIGATE) / STAGE 5 (GRADE) iterations (`docs/INDEXING.md`):
 *
 * > Carry `visited[]` forward across rounds so the agent does not reselect
 * > a chapter. Record rejections with reasons — that is the operator's
 * > signal to fix a `not_for`. Bound at 3 rounds. Most queries resolve in
 * > one.
 *
 * Pure state machine: no I/O, no agent calls. `navigator.ts`'s
 * orchestration drives it by feeding in each round's `NavigateDecision`
 * (the agent's own STAGE 3 output) and asking `canContinue` before
 * starting another round.
 */

/** A rejected candidate, with the reason the agent rejected it — "the operator's signal to fix a `not_for`". */
export interface Rejection {
  readonly node_id: string;
  readonly why: string;
}

/** The agent's STAGE 3 (NAVIGATE) output: which chapters it picked, which it explicitly rejected (and why), and optionally its reasoning. */
export interface NavigateDecision {
  readonly chosen: readonly string[];
  readonly rejected: readonly Rejection[];
  readonly reasoning?: string;
}

/** Hard cap on rounds (`docs/INDEXING.md`: "Bound at 3 rounds"). */
export const MAX_ROUNDS = 3;

export interface RoundState {
  /** 1-based: the round about to be (or currently being) attempted. */
  readonly round: number;
  /** Every `node_id` shown to the agent and decided on (chosen or rejected) in a previous round — excluded from later rounds' payloads so the agent cannot reselect. */
  readonly visited: readonly string[];
  /** Every rejection recorded so far, across all rounds, in the order they occurred. */
  readonly rejections: readonly Rejection[];
}

/** The starting state before round 1: nothing visited, nothing rejected. */
export function initialRoundState(): RoundState {
  return { round: 1, visited: [], rejections: [] };
}

/**
 * Fold one round's `NavigateDecision` into the running state: both chosen
 * and rejected node_ids become `visited` (the agent should not re-see
 * either — a chosen chapter is already being read; a rejected one was
 * explicitly declined), rejections accumulate, and the round counter
 * advances by one.
 */
export function advanceRound(state: RoundState, decision: NavigateDecision): RoundState {
  const rejectedIds = decision.rejected.map((rejection) => rejection.node_id);
  return {
    round: state.round + 1,
    visited: [...state.visited, ...decision.chosen, ...rejectedIds],
    rejections: [...state.rejections, ...decision.rejected],
  };
}

/** `true` while `state.round` is still within the `MAX_ROUNDS` bound — call before starting another round. */
export function canContinue(state: RoundState): boolean {
  return state.round <= MAX_ROUNDS;
}
