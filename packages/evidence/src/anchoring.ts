/**
 * The anchoring resolver (`docs/EVIDENCE.md`, "Normalization and
 * anchoring"): given a `TextQuoteSelector` and the snapshot text it was cut
 * from, find where — if anywhere — it still resolves.
 *
 * ```
 * resolve(selector, snapshotText) -> { start, end, status }
 *
 * 1. if selector.refinedBy present:
 *      if snapshotText.slice(start, end) === selector.exact:
 *          return anchored                      // O(1) fast path
 * 2. exact indexOf scan for selector.exact
 *      one match  -> anchored
 *      many       -> score candidates by prefix/suffix similarity, best -> anchored
 * 3. approximate search; best candidate above threshold -> anchored-fuzzy
 * 4. orphaned
 * ```
 *
 * **Step 1's re-validation is the whole trick.** A cached `refinedBy`
 * offset whose slice no longer equals `exact` is *rejected*, not trusted —
 * `refinedBy` is a cache, the quote is the identity. This function falls
 * straight through to step 2 in that case, exactly as if no `refinedBy`
 * were cached at all.
 *
 * Character offsets throughout, not byte offsets (`docs/EVIDENCE.md`,
 * D16) — `snapshotText` is a JS string, so every index here is a UTF-16
 * code unit offset, matching Anthropic/OpenAI's character-indexed
 * selectors rather than Google/Vertex's byte-indexed ones.
 *
 * Context length, edit-distance budget, and accept threshold are tunable
 * configuration with documented defaults (D16's caveat: these "could not be
 * verified against primary sources... ship as tunable configuration"), not
 * constants. See `DEFAULT_ANCHORING_CONFIG` for the defaults and the
 * rationale for each.
 */

import { levenshteinDistance } from "./edit-distance.ts";
import type { AnchorStatus, TextQuoteSelector } from "./types.ts";

export interface DisambiguationWeights {
  readonly prefix: number;
  readonly suffix: number;
}

export interface AnchoringConfig {
  /** How many characters of `prefix`/`suffix` context to compare when disambiguating multiple exact matches (step 2) or scoring candidates (step 3). */
  readonly contextChars: number;
  /** Edit-distance budget for the fuzzy step (step 3), as a function of the quote's length. */
  readonly maxEditDistance: (exactLength: number) => number;
  /** Minimum normalized similarity (`1 - distance/maxLen`) for a fuzzy match to be accepted as `anchored-fuzzy` rather than `orphaned`. */
  readonly fuzzyAcceptThreshold: number;
  /** Relative weight of prefix vs. suffix context when disambiguating/scoring. */
  readonly disambiguationWeights: DisambiguationWeights;
  /** How far candidate window lengths are allowed to vary from `exact.length` during the fuzzy search (bounds the search space/cost). */
  readonly fuzzySearchSlack: number;
}

/**
 * Defaults, calibrated as starting points per D16/`docs/EVIDENCE.md`
 * (explicitly *not* established constants — recalibrate against a fixture
 * corpus as one becomes available):
 *
 * - `contextChars: 32` — the spec's own suggested starting point.
 * - `maxEditDistance: min(256, exact.length / 2)` — the spec's own formula,
 *   verbatim.
 * - `fuzzyAcceptThreshold: 0.6` — a fuzzy match is accepted only if the
 *   candidate is *more similar than different*; this is our own choice,
 *   not given by the spec, chosen conservatively so `anchored-fuzzy` means
 *   "probably the same sentence, lightly edited" rather than "vaguely
 *   related passage".
 * - `disambiguationWeights: { prefix: 0.5, suffix: 0.5 }` — no basis in the
 *   spec to weight one side of context over the other.
 * - `fuzzySearchSlack: 32` — bounds how many candidate window lengths step
 *   3 tries; a small multiple of `contextChars` rather than the full edit
 *   budget, since real edits (typo fixes, a word swapped) rarely change a
 *   sentence's length by more than a couple dozen characters even when the
 *   raw edit-distance budget is much larger.
 */
export const DEFAULT_ANCHORING_CONFIG: AnchoringConfig = {
  contextChars: 32,
  maxEditDistance: (exactLength: number) => Math.min(256, Math.floor(exactLength / 2)),
  fuzzyAcceptThreshold: 0.6,
  disambiguationWeights: { prefix: 0.5, suffix: 0.5 },
  fuzzySearchSlack: 32,
};

export interface AnchorResolution {
  readonly status: AnchorStatus;
  readonly start?: number;
  readonly end?: number;
  /** Present only when `status === "anchored-fuzzy"`. */
  readonly distance?: number;
}

export interface ResolveOptions {
  /**
   * Whether step 3 (approximate search) may run at all. Default `true`.
   * Operator-claim verification (`checks/operator-verification.ts`) sets
   * this `false`: per D19, an operator claim must match the transcript
   * *exactly* or fail outright — a near-but-not-exact quote is exactly the
   * loophole that check exists to close, so it must never be laundered
   * into a passing `anchored-fuzzy`.
   */
  readonly allowFuzzy?: boolean;
  readonly config?: AnchoringConfig;
}

function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

