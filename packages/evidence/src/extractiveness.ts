/**
 * Extractiveness (D21): mean longest-common-substring between a claim and
 * its cited span(s), reported alongside every groundedness number — **a
 * watched metric, never a target**.
 *
 * Citation precision and perceived utility correlate at **r ≈ -0.96**
 * across production generative search engines: the system with the highest
 * citation precision had the lowest utility, because heavily-grounded
 * statements trend toward near-verbatim copying of their source. If
 * Shadow's volumes get more grounded and less useful, extractiveness rising
 * alongside groundedness is that signal — the metric is working and the
 * product is failing. This is why it is computed here, unconditionally,
 * rather than only on demand: burying it defeats the point.
 */

/** Length of the longest contiguous substring common to `a` and `b`. Classic O(|a|·|b|) DP — fine at claim/span scale. */
export function longestCommonSubstringLength(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;

  let prev = Array.from<number>({ length: b.length + 1 }).fill(0);
  let best = 0;

  for (let i = 1; i <= a.length; i++) {
    const curr = Array.from<number>({ length: b.length + 1 }).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        const value = (prev[j - 1] ?? 0) + 1;
        curr[j] = value;
        if (value > best) best = value;
      }
    }
    prev = curr;
  }

  return best;
}

/** One claim-span pair's extractiveness: LCS length as a fraction of the claim's own length, in `[0, 1]`. */
export function extractivenessOf(claimText: string, citedText: string): number {
  if (claimText.length === 0) return 0;
  return longestCommonSubstringLength(claimText, citedText) / claimText.length;
}

/** Mean extractiveness across a claim's evidence spans. `undefined` if there is nothing to compare against (e.g. a `derived` claim, which cites other claims rather than source text). */
export function meanExtractiveness(
  claimText: string,
  citedTexts: readonly string[],
): number | undefined {
  if (citedTexts.length === 0) return undefined;
  const scores = citedTexts.map((text) => extractivenessOf(claimText, text));
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}
