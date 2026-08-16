/**
 * Pure consolidation of validated rules across chunks — collapsing
 * duplicates the chunker's overlap (or the LLM re-deriving the same rule
 * from two different passages) would otherwise leave as separate rules.
 * The group-*finalization* LLM call that reconciles each consolidated
 * rule's `proposedGroup` against the final taxonomy is `finalize-groups.ts`'s
 * job; this module only exports the pure merge + the schema (`schemas.ts`)
 * that call uses.
 */

import { disambiguateLabels, ruleLabel } from "./labels.ts";
import type { ValidatedRule } from "./validate.ts";

export interface ConsolidatedRule extends ValidatedRule {
  readonly label: string;
}

interface MergeBucket {
  statement: string;
  quotes: string[];
  proposedGroup: string;
}

/** Order-independent key for "these two rules cite the exact same set of quotes". */
function quoteSetKey(quotes: readonly string[]): string {
  return [...quotes].sort().join("\u0000");
}

function foldStatement(statement: string): string {
  return statement.toLowerCase().trim();
}

/**
 * Merge rules whose statements are identical case-folded, OR whose
 * normalized-quote sets are identical, into one — the union of normalized
 * quotes, order-stable and deduped (first-seen order wins). Distinct rules
 * that share neither are left untouched. Labels are assigned after
 * merging (`ruleLabel`) and disambiguated (`disambiguateLabels`) so a
 * post-merge hash collision gets its `-2` suffix.
 */
export function consolidateRules(rules: readonly ValidatedRule[]): ConsolidatedRule[] {
  const buckets: MergeBucket[] = [];

  for (const rule of rules) {
    const statementKey = foldStatement(rule.statement);
    const quoteKey = quoteSetKey(rule.normalizedQuotes);
    const existing = buckets.find(
      (bucket) =>
        foldStatement(bucket.statement) === statementKey || quoteSetKey(bucket.quotes) === quoteKey,
    );
    if (existing) {
      for (const quote of rule.normalizedQuotes) {
        if (!existing.quotes.includes(quote)) existing.quotes.push(quote);
      }
      continue;
    }
    buckets.push({
      statement: rule.statement,
      quotes: [...rule.normalizedQuotes],
      proposedGroup: rule.proposedGroup,
    });
  }

  const consolidated: ConsolidatedRule[] = buckets.map((bucket) => ({
    statement: bucket.statement,
    normalizedQuotes: bucket.quotes,
    proposedGroup: bucket.proposedGroup,
    label: ruleLabel(bucket.statement),
  }));

  return disambiguateLabels(consolidated);
}
