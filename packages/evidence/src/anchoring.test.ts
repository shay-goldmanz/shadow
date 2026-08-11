import { describe, expect, test } from "bun:test";
import { resolveSelector } from "./anchoring.ts";
import type { TextQuoteSelector } from "./types.ts";

function selector(partial: Partial<TextQuoteSelector> & { exact: string }): TextQuoteSelector {
  return { type: "TextQuoteSelector", ...partial };
}

describe("resolveSelector", () => {
  test("exact hit with no refinedBy", () => {
    const text = "The quick brown fox jumps over the lazy dog.";
    const result = resolveSelector(selector({ exact: "brown fox jumps" }), text);
    expect(result.status).toBe("anchored");
    expect(result.start).toBe(text.indexOf("brown fox jumps"));
    expect(result.end).toBe((result.start ?? 0) + "brown fox jumps".length);
  });

  test("valid refinedBy fast path is trusted", () => {
    const text = "Every measurement in the sidebar is a multiple of four.";
    const exact = "multiple of four";
    const start = text.indexOf(exact);
    const end = start + exact.length;
    const result = resolveSelector(
      selector({ exact, refinedBy: { type: "TextPositionSelector", start, end } }),
      text,
    );
    expect(result).toEqual({ status: "anchored", start, end });
  });

  test("stale refinedBy is rejected, not trusted, and the quote is re-found", () => {
    const text = "Every measurement in the sidebar is a multiple of four.";
    const exact = "multiple of four";
    const trueStart = text.indexOf(exact);
    // A cached offset that no longer matches (e.g. text shifted upstream).
    const staleOffset = { type: "TextPositionSelector" as const, start: 0, end: exact.length };
    const result = resolveSelector(selector({ exact, refinedBy: staleOffset }), text);
    expect(result.status).toBe("anchored");
    expect(result.start).toBe(trueStart);
  });

  test("refinedBy out of bounds falls through safely", () => {
    const text = "short text";
    const exact = "short";
    const badOffset = { type: "TextPositionSelector" as const, start: 500, end: 600 };
    const result = resolveSelector(selector({ exact, refinedBy: badOffset }), text);
    expect(result.status).toBe("anchored");
    expect(result.start).toBe(0);
  });

  test("multiple exact matches disambiguated by prefix/suffix", () => {
    const text = "Section A: the answer is 4. Section B: the answer is 4, definitively.";
    const sel = selector({
      exact: "the answer is 4",
      prefix: "Section B: ",
      suffix: ", definitively.",
    });
    const result = resolveSelector(sel, text);
    expect(result.status).toBe("anchored");
    expect(result.start).toBe(text.lastIndexOf("the answer is 4"));
  });

  test("multiple exact matches disambiguated toward the prefix-matching one", () => {
    const text = "Intro. First: metric rose 10%. Later: metric rose 10% again in Q3.";
    const sel = selector({
      exact: "metric rose 10%",
      prefix: "First: ",
    });
    const result = resolveSelector(sel, text);
    expect(result.start).toBe(text.indexOf("metric rose 10%"));
  });

  test("fuzzy match after a small edit (one word changed)", () => {
    const original = "Linear never uses drop shadows in its sidebar navigation component.";
    const edited = "Linear rarely uses drop shadows in its sidebar navigation component.";
    const sel = selector({ exact: original });
    const result = resolveSelector(sel, edited);
    expect(result.status).toBe("anchored-fuzzy");
    expect(result.distance).toBeGreaterThan(0);
    expect(result.start).toBeDefined();
    expect(edited.slice(result.start, result.end)).toContain("uses drop shadows");
  });

  test("genuine orphan when the cited text was deleted outright", () => {
    const text = "This paragraph says something completely different now.";
    const sel = selector({ exact: "Linear renders its sidebar on a 4px spacing scale." });
    const result = resolveSelector(sel, text);
    expect(result.status).toBe("orphaned");
    expect(result.start).toBeUndefined();
  });

  test("allowFuzzy: false rejects a near-but-not-exact match as orphaned", () => {
    const original = "The operator said budgets should stay under ten thousand dollars.";
    const edited = "The operator said budgets should stay under nine thousand dollars.";
    const sel = selector({ exact: original });
    const result = resolveSelector(sel, edited, { allowFuzzy: false });
    expect(result.status).toBe("orphaned");
  });

  test("empty exact never matches anything but does not throw", () => {
    const result = resolveSelector(selector({ exact: "" }), "some text");
    expect(result.status).toBe("orphaned");
  });
});
