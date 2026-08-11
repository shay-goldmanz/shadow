/**
 * Plain Levenshtein edit distance, shared by the anchoring resolver's fuzzy
 * step (`anchoring.ts`) and, eventually, the preservation-bound repair
 * guardrail (D21, T2.5) which logs a restatement's Levenshtein distance.
 * Full O(n·m) DP, no pruning — correctness over speed, since callers bound
 * the search space (window slack, candidate count) rather than relying on
 * this function to be fast at arbitrary scale. Fine at fixture/test scale;
 * not intended for whole-document diffing.
 *
 * **Signature deliberately unchanged** (Wave 1 review, C-2): this is the
 * exact, unbounded distance, still used wherever a caller genuinely wants
 * the real number (e.g. D21's restatement logging). The anchoring
 * resolver's hot inner loop uses `boundedLevenshteinDistance` below
 * instead, precisely because it does *not* need the exact number once a
 * candidate is already hopeless.
 */
export function levenshteinDistance(a: string, b: string): number {
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;

  let prev = Array.from({ length: bLen + 1 }, (_, j) => j);
  let curr = Array.from({ length: bLen + 1 }, () => 0);

  for (let i = 1; i <= aLen; i++) {
    curr[0] = i;
    for (let j = 1; j <= bLen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1, // deletion
        (curr[j - 1] ?? 0) + 1, // insertion
        (prev[j - 1] ?? 0) + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[bLen] ?? 0;
}

/**
 * Levenshtein distance with an early-abandon budget: as soon as *every*
 * entry in the current DP row exceeds `maxDistance`, the true distance is
 * already guaranteed to exceed it too (each further row can only raise the
 * minimum, never lower it below the previous row's minimum minus one), so
 * the scan stops there instead of running to completion.
 *
 * Returns the exact distance when it is `<= maxDistance`; otherwise returns
 * `maxDistance + 1` as a sentinel meaning "exceeds the budget" — never a
 * true distance value, since a true distance is always returned exactly
 * when it's within budget. Callers that only ever compare against the same
 * `maxDistance` (as `anchoring.ts`'s fuzzy search does) can treat the
 * sentinel exactly like any other over-budget distance.
 *
 * This exists alongside `levenshteinDistance` rather than replacing it —
 * see that function's doc comment for why the plain version's signature
 * stays exactly as-is.
 */
export function boundedLevenshteinDistance(a: string, b: string, maxDistance: number): number {
  const aLen = a.length;
  const bLen = b.length;
  const over = maxDistance + 1;

  // A length mismatch alone already costs at least the difference.
  if (Math.abs(aLen - bLen) > maxDistance) return over;
  if (aLen === 0) return Math.min(bLen, over);
  if (bLen === 0) return Math.min(aLen, over);

  let prev = Array.from({ length: bLen + 1 }, (_, j) => j);
  let curr = Array.from({ length: bLen + 1 }, () => 0);

  for (let i = 1; i <= aLen; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= bLen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (prev[j] ?? 0) + 1, // deletion
        (curr[j - 1] ?? 0) + 1, // insertion
        (prev[j - 1] ?? 0) + cost, // substitution
      );
      curr[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > maxDistance) return over;
    [prev, curr] = [curr, prev];
  }

  const result = prev[bLen] ?? 0;
  return result > maxDistance ? over : result;
}
