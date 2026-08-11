/**
 * Token count approximation.
 *
 * We have no tokenizer and deliberately do not add one (no dependency, no
 * model-specific vocabulary to keep in sync). The standard rough heuristic
 * for English prose is ~4 characters per token; we use that, rounded up so
 * a non-empty string never estimates to 0 tokens.
 *
 * Every call in this package goes through this one function so the
 * approximation can be swapped (e.g. for a real tokenizer, or a
 * language-aware heuristic) without touching call sites.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}
