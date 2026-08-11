import { describe, expect, test } from "bun:test";
import {
  checkDiscriminability,
  DEFAULT_DISCRIMINABILITY_THRESHOLD,
  discriminabilityCheck,
} from "./lint-discriminability.ts";
import { chapter, document, volume } from "./lint-fixtures.ts";
import { tokenSetJaccard } from "./lint-similarity.ts";

describe("checkDiscriminability", () => {
  test("two near-identical when_to_use values are flagged", () => {
    // 19 shared tokens, one differing word each side ("screens" / "views")
    // -> jaccard = 18/20 = 0.9, comfortably above the 0.85 default.
    const a = chapter({
      node_id: "A",
      title: "Dense tables",
      when_to_use:
        "Designing dense tables, lists, dashboards, and grids with many rows, tight row heights, and truncated labels for data-heavy screens",
    });
    const b = chapter({
      node_id: "B",
      title: "Row density",
      when_to_use:
        "Designing dense tables, lists, dashboards, and grids with many rows, tight row heights, and truncated labels for data-heavy views",
    });
    const doc = document([volume({ volume_id: "v", chapters: [a, b] })]);

    const result = checkDiscriminability(doc);

    expect(result.checkId).toBe("discriminability");
    expect(result.requiresModel).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.code).toBe("discriminability-collision");
    expect(result.findings[0]?.severity).toBe("warning");
    expect(result.findings[0]?.nodeIds).toEqual(["A", "B"]);
  });

  test("two genuinely distinct when_to_use values are not flagged", () => {
    const a = chapter({
      node_id: "A",
      title: "Dense tables",
      when_to_use: "Designing dense tables, lists, and dashboards",
    });
    const b = chapter({
      node_id: "B",
      title: "Onboarding",
      when_to_use: "Designing warm, spacious onboarding flows for first-time users",
    });
    const doc = document([volume({ volume_id: "v", chapters: [a, b] })]);

    const result = checkDiscriminability(doc);

    expect(result.findings).toHaveLength(0);
  });

  test("a pair just above the threshold is flagged, a pair just below is not", () => {
    // Constructed so token-set Jaccard lands on either side of 0.85: 17
    // shared tokens plus 3 extra (unique) tokens in "below" -> 17/20 =
    // 0.85 exactly (not > 0.85, so NOT flagged); "above" adds one fewer
    // extra token -> 17/19 ≈ 0.895 (> 0.85, flagged).
    const shared = Array.from({ length: 17 }, (_, i) => `term${i}`).join(" ");
    const belowWhenToUse = `${shared} extra1 extra2 extra3`;
    const aboveWhenToUse = `${shared} extra1 extra2`;

    const belowSimilarity = tokenSetJaccard(shared, belowWhenToUse);
    const aboveSimilarity = tokenSetJaccard(shared, aboveWhenToUse);
    expect(belowSimilarity).toBeCloseTo(0.85, 10);
    expect(belowSimilarity).not.toBeGreaterThan(DEFAULT_DISCRIMINABILITY_THRESHOLD);
    expect(aboveSimilarity).toBeGreaterThan(DEFAULT_DISCRIMINABILITY_THRESHOLD);

    const below = document([
      volume({
        volume_id: "below",
        chapters: [
          chapter({ node_id: "A", title: "A", when_to_use: shared }),
          chapter({ node_id: "B", title: "B", when_to_use: belowWhenToUse }),
        ],
      }),
    ]);
    const above = document([
      volume({
        volume_id: "above",
        chapters: [
          chapter({ node_id: "C", title: "C", when_to_use: shared }),
          chapter({ node_id: "D", title: "D", when_to_use: aboveWhenToUse }),
        ],
      }),
    ]);

    expect(checkDiscriminability(below).findings).toHaveLength(0);
    expect(checkDiscriminability(above).findings).toHaveLength(1);
  });

  test("threshold is configurable", () => {
    const a = chapter({ node_id: "A", title: "A", when_to_use: "designing tables and lists" });
    const b = chapter({ node_id: "B", title: "B", when_to_use: "designing tables and rows" });
    const doc = document([volume({ volume_id: "v", chapters: [a, b] })]);

    // Below default threshold (0.85), so unflagged by default...
    expect(checkDiscriminability(doc).findings).toHaveLength(0);
    // ...but flagged with a lower threshold configured explicitly.
    const similarity = tokenSetJaccard(a.when_to_use as string, b.when_to_use as string);
    const lax = checkDiscriminability(doc, { threshold: similarity - 0.01 });
    expect(lax.findings).toHaveLength(1);
  });

  test("chapters in different volumes are never compared, however similar", () => {
    const a = chapter({ node_id: "A", title: "A", when_to_use: "designing dense tables" });
    const b = chapter({ node_id: "B", title: "B", when_to_use: "designing dense tables" });
    const doc = document([
      volume({ volume_id: "v1", chapters: [a] }),
      volume({ volume_id: "v2", chapters: [b] }),
    ]);

    expect(checkDiscriminability(doc).findings).toHaveLength(0);
  });

  test("a pair missing when_to_use on either side is skipped, not flagged", () => {
    const a = chapter({ node_id: "A", title: "A", when_to_use: undefined });
    const b = chapter({ node_id: "B", title: "B", when_to_use: "designing dense tables" });
    const doc = document([volume({ volume_id: "v", chapters: [a, b] })]);

    expect(checkDiscriminability(doc).findings).toHaveLength(0);
  });

  test("discriminabilityCheck (LintCheck-shaped) matches checkDiscriminability", () => {
    const a = chapter({ node_id: "A", title: "A", when_to_use: "x y z" });
    const b = chapter({ node_id: "B", title: "B", when_to_use: "x y z" });
    const doc = document([volume({ volume_id: "v", chapters: [a, b] })]);

    expect(discriminabilityCheck.id).toBe("discriminability");
    expect(discriminabilityCheck.requiresModel).toBe(false);
    expect(discriminabilityCheck.run(doc)).toEqual(checkDiscriminability(doc));
  });
});
