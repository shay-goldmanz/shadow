/**
 * Plain Levenshtein edit distance, shared by the anchoring resolver's fuzzy
 * step (`anchoring.ts`) and, eventually, the preservation-bound repair
 * guardrail (D21, T2.5) which logs a restatement's Levenshtein distance.
 * Full O(n·m) DP, no pruning — correctness over speed, since callers bound
 * the search space (window slack, candidate count) rather than relying on
 * this function to be fast at arbitrary scale. Fine at fixture/test scale;
 * not intended for whole-document diffing.
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
