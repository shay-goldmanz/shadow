/**
 * Retrieval metrics (T4.1): precision, recall, MRR, nDCG, and `holesRatio`
 * (D17). Pure functions over a golden judgment and a strategy's retrieved
 * `ChapterId` list — no I/O, no model, so every number here is
 * hand-computable and exactly what `metrics.test.ts` checks.
 *
 * **Relevance is judged at chapter granularity** (`docs/PLAN.md` T4.1: a
 * golden query is "paired with the chapter(s) that genuinely answer it"),
 * so a strategy's raw citations (which may name sections) are expected to
 * already be resolved to `ChapterId`s and deduplicated before scoring —
 * see `corpus/chapter-id.ts`'s `resolveChapterId`.
 *
 * **`retrieved` is rank order, best-first**, when a strategy can produce
 * one (BM25: descending score; the navigator strategies: the agent's own
 * `chosen` selection order, across rounds) — `reciprocalRank`/`ndcg` are
 * undefined-safe but meaningless without it.
 *
 * **`holesRatio` (D17).** A retrieved chapter is a "hole" when it is
 * neither in `relevant` nor in `judgedIrrelevant` — i.e. the golden set
 * never actually judged it. Without tracking this, a golden set that only
 * judges a handful of chapters per query would silently score every
 * unjudged retrieval as a false positive (via `holes` folded into
 * precision) or simply invisible (via `holes` ignored) — either way,
 * hiding exactly the gap D17 exists to surface. This module keeps holes
 * out of precision/recall entirely (they measure only against judged
 * chapters) and reports them as their own number instead.
 */

import type { ChapterId } from "../corpus/chapter-id.ts";

export interface QueryJudgment {
  readonly relevant: readonly ChapterId[];
  readonly judgedIrrelevant?: readonly ChapterId[];
}

export interface QueryScore {
  /** `undefined` when nothing was retrieved — precision is not meaningfully defined over an empty result. */
  readonly precision?: number;
  /** `undefined` when the query has no relevant chapters (a not-in-corpus query) — see `correctRejection` instead. */
  readonly recall?: number;
  /** `undefined` when the query has no relevant chapters. `0` when nothing relevant was found within `retrieved`. */
  readonly reciprocalRank?: number;
  /** `undefined` when the query has no relevant chapters. Binary-relevance nDCG@|retrieved|. */
  readonly ndcg?: number;
  /** Count of retrieved chapters outside `relevant ∪ judgedIrrelevant` — the golden set holds no judgment for them either way. */
  readonly holes: number;
  /** `holes / retrieved.length`. `0` when nothing was retrieved (vacuously no unjudged items among zero). */
  readonly holesRatio: number;
  /** Defined only for a not-in-corpus query (`relevant` empty): `true` iff the strategy also retrieved nothing. */
  readonly correctRejection?: boolean;
  readonly retrievedCount: number;
  readonly relevantCount: number;
}

function dcg(gains: readonly number[]): number {
  return gains.reduce((sum, gain, index) => sum + gain / Math.log2(index + 2), 0);
}

/** Score one query's outcome against its golden judgment. */
export function scoreQuery(judgment: QueryJudgment, retrieved: readonly ChapterId[]): QueryScore {
  const relevantSet = new Set(judgment.relevant);
  const judgedIrrelevantSet = new Set(judgment.judgedIrrelevant ?? []);
  const judgedSet = new Set([...relevantSet, ...judgedIrrelevantSet]);

  const hitCount = retrieved.filter((c) => relevantSet.has(c)).length;
  const holes = retrieved.filter((c) => !judgedSet.has(c)).length;
  const holesRatio = retrieved.length === 0 ? 0 : holes / retrieved.length;

  const precision = retrieved.length === 0 ? undefined : hitCount / retrieved.length;

  const hasRelevant = relevantSet.size > 0;
  const recall = hasRelevant ? hitCount / relevantSet.size : undefined;

  let reciprocalRank: number | undefined;
  let ndcg: number | undefined;
  if (hasRelevant) {
    const firstHitIndex = retrieved.findIndex((c) => relevantSet.has(c));
    reciprocalRank = firstHitIndex === -1 ? 0 : 1 / (firstHitIndex + 1);

    const gains = retrieved.map((c) => (relevantSet.has(c) ? 1 : 0));
    const idealGains = Array.from({ length: retrieved.length }, (_, i) =>
      i < relevantSet.size ? 1 : 0,
    );
    const idcg = dcg(idealGains);
    ndcg = idcg === 0 ? 0 : dcg(gains) / idcg;
  }

  const correctRejection = hasRelevant ? undefined : retrieved.length === 0;

  return {
    precision,
    recall,
    reciprocalRank,
    ndcg,
    holes,
    holesRatio,
    correctRejection,
    retrievedCount: retrieved.length,
    relevantCount: relevantSet.size,
  };
}

export interface AggregateMetrics {
  readonly queryCount: number;
  /** Mean over queries where `precision` is defined (`retrieved.length > 0`). `undefined` if none. */
  readonly meanPrecision?: number;
  /** Mean over queries where `recall` is defined (answerable queries). `undefined` if none. */
  readonly meanRecall?: number;
  /** Mean reciprocal rank over answerable queries. `undefined` if none. */
  readonly mrr?: number;
  /** Mean nDCG over answerable queries. `undefined` if none. */
  readonly meanNdcg?: number;
  /**
   * `holesRatio` pooled across the whole run (D17): total holes divided by
   * total retrieved items, over every query — the primary number to
   * report, since it answers "of everything this strategy handed back
   * across the run, what fraction did the golden set never judge."
   */
  readonly holesRatio: number;
  /** Mean of each query's own `holesRatio`, over queries that retrieved anything. `undefined` if none. Reported alongside the pooled figure since a handful of high-holes queries can move the pooled number without moving the typical query. */
  readonly meanHolesRatio?: number;
  /** Fraction of not-in-corpus queries (`relevant` empty) correctly answered with an empty retrieval. `undefined` if the run had no not-in-corpus queries. */
  readonly correctRejectionRate?: number;
}

function mean(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Aggregate a run's per-query `QueryScore`s into run-level metrics. */
export function aggregateScores(perQuery: readonly QueryScore[]): AggregateMetrics {
  const precisions = perQuery.map((s) => s.precision).filter((v): v is number => v !== undefined);
  const recalls = perQuery.map((s) => s.recall).filter((v): v is number => v !== undefined);
  const rrs = perQuery.map((s) => s.reciprocalRank).filter((v): v is number => v !== undefined);
  const ndcgs = perQuery.map((s) => s.ndcg).filter((v): v is number => v !== undefined);
  const perQueryHoleRatios = perQuery.filter((s) => s.retrievedCount > 0).map((s) => s.holesRatio);
  const rejections = perQuery
    .map((s) => s.correctRejection)
    .filter((v): v is boolean => v !== undefined);

  const totalHoles = perQuery.reduce((sum, s) => sum + s.holes, 0);
  const totalRetrieved = perQuery.reduce((sum, s) => sum + s.retrievedCount, 0);

  return {
    queryCount: perQuery.length,
    meanPrecision: mean(precisions),
    meanRecall: mean(recalls),
    mrr: mean(rrs),
    meanNdcg: mean(ndcgs),
    holesRatio: totalRetrieved === 0 ? 0 : totalHoles / totalRetrieved,
    meanHolesRatio: mean(perQueryHoleRatios),
    correctRejectionRate:
      rejections.length === 0 ? undefined : rejections.filter(Boolean).length / rejections.length,
  };
}
