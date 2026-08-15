/**
 * Tests for `UnavailableSearchProvider` — the `bedrock` model provider's
 * placeholder `SearchProvider`. See `unavailable-search-provider.ts`
 * and `SearchUnavailableError`'s doc (`errors.ts`) for why this exists.
 */

import { describe, expect, test } from "bun:test";
import { SearchUnavailableError } from "./errors.ts";
import { expectRejection } from "./test-helpers.ts";
import { UnavailableSearchProvider } from "./unavailable-search-provider.ts";

describe("UnavailableSearchProvider", () => {
  test("search() rejects with SearchUnavailableError carrying the query", async () => {
    const provider = new UnavailableSearchProvider();
    const error = await expectRejection(
      provider.search({ query: "how does Linear design its sidebar" }, async () => {
        throw new Error("fetchImpl must not be used by UnavailableSearchProvider");
      }),
      SearchUnavailableError,
    );
    expect(error.query).toBe("how does Linear design its sidebar");
  });

  test("the error message names both remedies: SHADOW_MODEL_PROVIDER=claude-code and configuring a future search provider", async () => {
    const provider = new UnavailableSearchProvider();
    const error = await expectRejection(
      provider.search({ query: "q" }, async () => {
        throw new Error("fetchImpl must not be used by UnavailableSearchProvider");
      }),
      SearchUnavailableError,
    );
    expect(error.message).toContain("SHADOW_MODEL_PROVIDER=claude-code");
    expect(error.message).toContain("bedrock");
    expect(error.message).toContain("configure a search provider");
  });
});
