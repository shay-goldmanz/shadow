import { describe, expect, test } from "bun:test";
import { ancestorClosure, flattenIndex, renderOutline } from "./closure.ts";
import type {
  ChapterIndexNode,
  IndexDocument,
  SectionIndexNode,
  VolumeIndexNode,
} from "./types.ts";
import { INDEX_SCHEMA_VERSION } from "./types.ts";

function section(
  overrides: Partial<SectionIndexNode> & { node_id: string; title: string },
): SectionIndexNode {
  return {
    kind: "section",
    level: 2,
    heading_path: [overrides.title],
    span: { start_byte: 0, end_byte: 1 },
    tokens: 10,
    content_hash: "sha256:aa",
    subtree_hash: "sha256:aa",
    ...overrides,
  };
}

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

function volume(
  overrides: Partial<VolumeIndexNode> & {
    volume_id: string;
    chapters: readonly ChapterIndexNode[];
  },
): VolumeIndexNode {
  return {
    title: overrides.volume_id,
    chapter_count: overrides.chapters.length,
    volume_hash: "sha256:bb",
    ...overrides,
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

// Fixture:
// Volume A
//   Chapter1
//     S1
//       S1a
//     S2
//       S2a
//   Chapter2
//   Chapter3
// Volume B
//   Chapter4
const s1a = section({ node_id: "CH1#s1/s1a", title: "S1a", level: 3 });
const s2a = section({ node_id: "CH1#s2/s2a", title: "S2a", level: 3 });
const s1 = section({ node_id: "CH1#s1", title: "S1", sections: [s1a] });
const s2 = section({ node_id: "CH1#s2", title: "S2", sections: [s2a] });
const chapter1 = chapter({ node_id: "CH1", title: "Chapter1", sections: [s1, s2] });
const chapter2 = chapter({ node_id: "CH2", title: "Chapter2" });
const chapter3 = chapter({ node_id: "CH3", title: "Chapter3" });
const chapter4 = chapter({ node_id: "CH4", title: "Chapter4" });
const volumeA = volume({ volume_id: "vol-a", chapters: [chapter1, chapter2, chapter3] });
const volumeB = volume({ volume_id: "vol-b", chapters: [chapter4] });
const fixture = document([volumeA, volumeB]);

describe("flattenIndex", () => {
  test("depths: volume=0, chapter=1, section=2, nested section=3", () => {
    const flat = flattenIndex(fixture);
    expect(flat.get("vol-a")?.depth).toBe(0);
    expect(flat.get("CH1")?.depth).toBe(1);
    expect(flat.get("CH1#s1")?.depth).toBe(2);
    expect(flat.get("CH1#s1/s1a")?.depth).toBe(3);
  });

  test("parent pointers and child lists are consistent with the source tree", () => {
    const flat = flattenIndex(fixture);
    expect(flat.get("CH1")?.parentId).toBe("vol-a");
    expect(flat.get("CH1#s1")?.parentId).toBe("CH1");
    expect(flat.get("vol-a")?.childIds).toEqual(["CH1", "CH2", "CH3"]);
    expect(flat.get("CH1")?.childIds).toEqual(["CH1#s1", "CH1#s2"]);
  });
});

describe("ancestorClosure — hits, ancestors, siblings included; unrelated branches pruned", () => {
  test("a nested section hit pulls in its ancestor chain, its own siblings, but not its parent's siblings", () => {
    const keep = new Set(ancestorClosure(fixture, ["CH1#s1/s1a"]));
    // The hit itself.
    expect(keep.has("CH1#s1/s1a")).toBe(true);
    // Ancestors: S1, Chapter1, Volume A.
    expect(keep.has("CH1#s1")).toBe(true);
    expect(keep.has("CH1")).toBe(true);
    expect(keep.has("vol-a")).toBe(true);
    // S1a has no siblings (only child of S1) — nothing extra from that rule here.
    // Unrelated branches pruned: Chapter1's other section (S2) and its
    // descendants, Chapter1's sibling chapters, and volume B entirely.
    expect(keep.has("CH1#s2")).toBe(false);
    expect(keep.has("CH1#s2/s2a")).toBe(false);
    expect(keep.has("CH2")).toBe(false);
    expect(keep.has("CH3")).toBe(false);
    expect(keep.has("vol-b")).toBe(false);
    expect(keep.has("CH4")).toBe(false);
  });

  test("a section hit's immediate siblings are included, but siblings' own children are pruned", () => {
    const keep = new Set(ancestorClosure(fixture, ["CH1#s1"]));
    expect(keep.has("CH1#s1")).toBe(true); // hit
    expect(keep.has("CH1")).toBe(true); // ancestor
    expect(keep.has("vol-a")).toBe(true); // ancestor
    expect(keep.has("CH1#s2")).toBe(true); // immediate sibling
    expect(keep.has("CH1#s1/s1a")).toBe(true); // hit's own direct child
    expect(keep.has("CH1#s2/s2a")).toBe(false); // sibling's child — pruned
  });

  test("a chapter-level hit includes sibling chapters in the same volume, but not the other volume", () => {
    const keep = new Set(ancestorClosure(fixture, ["CH1"]));
    expect(keep.has("CH1")).toBe(true); // hit
    expect(keep.has("vol-a")).toBe(true); // ancestor
    expect(keep.has("CH2")).toBe(true); // sibling chapter, same volume
    expect(keep.has("CH3")).toBe(true); // sibling chapter, same volume
    expect(keep.has("CH1#s1")).toBe(true); // hit's own direct children
    expect(keep.has("CH1#s2")).toBe(true);
    expect(keep.has("CH1#s1/s1a")).toBe(false); // grandchild — pruned, one level only
    // Unrelated branch: volume B and its chapter are never pulled in.
    expect(keep.has("vol-b")).toBe(false);
    expect(keep.has("CH4")).toBe(false);
  });

  test("multiple hits union their closures", () => {
    const keep = new Set(ancestorClosure(fixture, ["CH1#s1/s1a", "CH4"]));
    expect(keep.has("CH1#s1/s1a")).toBe(true);
    expect(keep.has("CH1")).toBe(true);
    expect(keep.has("vol-a")).toBe(true);
    expect(keep.has("CH4")).toBe(true);
    expect(keep.has("vol-b")).toBe(true);
  });

  test("unknown node_ids are skipped rather than throwing", () => {
    expect(() => ancestorClosure(fixture, ["does-not-exist"])).not.toThrow();
    expect(ancestorClosure(fixture, ["does-not-exist"])).toEqual([]);
  });

  test("returned ids are in document order, not hit order", () => {
    const keep = ancestorClosure(fixture, ["CH1#s1/s1a"]);
    const order = ["vol-a", "CH1", "CH1#s1", "CH1#s1/s1a"];
    expect(keep).toEqual(order);
  });
});

describe("renderOutline — indented, node_id on every row, no body text", () => {
  test("every row carries a node_id in brackets, and no body text appears anywhere", () => {
    const keep = ancestorClosure(fixture, ["CH1#s1"]);
    const outline = renderOutline(fixture, keep);
    const lines = outline.split("\n");
    // One line per kept node.
    expect(lines).toHaveLength(keep.length);
    for (const line of lines) {
      expect(line).toMatch(/\[[^\]]+\]$/);
    }
    // node_id on every row, matching the kept set exactly.
    const idsInOutline = lines.map((line) => /\[([^\]]+)\]$/.exec(line)?.[1]);
    expect(idsInOutline).toEqual([...keep]);

    // No body text: none of the fixture's section/chapter bodies exist in
    // this fixture at all (only structural fields), so the strongest
    // assertion available here is that the outline contains nothing but
    // title + node_id per row — verified structurally above — and that
    // rendering is a pure function of the index document, never touching
    // any body/content field.
    for (const line of lines) {
      expect(line).not.toMatch(/content_hash|span|start_byte/);
    }
  });

  test("depth increases indentation by two spaces per level", () => {
    const keep = ancestorClosure(fixture, ["CH1#s1/s1a"]);
    const outline = renderOutline(fixture, keep);
    const lines = outline.split("\n");
    // vol-a (0), CH1 (1), CH1#s1 (2), CH1#s1/s1a (3)
    expect(lines[0]?.startsWith(" ")).toBe(false);
    expect(lines[1]?.startsWith("  ") && !lines[1]?.startsWith("    ")).toBe(true);
    expect(lines[2]?.startsWith("    ") && !lines[2]?.startsWith("      ")).toBe(true);
    expect(lines[3]?.startsWith("      ")).toBe(true);
  });

  test("unknown node_ids in the id list are skipped, not rendered as blank/broken rows", () => {
    const outline = renderOutline(fixture, ["vol-a", "does-not-exist", "CH1"]);
    expect(outline.split("\n")).toEqual(["vol-a [vol-a]", "  Chapter1 [CH1]"]);
  });
});
