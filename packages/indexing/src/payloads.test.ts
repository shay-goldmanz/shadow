import { describe, expect, test } from "bun:test";
import {
  buildNavigatePayload,
  buildRoutePayload,
  CHAPTER_INDEX_THRESHOLD,
  shouldSkipRouting,
} from "./payloads.ts";
import type { ChapterIndexNode, IndexDocument, VolumeIndexNode } from "./types.ts";
import { INDEX_SCHEMA_VERSION } from "./types.ts";

function chapter(overrides: Partial<ChapterIndexNode> & { node_id: string }): ChapterIndexNode {
  return {
    kind: "chapter",
    title: overrides.title ?? overrides.node_id,
    slug: overrides.slug ?? overrides.node_id.toLowerCase(),
    path: overrides.path ?? ["Volume", overrides.title ?? overrides.node_id],
    file: overrides.file ?? `volumes/v/chapters/${overrides.node_id}.md`,
    tokens: overrides.tokens ?? 100,
    span: overrides.span ?? { start_byte: 0, end_byte: 10 },
    content_hash: overrides.content_hash ?? "sha256:aa",
    subtree_hash: overrides.subtree_hash ?? "sha256:aa",
    ...overrides,
  };
}

function volume(overrides: Partial<VolumeIndexNode> & { volume_id: string }): VolumeIndexNode {
  return {
    title: overrides.title ?? overrides.volume_id,
    chapter_count: overrides.chapters?.length ?? 0,
    volume_hash: overrides.volume_hash ?? "sha256:bb",
    chapters: overrides.chapters ?? [],
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

function manyChapters(n: number, prefix = "C"): ChapterIndexNode[] {
  return Array.from({ length: n }, (_, i) => chapter({ node_id: `${prefix}${i}` }));
}

describe("shouldSkipRouting / buildRoutePayload — threshold behavior", () => {
  test("exactly at the threshold (60 chapters): routing is skipped", () => {
    const doc = document([
      volume({ volume_id: "v", chapters: manyChapters(CHAPTER_INDEX_THRESHOLD) }),
    ]);
    expect(shouldSkipRouting(doc)).toBe(true);
    expect(buildRoutePayload(doc)).toEqual({
      stage: "route",
      query: "",
      skip: true,
      volumes: [],
    });
  });

  test("one over the threshold (61 chapters): routing is not skipped", () => {
    const doc = document([
      volume({ volume_id: "v", chapters: manyChapters(CHAPTER_INDEX_THRESHOLD + 1) }),
    ]);
    expect(shouldSkipRouting(doc)).toBe(false);
    const payload = buildRoutePayload(doc);
    expect(payload.skip).toBe(false);
    expect(payload.volumes).toHaveLength(1);
  });

  test("one under the threshold (59 chapters): routing is skipped", () => {
    const doc = document([volume({ volume_id: "v", chapters: manyChapters(59) })]);
    expect(shouldSkipRouting(doc)).toBe(true);
  });

  test("an empty corpus (0 chapters) also skips routing", () => {
    expect(shouldSkipRouting(document([]))).toBe(true);
  });

  test("route payload volume rows carry no chapter list and no body text — manifest fields only", () => {
    const doc = document([
      volume({
        volume_id: "ui-design",
        title: "Interface Design",
        when_to_use: "Designing UI",
        not_for: "brand identity",
        keywords: ["linear"],
        chapters: manyChapters(CHAPTER_INDEX_THRESHOLD + 1),
      }),
    ]);
    const payload = buildRoutePayload(doc);
    expect(payload.volumes).toEqual([
      {
        volume_id: "ui-design",
        title: "Interface Design",
        when_to_use: "Designing UI",
        not_for: "brand identity",
        keywords: ["linear"],
        chapter_count: CHAPTER_INDEX_THRESHOLD + 1,
      },
    ]);
    // No `chapters` key at all on a manifest row.
    expect(payload.volumes[0]).not.toHaveProperty("chapters");
  });

  test("carries the task through as `query` (C-3: the agent must be told what it is routing)", () => {
    const doc = document([
      volume({ volume_id: "v", chapters: manyChapters(CHAPTER_INDEX_THRESHOLD + 1) }),
    ]);
    expect(buildRoutePayload(doc, "design a one-pager").query).toBe("design a one-pager");
  });

  test("query defaults to an empty string when omitted", () => {
    const doc = document([volume({ volume_id: "v", chapters: manyChapters(1) })]);
    expect(buildRoutePayload(doc).query).toBe("");
  });
});

describe("buildNavigatePayload", () => {
  test("emits exactly the documented row field set, no body text", () => {
    const c = chapter({
      node_id: "N1",
      title: "Density",
      when_to_use: "Designing dense tables",
      not_for: "marketing pages",
      keywords: ["density"],
      tokens: 1234,
      updated: "2026-08-11",
      confidence: "high",
    });
    const doc = document([volume({ volume_id: "v", chapters: [c] })]);
    const payload = buildNavigatePayload(doc);
    expect(payload.chapters).toEqual([
      {
        node_id: "N1",
        title: "Density",
        when_to_use: "Designing dense tables",
        not_for: "marketing pages",
        keywords: ["density"],
        tokens: 1234,
        updated: "2026-08-11",
        confidence: "high",
        superseded_by: undefined,
      },
    ]);
  });

  test("filters to the routed volume_id(s) when given", () => {
    const doc = document([
      volume({ volume_id: "a", chapters: [chapter({ node_id: "A1" })] }),
      volume({ volume_id: "b", chapters: [chapter({ node_id: "B1" })] }),
    ]);
    const payload = buildNavigatePayload(doc, { volumeIds: ["b"] });
    expect(payload.chapters.map((c) => c.node_id)).toEqual(["B1"]);
  });

  test("visited[] excludes previously-seen chapters from the payload and is echoed back", () => {
    const doc = document([
      volume({
        volume_id: "v",
        chapters: [chapter({ node_id: "N1" }), chapter({ node_id: "N2" })],
      }),
    ]);
    const payload = buildNavigatePayload(doc, { visited: ["N1"], round: 2 });
    expect(payload.chapters.map((c) => c.node_id)).toEqual(["N2"]);
    expect(payload.visited).toEqual(["N1"]);
    expect(payload.round).toBe(2);
  });

  test("derives superseded_by from another chapter's `supersedes` list", () => {
    const old = chapter({ node_id: "OLD" });
    const replacement = chapter({ node_id: "NEW", supersedes: ["OLD"] });
    const doc = document([volume({ volume_id: "v", chapters: [old, replacement] })]);
    const payload = buildNavigatePayload(doc);
    const oldRow = payload.chapters.find((c) => c.node_id === "OLD");
    expect(oldRow?.superseded_by).toBe("NEW");
    const newRow = payload.chapters.find((c) => c.node_id === "NEW");
    expect(newRow?.superseded_by).toBeUndefined();
  });

  test("defaults to round 1 and empty visited when omitted", () => {
    const doc = document([volume({ volume_id: "v", chapters: [chapter({ node_id: "N1" })] })]);
    const payload = buildNavigatePayload(doc);
    expect(payload.round).toBe(1);
    expect(payload.visited).toEqual([]);
  });

  test("carries the task through as `query`, defaulting to an empty string (C-3)", () => {
    const doc = document([volume({ volume_id: "v", chapters: [chapter({ node_id: "N1" })] })]);
    expect(buildNavigatePayload(doc, { query: "design a one-pager" }).query).toBe(
      "design a one-pager",
    );
    expect(buildNavigatePayload(doc).query).toBe("");
  });
});
