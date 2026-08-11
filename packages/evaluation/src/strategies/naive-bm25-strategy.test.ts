import { describe, expect, test } from "bun:test";
import { withTinyCorpus } from "../test-helpers.ts";
import { NaiveBm25Strategy } from "./naive-bm25-strategy.ts";
import { ZERO_TOKEN_COST } from "./token-tracking.ts";

describe("NaiveBm25Strategy", () => {
  test("ranks the chapter whose title/body actually matches the query terms first", async () => {
    await withTinyCorpus(async ({ store, document }) => {
      const strategy = new NaiveBm25Strategy(store, document);
      const result = await strategy.retrieve("Linear table row height density");
      expect(result.retrieved[0]).toBe("ui/density");
      expect(result.verdict).toBe("found");
    });
  });

  test("makes zero LLM calls — tokenCost is always ZERO_TOKEN_COST", async () => {
    await withTinyCorpus(async ({ store, document }) => {
      const strategy = new NaiveBm25Strategy(store, document);
      const result = await strategy.retrieve("Linear table row height density");
      expect(result.tokenCost).toEqual(ZERO_TOKEN_COST);
    });
  });

  test("a query matching no terms at all returns not-in-corpus", async () => {
    await withTinyCorpus(async ({ store, document }) => {
      const strategy = new NaiveBm25Strategy(store, document);
      const result = await strategy.retrieve("zzqx wobblefrog blorptastic snorgle");
      expect(result.retrieved).toEqual([]);
      expect(result.verdict).toBe("not-in-corpus");
    });
  });

  test("topK bounds the number of chapters returned", async () => {
    await withTinyCorpus(async ({ store, document }) => {
      const strategy = new NaiveBm25Strategy(store, document, { topK: 1 });
      // "onboarding" and "empty state" appear in both ui chapters' fields (density's not_for
      // mentions onboarding indirectly via title overlap risk) — use a term present in body text
      // of more than one chapter isn't required; just confirm the cap holds even when multiple
      // chapters score above zero.
      const result = await strategy.retrieve("welcome onboarding setup reader page");
      expect(result.retrieved.length).toBeLessThanOrEqual(1);
    });
  });

  test("retrieved ids resolve to ChapterId, not raw node_id", async () => {
    await withTinyCorpus(async ({ store, document }) => {
      const strategy = new NaiveBm25Strategy(store, document);
      const result = await strategy.retrieve("one-pager proposal single decision reader");
      expect(result.retrieved).toContain("writing/one-pagers");
    });
  });
});
