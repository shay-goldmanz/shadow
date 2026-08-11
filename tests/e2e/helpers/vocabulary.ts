/**
 * The D11a check: does a query's wording overlap the target chapter's
 * *routing* vocabulary — the `title`/`when_to_use`/`not_for`/`keywords`
 * fields an agent actually reads at STAGE 3 (NAVIGATE), per
 * `docs/INDEXING.md`? Not the chapter body — the body isn't shown to the
 * agent at this stage (`docs/INDEXING.md`: "never put body text in a
 * structure payload"), and BM25 fallback (which does read the body) is
 * explicitly off the default path at our scale (D11a).
 *
 * Uses `@shadow/indexing`'s own `tokenize` (lowercase, split on
 * non-alphanumeric runs) rather than a second hand-rolled tokenizer, so
 * "overlap" here means exactly what it would mean to the BM25 fallback
 * and discriminability checks elsewhere in the system.
 */

import { tokenize } from "../../../packages/indexing/src/index.ts";

/**
 * Minimal English function-word list, excluded before computing overlap.
 * Content words are the test; two sentences about anything at all will
 * usually share "a"/"the". This list is short and fixed on purpose — it is
 * not tuned to make any particular query pass.
 */
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "to",
  "of",
  "in",
  "on",
  "for",
  "and",
  "or",
  "with",
  "it",
  "that",
  "this",
  "than",
  "is",
  "are",
  "be",
]);

export interface RoutingFields {
  readonly title: string;
  readonly when_to_use?: string;
  readonly not_for?: string;
  readonly keywords?: readonly string[];
}

/** Content-word token set of a chapter's routing row — what an agent actually reads to locate it. */
export function routingVocabulary(fields: RoutingFields): ReadonlySet<string> {
  const text = [
    fields.title,
    fields.when_to_use ?? "",
    fields.not_for ?? "",
    ...(fields.keywords ?? []),
  ].join(" ");
  return new Set(tokenize(text).filter((token) => !STOPWORDS.has(token)));
}

/** Content-word token set of a query string. */
export function queryVocabulary(query: string): ReadonlySet<string> {
  return new Set(tokenize(query).filter((token) => !STOPWORDS.has(token)));
}

/** Tokens present in both sets — empty means genuinely no lexical overlap. */
export function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): readonly string[] {
  return [...a].filter((token) => b.has(token));
}
