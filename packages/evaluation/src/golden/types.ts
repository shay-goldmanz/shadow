/**
 * The golden query set's shape (T4.1's "golden query set").
 *
 * Every query is a deliberate probe of one specific thing the design in
 * `docs/DECISIONS.md` D11/D11a claims to buy: exact-vocabulary queries are
 * sanity checks even a naive keyword matcher should pass; no-vocabulary-
 * overlap queries are the actual crux — they separate reasoning-based
 * routing (the calling agent reading `when_to_use`) from lexical matching
 * (BM25) by construction, since the query shares no distinctive words with
 * the chapter that answers it. `not-in-corpus` queries make the "if it
 * exists" clause of `docs/ACCEPTANCE.md` a real, checked verdict rather
 * than an assumption. `distractor` queries pair a genuinely correct answer
 * with a lexically tempting wrong one, often keyed to an explicit `not_for`
 * clause in the fixture corpus — the sharpest test of whether authored
 * negative signal earns its keep.
 */

import type { ChapterId } from "../corpus/chapter-id.ts";

export type GoldenQueryTag =
  | "single-chapter"
  | "multi-chapter"
  | "not-in-corpus"
  | "exact-vocabulary"
  | "no-vocabulary-overlap"
  | "distractor";

export interface GoldenQuery {
  /** Stable, human-readable id — referenced in reports and diffs, never renumbered. */
  readonly id: string;
  readonly query: string;
  /**
   * Chapters that genuinely answer this query, as `ChapterId`s
   * (`"<volumeSlug>/<chapterSlug>"`). Empty for a query with no answer in
   * the corpus — `expectNotInCorpus` must be `true` in that case.
   */
  readonly relevant: readonly ChapterId[];
  /**
   * Chapters explicitly checked and confirmed *not* relevant — usually a
   * lexically or thematically tempting near-miss. This is what makes
   * `holesRatio` (D17) meaningful rather than vacuous: a retrieved chapter
   * outside `relevant ∪ judgedIrrelevant` is a genuine hole (never judged
   * either way), not silently assumed wrong.
   */
  readonly judgedIrrelevant?: readonly ChapterId[];
  /** `true` when this query has no correct answer anywhere in the fixed corpus — the "if it exists" clause of `docs/ACCEPTANCE.md`. */
  readonly expectNotInCorpus?: boolean;
  readonly tags: readonly GoldenQueryTag[];
  /** Why this query is shaped the way it is — carried into reports so a reviewer doesn't have to reverse-engineer intent from the query text alone. */
  readonly notes?: string;
}

export interface GoldenSet {
  /** Bump when queries are added, removed, or re-judged — so a results diff can tell "the corpus changed" apart from "the golden set changed" (both invalidate score comparability, D11a/D17). */
  readonly version: string;
  readonly queries: readonly GoldenQuery[];
}
