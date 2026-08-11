import { describe, expect, test } from "bun:test";
import type { GoldenSet } from "../golden/types.ts";
import type { RetrievalStrategy, StrategyQueryResult } from "../strategies/strategy.ts";
import { ZERO_TOKEN_COST } from "../strategies/token-tracking.ts";
import { runComparison, runStrategy } from "./harness.ts";

const GOLDEN_SET: GoldenSet = {
  version: "test-1",
  queries: [
    { id: "q-hit", query: "find a", relevant: ["vol/a"], tags: ["single-chapter"] },
    {
      id: "q-miss",
      query: "find nothing",
      relevant: [],
      expectNotInCorpus: true,
      tags: ["not-in-corpus"],
    },
  ],
};

/** A strategy fully controlled by the test — deterministic mapping from query text to result, no model, no navigator. */
class StubStrategy implements RetrievalStrategy {
  readonly name = "stub";
  readonly description = "test stub";
  constructor(private readonly byQuery: ReadonlyMap<string, StrategyQueryResult>) {}

  async retrieve(query: string): Promise<StrategyQueryResult> {
    const result = this.byQuery.get(query);
    if (!result) throw new Error(`no scripted result for query "${query}"`);
    return result;
  }
}

describe("runStrategy", () => {
  test("produces one QueryReportEntry per golden query, in order, with a computed score", async () => {
    const strategy = new StubStrategy(
      new Map([
        ["find a", { retrieved: ["vol/a"], verdict: "found", tokenCost: ZERO_TOKEN_COST }],
        ["find nothing", { retrieved: [], verdict: "not-in-corpus", tokenCost: ZERO_TOKEN_COST }],
      ]),
    );

    const report = await runStrategy(strategy, GOLDEN_SET);

    expect(report.strategyName).toBe("stub");
    expect(report.perQuery).toHaveLength(2);
    expect(report.perQuery[0]?.queryId).toBe("q-hit");
    expect(report.perQuery[0]?.score.precision).toBe(1);
    expect(report.perQuery[0]?.expectedVerdict).toBe("found");
    expect(report.perQuery[1]?.queryId).toBe("q-miss");
    expect(report.perQuery[1]?.score.correctRejection).toBe(true);
    expect(report.perQuery[1]?.expectedVerdict).toBe("not-in-corpus");
  });

  test("aggregate metrics reflect the per-query scores (a perfect strategy scores 1s where defined)", async () => {
    const strategy = new StubStrategy(
      new Map([
        ["find a", { retrieved: ["vol/a"], verdict: "found", tokenCost: ZERO_TOKEN_COST }],
        ["find nothing", { retrieved: [], verdict: "not-in-corpus", tokenCost: ZERO_TOKEN_COST }],
      ]),
    );
    const report = await runStrategy(strategy, GOLDEN_SET);
    expect(report.metrics.meanPrecision).toBe(1);
    expect(report.metrics.meanRecall).toBe(1);
    expect(report.metrics.mrr).toBe(1);
    expect(report.metrics.correctRejectionRate).toBe(1);
    expect(report.metrics.holesRatio).toBe(0);
  });

  test("sums tokenCost across every query", async () => {
    const strategy = new StubStrategy(
      new Map([
        [
          "find a",
          {
            retrieved: ["vol/a"],
            verdict: "found",
            tokenCost: {
              estimatedPromptTokens: 100,
              usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
              llmCalls: 2,
            },
          },
        ],
        [
          "find nothing",
          {
            retrieved: [],
            verdict: "not-in-corpus",
            tokenCost: {
              estimatedPromptTokens: 50,
              usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
              llmCalls: 1,
            },
          },
        ],
      ]),
    );
    const report = await runStrategy(strategy, GOLDEN_SET);
    expect(report.tokenCost).toEqual({
      estimatedPromptTokens: 150,
      usage: { inputTokens: 15, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
      llmCalls: 3,
    });
  });
});

class AlwaysMissStrategy implements RetrievalStrategy {
  readonly name = "always-miss";
  readonly description = "never finds anything";
  async retrieve(): Promise<StrategyQueryResult> {
    return { retrieved: [], verdict: "not-in-corpus", tokenCost: ZERO_TOKEN_COST };
  }
}

describe("runComparison", () => {
  test("runs every strategy over the same golden set, one StrategyReport each, in input order", async () => {
    const alwaysHit = new StubStrategy(
      new Map([
        ["find a", { retrieved: ["vol/a"], verdict: "found", tokenCost: ZERO_TOKEN_COST }],
        ["find nothing", { retrieved: [], verdict: "not-in-corpus", tokenCost: ZERO_TOKEN_COST }],
      ]),
    );
    const alwaysMiss = new AlwaysMissStrategy();

    const reports = await runComparison([alwaysHit, alwaysMiss], GOLDEN_SET);
    expect(reports).toHaveLength(2);
    expect(reports[0]?.strategyName).toBe("stub");
    expect(reports[1]?.strategyName).toBe("always-miss");
    // alwaysMiss correctly rejects the not-in-corpus query but misses the answerable one.
    expect(reports[1]?.metrics.correctRejectionRate).toBe(1);
    expect(reports[1]?.metrics.meanRecall).toBe(0);
  });

  test("the report shape is stable across runs given the same inputs (deterministic)", async () => {
    const strategy = new StubStrategy(
      new Map([
        ["find a", { retrieved: ["vol/a"], verdict: "found", tokenCost: ZERO_TOKEN_COST }],
        ["find nothing", { retrieved: [], verdict: "not-in-corpus", tokenCost: ZERO_TOKEN_COST }],
      ]),
    );
    const first = await runStrategy(strategy, GOLDEN_SET);
    const second = await runStrategy(strategy, GOLDEN_SET);
    expect(first).toEqual(second);
  });
});
