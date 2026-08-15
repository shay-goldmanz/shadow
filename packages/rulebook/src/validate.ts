/**
 * Validates one chunk's raw LLM extraction output against the pinned
 * evidence snapshot — the load-bearing invariant from the Phase A review:
 * the snapshot a quote is checked against is `normalizeNfcWs` output (NFC +
 * all whitespace runs collapsed to one space), and `buildSpanFromQuote`
 * later binds with raw `indexOf` against that same flattened text. So each
 * quote is normalized here, **once**, and the normalized form is what
 * survives into `ValidatedRule` and flows onward to `merge.ts` and eventual
 * span binding — validation and binding share one predicate
 * (`normalizedSnapshotText.includes(normalizedQuote)`), never two.
 */

import { normalizeNfcWs, splitSentences } from "@shadow/evidence";
import type { ExtractedRule } from "./schemas.ts";

/** A rule that survived validation, with every surviving quote already in its normalized (span-bindable) form. */
export interface ValidatedRule {
  readonly statement: string;
  readonly normalizedQuotes: readonly string[];
  readonly proposedGroup: string;
}

export interface ValidationResult {
  readonly kept: ValidatedRule[];
  readonly droppedQuotes: number;
  readonly droppedRules: number;
  readonly warnings: string[];
}

const MIN_QUOTE_LENGTH = 8;
/** Integers and simple decimals — good enough for the "does a numeral survive into some kept quote" sanity check. */
const NUMERAL_PATTERN = /\d+(?:\.\d+)?/g;

/**
 * Validate every rule extracted from one chunk against `normalizedSnapshotText`
 * (the `normalizeNfcWs`-flattened pinned snapshot for the chunk's source).
 *
 * Per rule: each quote is normalized and kept iff non-empty, at least
 * {@link MIN_QUOTE_LENGTH} chars, and an exact substring of
 * `normalizedSnapshotText`. A rule is dropped entirely only when *every*
 * quote fails — one surviving quote is enough to keep the rule (D18: a
 * claim needs at least one grounded span, not all of them intact). A
 * statement that segments into more than one sentence
 * (`@shadow/evidence`'s `splitSentences` — a claim is one sentence, D18)
 * is rejected outright regardless of its quotes. A numeral appearing in the
 * statement but in no kept quote is a warn-and-keep, not a rejection — it's
 * a signal worth surfacing, not proof the rule is ungrounded.
 */
export function validateChunkRules(
  rules: readonly ExtractedRule[],
  normalizedSnapshotText: string,
): ValidationResult {
  const kept: ValidatedRule[] = [];
  const warnings: string[] = [];
  let droppedQuotes = 0;
  let droppedRules = 0;

  for (const rule of rules) {
    if (splitSentences(rule.statement).length > 1) {
      droppedRules += 1;
      warnings.push(`dropped rule (statement is more than one sentence): "${rule.statement}"`);
      continue;
    }

    const survivingQuotes: string[] = [];
    for (const quote of rule.quotes) {
      const normalized = normalizeNfcWs(quote);
      const isGrounded =
        normalized.length >= MIN_QUOTE_LENGTH && normalizedSnapshotText.includes(normalized);
      if (isGrounded) {
        if (!survivingQuotes.includes(normalized)) survivingQuotes.push(normalized);
      } else {
        droppedQuotes += 1;
      }
    }

    if (survivingQuotes.length === 0) {
      droppedRules += 1;
      warnings.push(`dropped rule (no quote survived validation): "${rule.statement}"`);
      continue;
    }

    const numeralsInStatement = rule.statement.match(NUMERAL_PATTERN) ?? [];
    const uncoveredNumeral = numeralsInStatement.find(
      (numeral) => !survivingQuotes.some((quote) => quote.includes(numeral)),
    );
    if (uncoveredNumeral !== undefined) {
      warnings.push(
        `numeral "${uncoveredNumeral}" in statement not found in any kept quote: "${rule.statement}"`,
      );
    }

    kept.push({
      statement: rule.statement,
      normalizedQuotes: survivingQuotes,
      proposedGroup: rule.group,
    });
  }

  return { kept, droppedQuotes, droppedRules, warnings };
}
