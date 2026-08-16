import { describe, expect, test } from "bun:test";
import { buildSmallFixture, withStore } from "../test-fixture.ts";
import { runGrep } from "./grep.ts";

describe("runGrep", () => {
  test("ranks hits across the whole corpus by BM25, no body text in the payload", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store, root);
      const result = await runGrep(store, "pull quote editorial");

      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.hits[0]?.title).toBe("How Epoch designs a one-pager");
      for (const hit of result.hits) {
        expect(Object.keys(hit)).not.toContain("body");
        expect(Object.keys(hit)).not.toContain("text");
      }
    });
  });

  test("hits are sorted descending by score", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store, root);
      const result = await runGrep(store, "density row height table");
      for (let i = 1; i < result.hits.length; i += 1) {
        expect(result.hits[i - 1]?.score).toBeGreaterThanOrEqual(
          result.hits[i]?.score ?? -Infinity,
        );
      }
    });
  });

  test("an unrelated query still returns a result shape (possibly zero hits), never throws", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store, root);
      const result = await runGrep(store, "zzqx wobblefrog blorptastic");
      expect(Array.isArray(result.hits)).toBe(true);
      expect(result.next_steps.length).toBeGreaterThan(0);
    });
  });

  test("next_steps names `shadow read` on the top hit when there is one", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store, root);
      const result = await runGrep(store, "pull quote editorial");
      const topId = result.hits[0]?.node_id;
      expect(result.next_steps.some((s) => topId && s.includes(topId))).toBe(true);
    });
  });
});
