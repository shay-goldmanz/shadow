import { describe, expect, test } from "bun:test";
import { buildSmallFixture, withStore } from "../test-fixture.ts";
import { runVolumes } from "./volumes.ts";

describe("runVolumes", () => {
  test("lists every volume's manifest row, cheapest-first shape (no chapters, no body)", async () => {
    await withStore(async (store) => {
      await buildSmallFixture(store);
      const result = await runVolumes(store);

      expect(result.volumes).toHaveLength(2);
      const ids = result.volumes.map((v) => v.volume_id).toSorted();
      expect(ids).toEqual(["ui-design", "writing"]);

      const uiDesign = result.volumes.find((v) => v.volume_id === "ui-design");
      expect(uiDesign?.title).toBe("Interface Design");
      expect(uiDesign?.chapter_count).toBe(2);
      expect(uiDesign?.when_to_use).toContain("Designing UI");
    });
  });

  test("never carries a per-chapter list or body text — only the routing manifest", async () => {
    await withStore(async (store) => {
      await buildSmallFixture(store);
      const result = await runVolumes(store);

      for (const row of result.volumes) {
        expect(Object.keys(row)).not.toContain("chapters");
      }
      // The actual chapter body prose should never appear in a structure payload.
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("truncates labels aggressively");
    });
  });

  test("next_steps is present and non-empty when volumes exist", async () => {
    await withStore(async (store) => {
      await buildSmallFixture(store);
      const result = await runVolumes(store);
      expect(result.next_steps.length).toBeGreaterThan(0);
      expect(result.next_steps.some((s) => s.includes("shadow chapters"))).toBe(true);
    });
  });

  test("returns [] with steering next_steps when the corpus has no volumes yet", async () => {
    await withStore(async (store) => {
      // Build an empty corpus index (no volumes at all).
      const { StructuralIndexer } = await import("@shadow/indexing");
      await new StructuralIndexer().reindex(store);

      const result = await runVolumes(store);
      expect(result.volumes).toEqual([]);
      expect(result.next_steps.length).toBeGreaterThan(0);
    });
  });
});
