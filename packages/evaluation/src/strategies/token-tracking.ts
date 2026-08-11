/**
 * Token cost tracking (T4.2: "Report token cost alongside quality for each
 * strategy, since D11's claim is explicitly economic, not accuracy-based").
 *
 * Two numbers, deliberately kept apart rather than collapsed into one:
 *
 * - `estimatedPromptTokens` — `@shadow/indexing`'s own `estimateTokens`
 *   heuristic applied to the exact system+prompt text sent to
 *   `StructuredGenerationPort.generate`. Always available, even against a
 *   fake port with zero real usage, so the *default offline test suite*
 *   still produces a meaningful, comparable cost figure per D6's point that
 *   session/call cost has to stay visible.
 * - `usage` — the real `TokenUsage` a live adapter returns. Zero against
 *   every fake (`FakeStructuredGenerationPort` returns `ZERO_USAGE` by
 *   construction), real against a live `@shadow/model` port. This is the
 *   number that actually matters for the live-mode measurement; it is
 *   reported separately, never averaged with the estimate, so a reader can
 *   tell scripted runs (`usage` all zero) apart from live ones at a glance.
 *
 * Naive BM25 makes zero LLM calls by construction — its `TokenCost` is
 * always `ZERO_TOKEN_COST`, not an oversight but the actual point (D11's
 * "or better" claim is economic: the tree navigator spends inference
 * tokens the flat baseline never does, and quality has to earn that back).
 */

import { estimateTokens } from "@shadow/indexing";
import {
  addUsage,
  type StructuredGenerationPort,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
  type TokenUsage,
  ZERO_USAGE,
} from "@shadow/model";

export interface TokenCost {
  readonly estimatedPromptTokens: number;
  readonly usage: TokenUsage;
  readonly llmCalls: number;
}

export const ZERO_TOKEN_COST: TokenCost = {
  estimatedPromptTokens: 0,
  usage: ZERO_USAGE,
  llmCalls: 0,
};

export function addTokenCost(a: TokenCost, b: TokenCost): TokenCost {
  return {
    estimatedPromptTokens: a.estimatedPromptTokens + b.estimatedPromptTokens,
    usage: addUsage(a.usage, b.usage),
    llmCalls: a.llmCalls + b.llmCalls,
  };
}

/** Anything a strategy can read accumulated token cost from and reset between queries. `MeasuringStructuredGenerationPort` satisfies this structurally. */
export interface TokenCostTracker {
  readonly cost: TokenCost;
  reset(): void;
}

/**
 * Decorates any `StructuredGenerationPort`, accumulating `TokenCost` across
 * every `generate()` call it serves. A strategy calls `reset()` before each
 * query and reads `.cost` after, so cost is attributed per-query rather
 * than bleeding across an entire run.
 */
export class MeasuringStructuredGenerationPort
  implements StructuredGenerationPort, TokenCostTracker
{
  private accumulated: TokenCost = ZERO_TOKEN_COST;

  constructor(private readonly inner: StructuredGenerationPort) {}

  get cost(): TokenCost {
    return this.accumulated;
  }

  reset(): void {
    this.accumulated = ZERO_TOKEN_COST;
  }

  async generate<Output>(
    request: StructuredGenerationRequest<Output>,
  ): Promise<StructuredGenerationResult<Output>> {
    const promptTokens = estimateTokens(`${request.system ?? ""}\n${request.prompt}`);
    const result = await this.inner.generate(request);
    this.accumulated = addTokenCost(this.accumulated, {
      estimatedPromptTokens: promptTokens,
      usage: result.usage,
      llmCalls: 1,
    });
    return result;
  }
}
