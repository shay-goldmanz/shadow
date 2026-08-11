/**
 * The evaluation harness (T4.1): runs one `RetrievalStrategy` over the
 * golden set and produces a stable, structured report. Depends only on the
 * `RetrievalStrategy` port (`strategies/strategy.ts`) — adding a fourth
 * strategy never touches this file, which is the whole point of making
 * strategy an interface (this package's own design-constraint brief).
 */

import type { ChapterId } from "../corpus/chapter-id.ts";
import type { GoldenQuery, GoldenQueryTag, GoldenSet } from "../golden/types.ts";
import {
  type AggregateMetrics,
  aggregateScores,
  type QueryScore,
  scoreQuery,
} from "../metrics/metrics.ts";
import type { RetrievalStrategy, StrategyVerdict } from "../strategies/strategy.ts";
import { addTokenCost, type TokenCost, ZERO_TOKEN_COST } from "../strategies/token-tracking.ts";

export interface QueryReportEntry {
  readonly queryId: string;
  readonly query: string;
  readonly tags: readonly GoldenQueryTag[];
  readonly relevant: readonly ChapterId[];
  readonly retrieved: readonly ChapterId[];
  readonly verdict: StrategyVerdict;
  readonly expectedVerdict: StrategyVerdict;
  readonly rounds?: number;
  readonly tokenCost: TokenCost;
  readonly score: QueryScore;
}

export interface StrategyReport {
  readonly strategyName: string;
  readonly description: string;
  readonly perQuery: readonly QueryReportEntry[];
  readonly metrics: AggregateMetrics;
  /** Summed `TokenCost` across every query this strategy ran. */
  readonly tokenCost: TokenCost;
}

function expectedVerdictOf(goldenQuery: GoldenQuery): StrategyVerdict {
  return goldenQuery.expectNotInCorpus ? "not-in-corpus" : "found";
}

/** Run `strategy` over every query in `goldenSet`, in order, sequentially (never parallel — some strategies share mutable per-query state, e.g. a fresh BM25-fallback cache per `ReasoningNavigator.find()` call). */
export async function runStrategy(
  strategy: RetrievalStrategy,
  goldenSet: GoldenSet,
): Promise<StrategyReport> {
  const perQuery: QueryReportEntry[] = [];

  for (const goldenQuery of goldenSet.queries) {
    const result = await strategy.retrieve(goldenQuery.query);
    const score = scoreQuery(
      { relevant: goldenQuery.relevant, judgedIrrelevant: goldenQuery.judgedIrrelevant },
      result.retrieved,
    );
    perQuery.push({
      queryId: goldenQuery.id,
      query: goldenQuery.query,
      tags: goldenQuery.tags,
      relevant: goldenQuery.relevant,
      retrieved: result.retrieved,
      verdict: result.verdict,
      expectedVerdict: expectedVerdictOf(goldenQuery),
      rounds: result.rounds,
      tokenCost: result.tokenCost,
      score,
    });
  }

  const metrics = aggregateScores(perQuery.map((entry) => entry.score));
  const tokenCost = perQuery.reduce(
    (sum, entry) => addTokenCost(sum, entry.tokenCost),
    ZERO_TOKEN_COST,
  );

  return {
    strategyName: strategy.name,
    description: strategy.description,
    perQuery,
    metrics,
    tokenCost,
  };
}

/** Run every strategy in `strategies` (in order) over the same `goldenSet` — the actual T4.2 comparison. */
export async function runComparison(
  strategies: readonly RetrievalStrategy[],
  goldenSet: GoldenSet,
): Promise<readonly StrategyReport[]> {
  const reports: StrategyReport[] = [];
  for (const strategy of strategies) {
    reports.push(await runStrategy(strategy, goldenSet));
  }
  return reports;
}
