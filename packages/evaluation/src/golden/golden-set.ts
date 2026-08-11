/**
 * Golden set loading and structural validation (T4.1).
 *
 * Validation runs before any strategy executes a single query — a golden
 * set that references a chapter no longer in the fixed corpus (a rename, a
 * typo) fails loudly here rather than silently scoring every query against
 * that chapter as "never retrieved."
 */

import { GoldenSetValidationError } from "../errors.ts";
import { GOLDEN_QUERIES, GOLDEN_SET_VERSION } from "./golden-set-data.ts";
import type { GoldenQuery, GoldenSet } from "./types.ts";

export { GOLDEN_QUERIES, GOLDEN_SET_VERSION } from "./golden-set-data.ts";
export type { GoldenQuery, GoldenQueryTag, GoldenSet } from "./types.ts";

function validateOne(
  goldenQuery: GoldenQuery,
  corpusChapterIds: ReadonlySet<string>,
  seenIds: Set<string>,
  problems: string[],
): void {
  const label = `query "${goldenQuery.id}"`;

  if (goldenQuery.id.trim().length === 0) {
    problems.push("a query has an empty id");
  } else if (seenIds.has(goldenQuery.id)) {
    problems.push(`duplicate query id "${goldenQuery.id}"`);
  } else {
    seenIds.add(goldenQuery.id);
  }

  if (goldenQuery.query.trim().length === 0) {
    problems.push(`${label}: query text must not be empty`);
  }

  if (goldenQuery.tags.length === 0) {
    problems.push(`${label}: must carry at least one tag`);
  }

  for (const chapter of goldenQuery.relevant) {
    if (!corpusChapterIds.has(chapter)) {
      problems.push(`${label}: relevant chapter "${chapter}" does not exist in the fixed corpus`);
    }
  }
  for (const chapter of goldenQuery.judgedIrrelevant ?? []) {
    if (!corpusChapterIds.has(chapter)) {
      problems.push(
        `${label}: judgedIrrelevant chapter "${chapter}" does not exist in the fixed corpus`,
      );
    }
  }

  const relevantSet = new Set(goldenQuery.relevant);
  for (const chapter of goldenQuery.judgedIrrelevant ?? []) {
    if (relevantSet.has(chapter)) {
      problems.push(`${label}: chapter "${chapter}" appears in both relevant and judgedIrrelevant`);
    }
  }

  if (goldenQuery.relevant.length === 0 && goldenQuery.expectNotInCorpus !== true) {
    problems.push(
      `${label}: has no relevant chapters but expectNotInCorpus is not true — either judge a chapter relevant or mark the query as not-in-corpus explicitly`,
    );
  }
  if (goldenQuery.relevant.length > 0 && goldenQuery.expectNotInCorpus === true) {
    problems.push(`${label}: cannot have relevant chapters and expectNotInCorpus: true at once`);
  }
}

/** Structural validation, returning every problem found rather than stopping at the first — a broken golden set is usually broken in more than one place. Empty array means valid. */
export function validateGoldenSet(
  goldenSet: GoldenSet,
  corpusChapterIds: readonly string[],
): readonly string[] {
  const problems: string[] = [];
  const corpusSet = new Set(corpusChapterIds);
  const seenIds = new Set<string>();

  if (goldenSet.queries.length === 0) {
    problems.push("golden set has no queries");
  }

  for (const goldenQuery of goldenSet.queries) {
    validateOne(goldenQuery, corpusSet, seenIds, problems);
  }

  return problems;
}

/**
 * Load the committed golden set and validate it against `corpusChapterIds`
 * (`listChapterIds(document)` over the loaded fixture corpus).
 *
 * @throws {GoldenSetValidationError} if validation finds any problem.
 */
export function loadGoldenSet(corpusChapterIds: readonly string[]): GoldenSet {
  const goldenSet: GoldenSet = { version: GOLDEN_SET_VERSION, queries: GOLDEN_QUERIES };
  const problems = validateGoldenSet(goldenSet, corpusChapterIds);
  if (problems.length > 0) {
    throw new GoldenSetValidationError(problems);
  }
  return goldenSet;
}
