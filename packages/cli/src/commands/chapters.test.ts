import { describe, expect, test } from "bun:test";
import { VolumeNotFoundError } from "@shadow/core";
import { VolumeLookupError } from "../errors.ts";
import { buildSmallFixture, withStore } from "../test-fixture.ts";
import { runChapters } from "./chapters.ts";

describe("runChapters", () => {
  test("lists a volume's chapter rows in natural order when unranked", async () => {
    await withStore(async (store) => {
      await buildSmallFixture(store);
      const result = await runChapters(store, "ui-design", {});

      expect(result.volume_id).toBe("ui-design");
      expect(result.chapters).toHaveLength(2);
      const titles = result.chapters.map((c) => c.title);
      expect(titles).toContain("How Linear handles information density");
      expect(titles).toContain("Notion's near-zero chrome");
      // Every row is addressable by node_id but carries no body text.
      for (const row of result.chapters) {
        expect(typeof row.node_id).toBe("string");
        expect(Object.keys(row)).not.toContain("body");
      }
    });
  });

  test("--rank orders chapters by BM25 relevance to the given task", async () => {
    await withStore(async (store) => {
      await buildSmallFixture(store);
      const result = await runChapters(store, "ui-design", { rank: "dense table row height" });

      expect(result.chapters[0]?.title).toBe("How Linear handles information density");
      expect(result.chapters[0]?.score).toBeGreaterThan(result.chapters[1]?.score ?? Infinity);
    });
  });

  test("unranked rows carry no score field", async () => {
    await withStore(async (store) => {
      await buildSmallFixture(store);
      const result = await runChapters(store, "ui-design", {});
      for (const row of result.chapters) {
        expect(row.score).toBeUndefined();
      }
    });
  });

  test("next_steps points at `shadow read` with a real node_id", async () => {
    await withStore(async (store) => {
      await buildSmallFixture(store);
      const result = await runChapters(store, "ui-design", {});
      const firstId = result.chapters[0]?.node_id;
      expect(result.next_steps.some((s) => firstId && s.includes(firstId))).toBe(true);
    });
  });

  test("throws VolumeLookupError (with next_steps) for an unknown volume_id", async () => {
    await withStore(async (store) => {
      await buildSmallFixture(store);
      const error = await runChapters(store, "does-not-exist", {}).catch((e) => e);
      expect(error).toBeInstanceOf(VolumeLookupError);
      expect(error.nextSteps.length).toBeGreaterThan(0);
      expect(error.cause).toBeInstanceOf(VolumeNotFoundError);
    });
  });
});
