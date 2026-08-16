import { describe, expect, test } from "bun:test";
import { NodeNotFoundError } from "@shadow/indexing";
import { NodeLookupError } from "../errors.ts";
import { loadCorpusIndex } from "../loaders.ts";
import { buildSmallFixture, withStore } from "../test-fixture.ts";
import { runRead } from "./read.ts";

describe("runRead", () => {
  test("returns body, heading path, and content_hash for a chapter node_id", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store, root);
      const document = await loadCorpusIndex(store);
      const chapter = document.volumes[0]?.chapters.find((c) => c.slug === "linear-density");
      if (!chapter) throw new Error("unreachable");

      const result = await runRead(store, chapter.node_id, { withParents: false });

      expect(result.body).toContain("Linear renders table rows");
      expect(result.heading_path).toEqual(chapter.path);
      expect(result.content_hash).toBe(chapter.content_hash);
      expect(result.parent_when_to_use).toBeUndefined();
      expect(result.sibling_titles).toBeUndefined();
    });
  });

  test("--with-parents adds parent when_to_use and sibling titles", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store, root);
      const document = await loadCorpusIndex(store);
      const chapter = document.volumes[0]?.chapters.find((c) => c.slug === "linear-density");
      if (!chapter) throw new Error("unreachable");

      const result = await runRead(store, chapter.node_id, { withParents: true });

      expect(result.parent_when_to_use).toContain("Designing UI");
      expect(result.sibling_titles).toContain("Notion's near-zero chrome");
    });
  });

  test("next_steps cites the node_id and content_hash for the caller to quote", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store, root);
      const document = await loadCorpusIndex(store);
      const chapter = document.volumes[0]?.chapters[0];
      if (!chapter) throw new Error("unreachable");

      const result = await runRead(store, chapter.node_id, { withParents: false });
      expect(result.next_steps.some((s) => s.includes(chapter.node_id))).toBe(true);
      expect(result.next_steps.some((s) => s.includes(chapter.content_hash))).toBe(true);
    });
  });

  test("a bad node_id throws NodeLookupError with next_steps, wrapping NodeNotFoundError", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store, root);
      const error = await runRead(store, "not-a-real-node-id", { withParents: false }).catch(
        (e) => e,
      );

      expect(error).toBeInstanceOf(NodeLookupError);
      expect(error.nextSteps.length).toBeGreaterThan(0);
      expect(error.cause).toBeInstanceOf(NodeNotFoundError);
    });
  });
});
