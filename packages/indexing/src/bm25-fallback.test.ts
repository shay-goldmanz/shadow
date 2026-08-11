import { describe, expect, test } from "bun:test";
import {
  bm25Fallback,
  buildFallbackIndex,
  detectDisagreement,
  rollupFallbackPromotion,
} from "./bm25-fallback.ts";
import type {
  ChapterIndexNode,
  IndexDocument,
  SectionIndexNode,
  VolumeIndexNode,
} from "./types.ts";
import { INDEX_SCHEMA_VERSION } from "./types.ts";

function chapter(
  overrides: Partial<ChapterIndexNode> & { node_id: string; title: string },
): ChapterIndexNode {
  return {
    kind: "chapter",
    slug: overrides.node_id.toLowerCase(),
    path: ["Volume", overrides.title],
    file: `volumes/v/chapters/${overrides.node_id}.md`,
    tokens: 100,
    span: { start_byte: 0, end_byte: 10 },
    content_hash: "sha256:aa",
    subtree_hash: "sha256:aa",
    ...overrides,
  };
}

function volume(volumeId: string, chapters: readonly ChapterIndexNode[]): VolumeIndexNode {
  return {
    volume_id: volumeId,
    title: volumeId,
    chapter_count: chapters.length,
    volume_hash: "sha256:bb",
    chapters,
  };
}

function document(volumes: readonly VolumeIndexNode[]): IndexDocument {
  const chapters = volumes.reduce((sum, v) => sum + v.chapter_count, 0);
  return {
    schema_version: INDEX_SCHEMA_VERSION,
    generated_at: new Date(0).toISOString(),
    corpus_hash: "sha256:cc",
    stats: { volumes: volumes.length, chapters, tokens: 0 },
    volumes,
  };
}

function sectionNode(nodeId: string, title: string): SectionIndexNode {
  return {
    node_id: nodeId,
    kind: "section",
    title,
    level: 2,
    heading_path: [title],
    span: { start_byte: 0, end_byte: 1 },
    tokens: 10,
    content_hash: "sha256:aa",
    subtree_hash: "sha256:aa",
  };
}

describe("buildFallbackIndex / bm25Fallback — catches vocabulary when_to_use misses", () => {
  test("finds a chapter by a product name that only appears in the body, not when_to_use", () => {
    const linear = chapter({
      node_id: "N1",
      title: "Density",
      when_to_use: "Designing dense list views and tables",
    });
    const other = chapter({ node_id: "N2", title: "Onboarding" });
    const doc = document([volume("v", [linear, other])]);
    const bodies = new Map([
      [linear.node_id, "Linear renders rows at 32px height and truncates aggressively."],
      [other.node_id, "Welcome screens should feel warm and low-friction."],
    ]);

    const index = buildFallbackIndex(doc, bodies);
    const hits = bm25Fallback(index, "Linear row height");
    expect(hits[0]?.id).toBe("N1");
  });

  test("indexes sections too, where a chapter has them", () => {
    const section: SectionIndexNode = {
      node_id: "N1#epoch",
      kind: "section",
      title: "Epoch's one-pagers",
      level: 2,
      heading_path: ["Epoch's one-pagers"],
      span: { start_byte: 0, end_byte: 20 },
      tokens: 20,
      content_hash: "sha256:aa",
      subtree_hash: "sha256:aa",
    };
    const withSection = chapter({ node_id: "N1", title: "Formats", sections: [section] });
    const doc = document([volume("v", [withSection])]);
    const bodies = new Map([[withSection.node_id, "Epoch keeps one-pagers under 400 words."]]);

    const index = buildFallbackIndex(doc, bodies);
    const hits = bm25Fallback(index, "Epoch one-pagers");
    expect(hits.map((h) => h.id)).toContain("N1#epoch");
  });

  test("a chapter missing from the bodies map is indexed with an empty body rather than omitted", () => {
    const c = chapter({ node_id: "N1", title: "Density", keywords: ["density"] });
    const doc = document([volume("v", [c])]);
    const index = buildFallbackIndex(doc, new Map()); // no body supplied
    const hits = bm25Fallback(index, "density");
    expect(hits.map((h) => h.id)).toContain("N1");
  });

  test("limit caps the number of hits returned", () => {
    const chapters = Array.from({ length: 10 }, (_, i) =>
      chapter({ node_id: `N${i}`, title: `Chapter ${i}`, keywords: ["density"] }),
    );
    const doc = document([volume("v", chapters)]);
    const bodies = new Map(chapters.map((c) => [c.node_id, "density density density"]));
    const index = buildFallbackIndex(doc, bodies);
    expect(bm25Fallback(index, "density", 3)).toHaveLength(3);
  });
});

