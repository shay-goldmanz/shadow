import { describe, expect, test } from "bun:test";
import { withTinyCorpus } from "../test-helpers.ts";
import {
  buildNodeToChapterMap,
  chapterId,
  listChapterIds,
  resolveChapterId,
} from "./chapter-id.ts";

describe("chapterId", () => {
  test("joins volume and chapter slugs with a slash", () => {
    expect(chapterId("ui", "density")).toBe("ui/density");
  });
});

describe("buildNodeToChapterMap / resolveChapterId", () => {
  test("resolves a chapter's own node_id directly", async () => {
    await withTinyCorpus(async ({ document }) => {
      const density = document.volumes[0]?.chapters.find((c) => c.slug === "density");
      if (!density) throw new Error("unreachable");
      const map = buildNodeToChapterMap(document);
      expect(resolveChapterId(map, density.node_id)).toBe("ui/density");
    });
  });

  test("resolves a section's node_id to its owning chapter via the '#' prefix rule", async () => {
    await withTinyCorpus(async ({ document }) => {
      const density = document.volumes[0]?.chapters.find((c) => c.slug === "density");
      if (!density) throw new Error("unreachable");
      const map = buildNodeToChapterMap(document);
      const sectionNodeId = `${density.node_id}#some-heading`;
      expect(resolveChapterId(map, sectionNodeId)).toBe("ui/density");
    });
  });

  test("returns undefined for a node_id from no known chapter", async () => {
    await withTinyCorpus(async ({ document }) => {
      const map = buildNodeToChapterMap(document);
      expect(resolveChapterId(map, "01JUNKNOWNULID00000000000")).toBeUndefined();
      expect(resolveChapterId(map, "01JUNKNOWNULID00000000000#section")).toBeUndefined();
    });
  });
});

describe("listChapterIds", () => {
  test("lists every chapter across every volume, in document order", async () => {
    await withTinyCorpus(async ({ document }) => {
      const ids = listChapterIds(document);
      expect(ids).toEqual(["ui/density", "ui/onboarding", "writing/one-pagers"]);
    });
  });
});
