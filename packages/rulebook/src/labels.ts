/**
 * Content-derived rule labels. Deriving a label from the statement's
 * content (rather than, say, a random ULID) means re-running the pipeline
 * over an unchanged document produces the same labels — stable identifiers
 * across re-runs, which matters once a rule book is published and other
 * material might reference a rule by label.
 */

function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function foldForLabel(statement: string): string {
  return statement.toLowerCase().replace(/\s+/g, " ").trim();
}

/** `r-` + the first 8 hex chars of the sha256 of the case-folded, whitespace-normalized statement. */
export function ruleLabel(statement: string): string {
  return `r-${sha256Hex(foldForLabel(statement)).slice(0, 8)}`;
}

/**
 * Two distinct statements can (rarely) fold to the same 8-hex-char label.
 * Rather than widening the hash (and making labels uglier for the common
 * case), a collision after consolidation gets a `-2`, `-3`, ... suffix in
 * first-seen order. The first occurrence of a label is left untouched.
 */
export function disambiguateLabels<T extends { readonly label: string }>(
  rules: readonly T[],
): T[] {
  const seenCount = new Map<string, number>();
  return rules.map((rule) => {
    const count = seenCount.get(rule.label) ?? 0;
    seenCount.set(rule.label, count + 1);
    return count === 0 ? rule : { ...rule, label: `${rule.label}-${count + 1}` };
  });
}
