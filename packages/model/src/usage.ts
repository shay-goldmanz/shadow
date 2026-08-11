/**
 * Token accounting shared by both ports.
 *
 * D6: a fresh agentic session costs ~18k cache-write tokens for the Claude
 * Code system preamble. This package owns session reuse to keep that cost
 * paid once per session rather than once per call — but "owns" only means
 * anything if the cost is *visible*. Every result from either port carries
 * a `TokenUsage` so `@shadow/evaluation` can measure the preamble tax and
 * the payoff from reuse, later.
 *
 * The two underlying SDKs name these fields differently (the Agent SDK:
 * `cacheReadInputTokens` / `cacheCreationInputTokens`; the Vercel AI SDK:
 * `cacheReadTokens` / `cacheWriteTokens`). This is the one canonical shape
 * both adapters translate into, so callers never need to know which
 * transport served a given result.
 */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** A `TokenUsage` with every field zeroed — the fakes' usage, and a safe base for accumulation. */
export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** Sum two `TokenUsage` values field-by-field. Used to accumulate usage across turns and across per-model breakdowns. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}