describe("rollupFallbackPromotion (I-6: rollup wired into the fallback's promotion)", () => {
  test("a childless chapter uses its own raw score directly", () => {
    const a = chapter({ node_id: "A", title: "Chapter A" });
    const b = chapter({ node_id: "B", title: "Chapter B" });
    const doc = document([volume("v", [a, b])]);
    const hits = [
      { id: "A", score: 3 },
      { id: "B", score: 1 },
    ];

    const promotion = rollupFallbackPromotion(doc, hits);

    expect(promotion).toEqual({ chapterId: "A", chapterScore: 3, bestNodeId: "A" });
  });

  test("no chapter scores above zero -> undefined (nothing to promote)", () => {
    const a = chapter({ node_id: "A", title: "Chapter A" });
    const doc = document([volume("v", [a])]);
    expect(rollupFallbackPromotion(doc, [{ id: "A", score: 0 }])).toBeUndefined();
  });

  test("aggregation beats a single higher-scoring section — changes the promoted node versus the flat top hit", () => {
    // Chapter A has ONE section scoring 8 — the single highest raw score
    // anywhere in the corpus. A flat "take the top hit" fallback promotes
    // it directly.
    //
    // Chapter B has THREE sections scoring 6 each — no individual section
    // beats A's 8, but B's rolled-up chapter score is
    // rollupScore([6,6,6]) = 18/sqrt(4) = 9, which *does* beat A's rolled-up
    // score of rollupScore([8]) = 8/sqrt(2) ≈ 5.657. B is the better answer
    // on aggregate even though its best individual section never wins a
    // flat top-hit comparison.
    const a = chapter({
      node_id: "A",
      title: "Chapter A",
      sections: [sectionNode("A#s1", "A section 1")],
    });
    const b = chapter({
      node_id: "B",
      title: "Chapter B",
      sections: [
        sectionNode("B#s1", "B section 1"),
        sectionNode("B#s2", "B section 2"),
        sectionNode("B#s3", "B section 3"),
      ],
    });
    const doc = document([volume("v", [a, b])]);
    const hits = [
      { id: "A", score: 0 }, // A's own flat document score is irrelevant once it has sections
      { id: "A#s1", score: 8 },
      { id: "B", score: 0 },
      { id: "B#s1", score: 6 },
      { id: "B#s2", score: 6 },
      { id: "B#s3", score: 6 },
    ];

    // Flat top-hit baseline: A's section (score 8) is the single highest
    // raw score in the whole hits array.
    const flatTop = hits.toSorted((x, y) => y.score - x.score)[0];
    expect(flatTop?.id).toBe("A#s1");

    // Rollup-aware promotion picks chapter B instead, and cites its own
    // best-scoring section within it (a three-way tie at 6, first wins).
    const promotion = rollupFallbackPromotion(doc, hits);
    expect(promotion?.chapterId).toBe("B");
    expect(promotion?.bestNodeId).toBe("B#s1");
    expect(promotion?.chapterScore).toBeCloseTo(9, 10);
  });

  test("nested sub-sections roll up before their parent chapter does", () => {
    const parent: SectionIndexNode = {
      ...sectionNode("C#parent", "Parent section"),
      sections: [
        sectionNode("C#parent#child1", "Child 1"),
        sectionNode("C#parent#child2", "Child 2"),
      ],
    };
    const c = chapter({ node_id: "C", title: "Chapter C", sections: [parent] });
    const doc = document([volume("v", [c])]);
    const hits = [
      { id: "C#parent#child1", score: 4 },
      { id: "C#parent#child2", score: 4 },
    ];

    // rollup(children) = 8/sqrt(3); chapter score = rollup([that]) = (8/sqrt(3))/sqrt(2)
    const expectedChapterScore = 8 / Math.sqrt(3) / Math.sqrt(2);
    const promotion = rollupFallbackPromotion(doc, hits);
    expect(promotion?.chapterScore).toBeCloseTo(expectedChapterScore, 10);
    // The best individual raw-scoring node is still one of the two tied children.
    expect(promotion?.bestNodeId).toBe("C#parent#child1");
  });
});

describe("detectDisagreement", () => {
  test("fires when BM25's top hit is not among the agent's chosen node_ids", () => {
    const signal = detectDisagreement(["N2"], [{ id: "N1", score: 4.2 }]);
    expect(signal).toEqual({ bm25TopNodeId: "N1", bm25TopScore: 4.2, agentChosen: ["N2"] });
  });

  test("does not fire when the agent's choice includes BM25's top hit", () => {
    expect(detectDisagreement(["N1", "N2"], [{ id: "N1", score: 4.2 }])).toBeUndefined();
  });

  test("does not fire when BM25 has no hits at all", () => {
    expect(detectDisagreement(["N2"], [])).toBeUndefined();
  });

  test("does not fire when the top hit has a zero score (no real match)", () => {
    expect(detectDisagreement(["N2"], [{ id: "N1", score: 0 }])).toBeUndefined();
  });
});
