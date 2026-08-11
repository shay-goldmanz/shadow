/**
 * Similarity measure for `shadow lint`'s discriminability (D14) and
 * contradiction-candidate pre-filter checks.
 *
 * **Choice: token-set Jaccard, not character-level edit distance.**
 * `when_to_use` values are short, comma/semicolon-delimited clause lists
 * ("Designing list views, tables, dashboards…"), not free prose — the
 * PageIndex failure mode this check exists to catch (D14: 71% of nodes
 * sharing a page span, several near-duplicate summaries) is clause reuse
 * and reordering, not typo-level surface drift. Token-set Jaccard scores
 * "designing tables, dashboards" vs "dashboards, designing tables" as
 * identical (1.0, correctly — same meaning, different order), which a
 * normalized edit ratio would punish as dissimilar purely for word order.
 * Jaccard is also O(n) with zero dependencies, matching this package's
 * "no LLM, no library" bar for its pure checks (D11a: BM25 is already the
 * one search dependency this package owns; nothing else needs an npm
 * package). A normalized edit ratio remains a reasonable alternative for a
 * corpus dominated by single-clause `when_to_use` values — swap
 * `tokenSetJaccard`'s callers if that profile turns out to fit better.
 *
 * Tokenization: lowercase, split on runs of non-alphanumeric characters,
 * drop empty tokens. Deliberately no stemming and no stopword list — both
 * are corpus-specific tuning this package should not bake in silently, and
 * `docs/INDEXING.md`'s scale (≤50 chapters/volume) makes false positives
 * cheap for a human to dismiss, whereas false negatives (a real collision
 * that tokenization hides) are the failure D14 exists to prevent.
 */

/** Lowercase, split on non-alphanumeric runs, drop empties. Exported for callers that want the raw token set (e.g. to explain a similarity score). */
export function tokenize(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * Jaccard similarity over each string's token *set* (duplicates collapsed):
 * `|A ∩ B| / |A ∪ B|`, in `[0, 1]`. Two empty token sets are defined as
 * `0` (not `1`/`NaN`) — two chapters with no `when_to_use` text at all are
 * not "identical", they are both missing the field entirely, which is a
 * different, more basic problem than a discriminability collision.
 */
export function tokenSetJaccard(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection++;
    }
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
