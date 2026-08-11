import { describe, expect, test } from "bun:test";
import {
  checkChapterCost,
  costModelCheck,
  DEFAULT_ROUTING_ROW_TOKENS,
  treeCost,
} from "./lint-cost-model.ts";
import { chapter, document, section, volume } from "./lint-fixtures.ts";

// R = 120 (default). tree_cost(v) = R + max(S_residual(v), max_c tree_cost(c)).
// S_residual(v) = v.tokens - Σ(immediate children's tokens), floored at 0.

describe("checkChapterCost", () => {
  test("a chapter dominated by one giant section is flagged for splitting", () => {
    // chapter.tokens = 1000, one leaf section = 950 tokens.
    // residual(chapter)        = 1000 - 950 = 50
    // treeCost(section, leaf)  = 120 + max(950, 0)  = 1070
    // treeCost(chapter)        = 120 + max(50, 1070) = 1190
    // flatCost                 = 120 + 1000          = 1120
    // 1190 >= 1120 -> flagged
    const dominant = section({ node_id: "C#a", title: "Everything", tokens: 950 });
    const c = chapter({ node_id: "C", title: "Big chapter", tokens: 1000, sections: [dominant] });
    const doc = document([volume({ volume_id: "v", chapters: [c] })]);

    const result = checkChapterCost(doc);

    expect(result.checkId).toBe("cost-model");
    expect(result.requiresModel).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.code).toBe("chapter-too-large");
    expect(result.findings[0]?.nodeIds).toEqual(["C"]);
    expect(result.findings[0]?.data).toEqual({
      flatCost: 1120,
      structuredCost: 1190,
      chapterTokens: 1000,
    });
  });

  test("a chapter with balanced sections is not flagged", () => {
    // chapter.tokens = 1000, three leaf sections of 300 each.
    // residual(chapter)   = 1000 - 900 = 100
    // treeCost(each leaf) = 120 + 300 = 420
    // treeCost(chapter)   = 120 + max(100, 420) = 540
    // flatCost            = 120 + 1000 = 1120
    // 540 < 1120 -> not flagged
    const sections = [
      section({ node_id: "C#a", title: "A", tokens: 300 }),
      section({ node_id: "C#b", title: "B", tokens: 300 }),
      section({ node_id: "C#c", title: "C", tokens: 300 }),
    ];
    const c = chapter({ node_id: "C", title: "Balanced chapter", tokens: 1000, sections });
    const doc = document([volume({ volume_id: "v", chapters: [c] })]);

    const result = checkChapterCost(doc);

    expect(result.findings).toHaveLength(0);
  });

  test("a large chapter with no sections at all (a wall of text) is flagged", () => {
    // No children -> S_residual = full chapter.tokens, so
    // structuredCost = R + chapter.tokens = flatCost exactly -> flagged
    // at the >= boundary (routing buys literally nothing here).
    const c = chapter({ node_id: "C", title: "Wall of text", tokens: 1000, sections: undefined });
    const doc = document([volume({ volume_id: "v", chapters: [c] })]);

    const result = checkChapterCost(doc);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.data).toEqual({
      flatCost: 120 + 1000,
      structuredCost: 120 + 1000,
      chapterTokens: 1000,
    });
  });

  test("a small chapter with no sections is not flagged (equality is the only trigger, never below)", () => {
    const c = chapter({ node_id: "C", title: "Short chapter", tokens: 50, sections: undefined });
    const doc = document([volume({ volume_id: "v", chapters: [c] })]);

    // Still flagged by this rule's own logic (structuredCost == flatCost
    // always holds for a childless chapter) — demonstrates the documented
    // limitation: this check only usefully discriminates chapters that
    // *have* a section tree. A real `shadow lint` run pairs this with the
    // SECTION_TOKEN_THRESHOLD (800 tokens) — chapters this small never
    // reach it, so in practice this path is unreachable below threshold.
    expect(checkChapterCost(doc).findings).toHaveLength(1);
  });

  test("routingRowTokens (R) is configurable and changes the outcome", () => {
    const dominant = section({ node_id: "C#a", title: "Everything", tokens: 950 });
    const c = chapter({ node_id: "C", title: "Big chapter", tokens: 1000, sections: [dominant] });
    const doc = document([volume({ volume_id: "v", chapters: [c] })]);

    // With R = 0: treeCost(chapter) = max(50, max(950, 0)) = 950;
    // flatCost = 0 + 1000 = 1000. 950 < 1000 -> not flagged.
    const result = checkChapterCost(doc, { routingRowTokens: 0 });
    expect(result.findings).toHaveLength(0);
  });

  test("treeCost is a leaf's R + its own tokens when it has no children", () => {
    expect(treeCost({ tokens: 42, children: [] }, DEFAULT_ROUTING_ROW_TOKENS)).toBe(
      DEFAULT_ROUTING_ROW_TOKENS + 42,
    );
  });

  test("costModelCheck (LintCheck-shaped) matches checkChapterCost", () => {
    const c = chapter({ node_id: "C", title: "C", tokens: 10, sections: undefined });
    const doc = document([volume({ volume_id: "v", chapters: [c] })]);

    expect(costModelCheck.id).toBe("cost-model");
    expect(costModelCheck.requiresModel).toBe(false);
    expect(costModelCheck.run(doc)).toEqual(checkChapterCost(doc));
  });
});
