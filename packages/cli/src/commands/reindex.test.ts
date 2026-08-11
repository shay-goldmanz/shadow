import { describe, expect, test } from "bun:test";
import { StructuralIndexer } from "@shadow/indexing";
import { StaleIndexError } from "../errors.ts";
import { buildSmallFixture, withStore } from "../test-fixture.ts";
import { runIndexCommand } from "./reindex.ts";

describe("runIndexCommand", () => {
  test("without --check: builds and persists the corpus index, reporting stats", async () => {
    await withStore(async (store) => {
      await buildSmallFixture(store); // already reindexed once by the fixture
      const result = await runIndexCommand(store, { check: false });
      if (result.up_to_date) throw new Error("unreachable: check was false");

      expect(result.stats.volumes).toBe(2);
      expect(result.stats.chapters).toBe(3);
      expect(typeof result.corpus_hash).toBe("string");
      expect(result.next_steps.some((s) => s.includes("shadow find"))).toBe(true);
    });
  });

  test("mints missing chapter ids as a side effect (D13), reported in minted_ids", async () => {
    await withStore(async (store) => {
      const { toChapterSlug, toVolumeSlug } = await import("@shadow/core");
      const slug = toVolumeSlug("v");
      await store.createVolume({ slug, title: "V" });
      await store.putChapter(slug, { slug: toChapterSlug("c"), title: "C", body: "body" });

      const result = await runIndexCommand(store, { check: false });
      if (result.up_to_date) throw new Error("unreachable: check was false");
      expect(result.minted_ids).toHaveLength(1);
      expect(result.minted_ids[0]?.chapterSlug).toBe("c");
    });
  });

  test("--check succeeds silently when the persisted index matches a fresh build", async () => {
    await withStore(async (store) => {
      await buildSmallFixture(store);
      const result = await runIndexCommand(store, { check: true });
      expect(result.up_to_date).toBe(true);
      expect(result.next_steps.length).toBeGreaterThan(0);
    });
  });

  test("--check throws StaleIndexError when a chapter changed after the last build", async () => {
    await withStore(async (store) => {
      await buildSmallFixture(store);
      const { toChapterSlug, toVolumeSlug } = await import("@shadow/core");
      // Mutate a chapter body without reindexing.
      await store.putChapter(toVolumeSlug("ui-design"), {
        slug: toChapterSlug("linear-density"),
        title: "How Linear handles information density",
        body: "Completely different body text now.\n",
        frontmatter: (
          await store.getChapter(toVolumeSlug("ui-design"), toChapterSlug("linear-density"))
        ).frontmatter,
      });

      const error = await runIndexCommand(store, { check: true }).catch((e) => e);
      expect(error).toBeInstanceOf(StaleIndexError);
      expect(error.nextSteps.length).toBeGreaterThan(0);
    });
  });

  test("--check throws StaleIndexError when no index has ever been persisted", async () => {
    await withStore(async (store) => {
      const { toVolumeSlug } = await import("@shadow/core");
      await store.createVolume({ slug: toVolumeSlug("v"), title: "V" });
      const error = await runIndexCommand(store, { check: true }).catch((e) => e);
      expect(error).toBeInstanceOf(StaleIndexError);
    });
  });

  test("sanity: a corpus reindexed twice in a row is always up to date", async () => {
    await withStore(async (store) => {
      await buildSmallFixture(store);
      await new StructuralIndexer().reindex(store);
      const result = await runIndexCommand(store, { check: true });
      expect(result.up_to_date).toBe(true);
    });
  });
});