function contextBefore(text: string, index: number, length: number): string {
  return text.slice(Math.max(0, index - length), index);
}

function contextAfter(text: string, index: number, length: number): string {
  return text.slice(index, Math.min(text.length, index + length));
}

/** Score one exact-match candidate by how well its surrounding text matches `selector`'s prefix/suffix. Higher is better. */
function scoreCandidate(
  text: string,
  start: number,
  end: number,
  selector: TextQuoteSelector,
  config: AnchoringConfig,
): number {
  const { contextChars, disambiguationWeights } = config;
  let totalWeight = 0;
  let weightedScore = 0;

  if (selector.prefix !== undefined) {
    const expected = selector.prefix.slice(-contextChars);
    const actual = contextBefore(text, start, expected.length);
    weightedScore += similarity(expected, actual) * disambiguationWeights.prefix;
    totalWeight += disambiguationWeights.prefix;
  }
  if (selector.suffix !== undefined) {
    const expected = selector.suffix.slice(0, contextChars);
    const actual = contextAfter(text, end, expected.length);
    weightedScore += similarity(expected, actual) * disambiguationWeights.suffix;
    totalWeight += disambiguationWeights.suffix;
  }

  // No context to disambiguate with at all — every candidate scores the
  // same; the first exact match wins by iteration order below.
  return totalWeight === 0 ? 0 : weightedScore / totalWeight;
}

/** All start indices where `needle` occurs in `text` (overlapping matches included), in ascending order. */
function findAllExactMatches(text: string, needle: string): number[] {
  if (needle.length === 0) return [];
  const indices: number[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) break;
    indices.push(at);
    from = at + 1;
  }
  return indices;
}

interface FuzzyCandidate {
  readonly start: number;
  readonly end: number;
  readonly distance: number;
}

/**
 * Bounded approximate search: tries candidate windows whose length is
 * within `slack` of `exact.length` (further capped by `budget`, since a
 * window further off in length than the edit budget could never score
 * within it anyway), scanning every start position. O(slack · N · M) — fine
 * at fixture/chapter scale, not intended for whole-corpus scanning.
 */
function findFuzzyMatch(
  text: string,
  exact: string,
  budget: number,
  slack: number,
): FuzzyCandidate | undefined {
  const span = Math.min(slack, budget);
  const minLen = Math.max(1, exact.length - span);
  const maxLen = exact.length + span;
  let best: FuzzyCandidate | undefined;

  for (let len = minLen; len <= maxLen; len++) {
    for (let start = 0; start + len <= text.length; start++) {
      const distance = levenshteinDistance(exact, text.slice(start, start + len));
      if (distance <= budget && (!best || distance < best.distance)) {
        best = { start, end: start + len, distance };
        if (distance === 0) return best;
      }
    }
  }
  return best;
}

/** Resolve a `TextQuoteSelector` against a snapshot's normalized text. See module doc for the algorithm. */
export function resolveSelector(
  selector: TextQuoteSelector,
  snapshotText: string,
  options: ResolveOptions = {},
): AnchorResolution {
  const config = options.config ?? DEFAULT_ANCHORING_CONFIG;
  const allowFuzzy = options.allowFuzzy ?? true;

  // Step 1: refinedBy fast path, re-validated against the current text.
  if (selector.refinedBy) {
    const { start, end } = selector.refinedBy;
    if (
      start >= 0 &&
      end >= start &&
      end <= snapshotText.length &&
      snapshotText.slice(start, end) === selector.exact
    ) {
      return { status: "anchored", start, end };
    }
    // Stale cache — rejected, not trusted. Fall through to step 2 exactly
    // as if refinedBy were absent.
  }

  // Step 2: exact scan.
  const matches = findAllExactMatches(snapshotText, selector.exact);
  if (matches.length === 1) {
    const start = matches[0] as number;
    return { status: "anchored", start, end: start + selector.exact.length };
  }
  if (matches.length > 1) {
    let bestStart = matches[0] as number;
    let bestScore = -Infinity;
    for (const start of matches) {
      const score = scoreCandidate(
        snapshotText,
        start,
        start + selector.exact.length,
        selector,
        config,
      );
      if (score > bestScore) {
        bestScore = score;
        bestStart = start;
      }
    }
    return { status: "anchored", start: bestStart, end: bestStart + selector.exact.length };
  }

  // Step 3: approximate search.
  if (allowFuzzy && selector.exact.length > 0) {
    const budget = config.maxEditDistance(selector.exact.length);
    const found = findFuzzyMatch(snapshotText, selector.exact, budget, config.fuzzySearchSlack);
    if (found) {
      const maxLen = Math.max(selector.exact.length, found.end - found.start);
      const similarityScore = maxLen === 0 ? 1 : 1 - found.distance / maxLen;
      if (similarityScore >= config.fuzzyAcceptThreshold) {
        return {
          status: "anchored-fuzzy",
          start: found.start,
          end: found.end,
          distance: found.distance,
        };
      }
    }
  }

  // Step 4: orphaned. Cited text was deleted (or edited beyond recognition)
  // — a state to surface, not an error to throw.
  return { status: "orphaned" };
}
