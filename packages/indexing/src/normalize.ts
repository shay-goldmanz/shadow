/**
 * Text normalization applied before hashing (`docs/INDEXING.md`,
 * "normalize = strip per-line trailing whitespace, collapse blank runs,
 * LF endings"), so reformatting a chapter does not churn its hashes.
 */
export function normalizeForHashing(text: string): string {
  const lfOnly = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trailingWhitespaceStripped = lfOnly
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
  // Collapse runs of 2+ consecutive blank lines down to a single blank line.
  return trailingWhitespaceStripped.replace(/\n{3,}/g, "\n\n");
}
