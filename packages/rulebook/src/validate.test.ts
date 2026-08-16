import { describe, expect, test } from "bun:test";
import { normalizeNfcWs } from "@shadow/evidence";
import type { ExtractedRule } from "./schemas.ts";
import { validateChunkRules } from "./validate.ts";

function rawRule(overrides: Partial<ExtractedRule>): ExtractedRule {
  return {
    statement: "Borrowers must repay the principal in full within 30 days.",
    quotes: ["repay the principal in full within 30 days"],
    group: "payments",
    ...overrides,
  };
}

describe("validateChunkRules", () => {
  test("drops a paraphrased quote that is not an exact substring of the snapshot", () => {
    const snapshot = normalizeNfcWs(
      "The borrower shall repay the principal in full within 30 days of demand.",
    );
    const rule = rawRule({ quotes: ["the borrower must pay back the loan amount"] });

    const result = validateChunkRules([rule], snapshot);

    expect(result.kept).toHaveLength(0);
    expect(result.droppedRules).toBe(1);
    expect(result.droppedQuotes).toBe(1);
  });

  test("keeps a verbatim quote even when it's mangled with newlines/extra whitespace, because both sides go through the same nfc-ws normalization (the invariant)", () => {
    const snapshot = normalizeNfcWs(
      "The borrower shall repay the\nprincipal in full within 30 days of demand.",
    );
    // As if lifted verbatim from a PDF with different line wrapping / extra spaces.
    const mangledQuote = "repay   the\n  principal in full\nwithin 30 days";
    const rule = rawRule({ quotes: [mangledQuote] });

    const result = validateChunkRules([rule], snapshot);

    expect(result.kept).toHaveLength(1);
    expect(result.droppedQuotes).toBe(0);
    expect(result.kept[0]?.normalizedQuotes).toEqual([normalizeNfcWs(mangledQuote)]);
  });

  test("rejects a rule whose statement segments into more than one sentence, regardless of its quotes", () => {
    const snapshot = normalizeNfcWs(
      "The borrower shall repay the principal. The borrower shall also pay interest.",
    );
    const rule = rawRule({
      statement: "The borrower must repay principal. The borrower must also pay interest.",
      quotes: ["repay the principal", "pay interest"],
    });

    const result = validateChunkRules([rule], snapshot);

    expect(result.kept).toHaveLength(0);
    expect(result.droppedRules).toBe(1);
    expect(result.warnings.some((w) => w.includes("more than one sentence"))).toBe(true);
  });

  test("warns but keeps the rule when a numeral in the statement appears in no kept quote", () => {
    const snapshot = normalizeNfcWs(
      "The borrower shall repay the principal in full within 30 days.",
    );
    const rule = rawRule({
      statement: "Borrowers must repay the principal within 45 days.",
      quotes: ["repay the principal in full within 30 days"],
    });

    const result = validateChunkRules([rule], snapshot);

    expect(result.kept).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes("45"))).toBe(true);
  });

  test("drops the rule only when ALL of its quotes fail — one surviving quote keeps it", () => {
    const snapshot = normalizeNfcWs(
      "The borrower shall repay the principal in full within 30 days.",
    );
    const rule = rawRule({
      quotes: [
        "a completely fabricated quote that never appears",
        "repay the principal in full within 30 days",
      ],
    });

    const result = validateChunkRules([rule], snapshot);

    expect(result.kept).toHaveLength(1);
    expect(result.droppedQuotes).toBe(1);
    expect(result.droppedRules).toBe(0);
    expect(result.kept[0]?.normalizedQuotes).toEqual([
      normalizeNfcWs("repay the principal in full within 30 days"),
    ]);
  });

  test("drops a quote shorter than the minimum length even if it technically matches", () => {
    const snapshot = normalizeNfcWs("Pay in full.");
    const rule = rawRule({ quotes: ["Pay in"] });

    const result = validateChunkRules([rule], snapshot);

    expect(result.kept).toHaveLength(0);
    expect(result.droppedRules).toBe(1);
  });
});
