import { describe, expect, test } from "bun:test";
import { toChapterSlug, toVolumeSlug } from "@shadow/core";
import { StructuralIndexer } from "@shadow/indexing";
import { createMissLog, widenMisses } from "../miss-log.ts";
import { buildLargeFixture, buildSmallFixture, withStore } from "../test-fixture.ts";
import { runFind } from "./find.ts";

async function readMisses(root: string) {
  return widenMisses(await createMissLog(root).readAll());
}

describe("runFind — small corpus (route stage skipped, D11a)", () => {
  test("round 1 returns the navigate payload directly, no route stage", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store, root);
      const result = await runFind(store, root, "dense table row height", {});

      expect(result.stage).toBe("navigate");
      if (result.stage !== "navigate") throw new Error("unreachable");
      expect(result.round).toBe(1);
      expect(result.visited).toEqual([]);
      expect(result.chapters.length).toBeGreaterThan(0);
      expect(result.next_steps.length).toBeGreaterThan(0);
    });
  });

  test("navigate payload never carries body text", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store, root);
      const result = await runFind(store, root, "dense table row height", {});
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("truncates labels aggressively");
    });
  });

  test("next_steps names a real node_id from the payload", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store, root);
      const result = await runFind(store, root, "dense table row height", {});
      if (result.stage !== "navigate") throw new Error("unreachable");
      const firstId = result.chapters[0]?.node_id;
      expect(result.next_steps.some((s) => firstId && s.includes(firstId))).toBe(true);
    });
  });
});

describe("runFind — round state threading", () => {
  test("visited[] passed in round 2 excludes those node_ids and is echoed back", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store, root);
      const round1 = await runFind(store, root, "dense table row height", {});
      if (round1.stage !== "navigate") throw new Error("unreachable");
      const rejectedId = round1.chapters[0]?.node_id;
      if (!rejectedId) throw new Error("unreachable");

      const round2 = await runFind(store, root, "dense table row height", {
        visited: [rejectedId],
        round: 2,
      });
      if (round2.stage !== "navigate") throw new Error("unreachable");
      expect(round2.round).toBe(2);
      expect(round2.visited).toEqual([rejectedId]);
      expect(round2.chapters.map((c) => c.node_id)).not.toContain(rejectedId);
    });
  });

  test("visiting every chapter exhausts the round automatically -> not-in-corpus verdict", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store, root);
      const document = await new StructuralIndexer({ rootDir: root }).build(store);
      const allIds = document.document.volumes.flatMap((v) => v.chapters.map((c) => c.node_id));

      const result = await runFind(store, root, "dense table row height", {
        visited: allIds,
        round: 2,
      });
      expect(result.stage).toBe("verdict");
      if (result.stage !== "verdict") throw new Error("unreachable");
      expect(result.verdict).toBe("not-in-corpus");
    });
  });

  test("a round number beyond MAX_ROUNDS (3) yields not-in-corpus, never a 4th navigate", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store, root);
      const result = await runFind(store, root, "dense table row height", { round: 4 });
      expect(result.stage).toBe("verdict");
    });
  });
});

describe("runFind — route stage (large corpus, D11's STAGE 2)", () => {
  test("first call over threshold returns a route payload, not chapters", async () => {
    await withStore(async (store, root) => {
      await buildLargeFixture(store, root);
      const result = await runFind(store, root, "topic 2 subtopic 5", {});

      expect(result.stage).toBe("route");
      if (result.stage !== "route") throw new Error("unreachable");
      expect(result.volumes.length).toBeGreaterThan(0);
      expect(result.next_steps.some((s) => s.includes("--volumes"))).toBe(true);
    });
  });

  test("second call with --volumes scopes the navigate payload to those volumes only", async () => {
    await withStore(async (store, root) => {
      await buildLargeFixture(store, root);
      const scoped = await runFind(store, root, "topic 2 subtopic 5", { volumes: ["volume-2"] });

      expect(scoped.stage).toBe("navigate");
      if (scoped.stage !== "navigate") throw new Error("unreachable");
      expect(scoped.chapters.length).toBeGreaterThan(0);
      expect(scoped.chapters.every((c) => c.title.startsWith("Volume 2 "))).toBe(true);
    });
  });
});

describe("runFind — explicit not-in-corpus verdict (acceptance: 'if it exists')", () => {
  test("--none with a query matching nothing at all yields not-in-corpus and logs a miss", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store, root);
      const result = await runFind(store, root, "sourdough bread baking technique", { none: true });

      expect(result.stage).toBe("verdict");
      if (result.stage !== "verdict") throw new Error("unreachable");
      expect(result.verdict).toBe("not-in-corpus");
      expect(result.next_steps.length).toBeGreaterThan(0);

      const misses = await readMisses(root);
      expect(misses).toHaveLength(1);
      expect(misses[0]?.task).toBe("sourdough bread baking technique");
    });
  });

  test("an empty corpus (no volumes) returns not-in-corpus immediately and logs a miss", async () => {
    await withStore(async (store, root) => {
      await new StructuralIndexer({ rootDir: root }).reindex(store); // zero volumes
      const result = await runFind(store, root, "anything at all", {});

      expect(result.stage).toBe("verdict");
      if (result.stage !== "verdict") throw new Error("unreachable");
      expect(result.verdict).toBe("not-in-corpus");
      const misses = await readMisses(root);
      expect(misses).toHaveLength(1);
      expect(misses[0]?.reason).toBe("empty-corpus");
    });
  });
});

describe("runFind — BM25 fallback promotion (D11a)", () => {
  test("--none promotes a BM25 hit whose body matches even though when_to_use didn't", async () => {
    await withStore(async (store, root) => {
      const volume = toVolumeSlug("misc");
      await store.createVolume({ slug: volume, title: "Misc" });
      await store.putChapter(volume, {
        slug: toChapterSlug("glossary"),
        title: "Glossary",
        body: "# Glossary\n\nThe codename Zephyrfrost refers to the internal build pipeline.\n",
        frontmatter: { when_to_use: "Looking up internal terminology and glossary entries." },
      });
      await new StructuralIndexer({ rootDir: root }).reindex(store);

      const result = await runFind(store, root, "what is Zephyrfrost", { none: true });

      expect(result.stage).toBe("promoted");
      if (result.stage !== "promoted") throw new Error("unreachable");
      expect(result.next_steps.some((s) => s.includes(result.node_id))).toBe(true);

      // Promotion is a candidate, not a verdict — no miss should be logged.
      expect(await readMisses(root)).toEqual([]);
    });
  });
});
