import { describe, expect, test } from "bun:test";
import { bm25Fallback, buildFallbackIndex, detectDisagreement } from "./bm25-fallback.ts";
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
