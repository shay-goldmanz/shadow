/**
 * The `1/√(N+1)·Σ` rollup aggregator (`docs/INDEXING.md`, "Algorithm:
 * retrieval", STAGE 1; D11/D11a). Adopted directly from PageIndex's
 * published formula, with BM25 scores substituted for embeddings.
 *
 * Applied identically at two levels:
 *   - chapter level: `N` = number of sections under the chapter, `scores`
 *     = each section's own score.
 *   - volume level:  `N` = number of chapters under the volume, `scores`
 *     = each chapter's rolled-up score.
 *
 * It rewards nodes with *many* relevant units with diminishing returns —
 * a plain mean would treat one hit and ten hits identically; summing
 * without the `1/√(N+1)` term would let a large chapter win purely by
 * being large. Per D11a this is only exercised when something actually
 * scores (the BM25 fallback path) — the default agent-reads-the-index path
 * never computes it, since there is nothing numeric to roll up.
 *
 * Pure, deterministic, and covers `N = 0` (an empty child list): the sum
 * is `0` and the denominator is `√1 = 1`, so the result is `0` — a node
 * with no scored children rolls up to zero rather than `NaN` or a
 * division error.
 */

/**
 * Roll up a set of child scores into a single node score:
 * `1/√(N+1) · Σ(childScores)`, where `N = childScores.length`.
 */
export function rollupScore(childScores: readonly number[]): number {
  const sum = childScores.reduce((total, score) => total + score, 0);
  return sum / Math.sqrt(childScores.length + 1);
}
