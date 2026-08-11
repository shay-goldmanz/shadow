/**
 * Tests for `AgenticSearchProvider` — the subscription-backed live search
 * backend for `LiveTransport.search()`. Offline and deterministic
 * throughout: every session is `@shadow/model`'s `FakeAgenticSessionPort`,
 * never a real subprocess. See `live-smoke.test.ts` for the one live smoke
 * check, gated behind `SHADOW_LIVE_TEST=1` and run manually per its own doc.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgenticSessionPort } from "@shadow/model";
import {
  AgenticSearchProvider,
  DEFAULT_SEARCH_MAX_RESULTS,
  parseSearchResults,
} from "./agentic-search-provider.ts";
import {
  FixtureMissError,
  SearchResultParseError,
  SearchSessionTurnFailedError,
} from "./errors.ts";
import { FixtureCorpus } from "./fixture-corpus.ts";
import { LiveTransport } from "./live-transport.ts";
import { RecordTransport } from "./record-transport.ts";
import { ReplayTransport } from "./replay-transport.ts";
import { expectRejection } from "./test-helpers.ts";

const VALID_RESULTS_JSON = JSON.stringify({
  results: [
    {
      title: "Linear — Design system",
      url: "https://linear.app/blog/design-system",
      snippet: "How Linear builds a consistent design system.",
    },
    { title: "Linear — Method", url: "https://linear.app/method" },
  ],
});

describe("AgenticSearchProvider — happy path", () => {
  test("a search returns parsed results with title/url/snippet", async () => {
    const sessions = new FakeAgenticSessionPort(() => ({ text: VALID_RESULTS_JSON }));
    const provider = new AgenticSearchProvider({ sessions });

    const response = await provider.search(
      { query: "how does Linear design its UI", maxResults: 5 },
      async () => {
        throw new Error("fetchImpl must not be used by AgenticSearchProvider");
      },
    );

    expect(response.query).toBe("how does Linear design its UI");
    expect(response.transport).toBe("live");
    expect(response.hits).toHaveLength(2);
    expect(response.hits[0]).toEqual({
      title: "Linear — Design system",
      url: "https://linear.app/blog/design-system",
      snippet: "How Linear builds a consistent design system.",
    });
    // Second hit had no snippet in the model output — omitted, not `undefined`-filled.
    expect(response.hits[1]).toEqual({
      title: "Linear — Method",
      url: "https://linear.app/method",
    });
    expect(response.hits[1]).not.toHaveProperty("snippet");
  });

  test("a code-fenced JSON reply is tolerated", async () => {
    const sessions = new FakeAgenticSessionPort(() => ({
      text: `\`\`\`json\n${VALID_RESULTS_JSON}\n\`\`\``,
    }));
    const provider = new AgenticSearchProvider({ sessions });

    const response = await provider.search({ query: "linear" }, async () => {
      throw new Error("unused");
    });
    expect(response.hits).toHaveLength(2);
  });

  test("maxResults caps the returned hits even if the model over-reports", async () => {
    const sessions = new FakeAgenticSessionPort(() => ({ text: VALID_RESULTS_JSON }));
    const provider = new AgenticSearchProvider({ sessions });

    const response = await provider.search({ query: "linear", maxResults: 1 }, async () => {
      throw new Error("unused");
    });
    expect(response.hits).toHaveLength(1);
  });

  test("a genuine empty result set parses cleanly as zero hits, not an error", async () => {
    const sessions = new FakeAgenticSessionPort(() => ({ text: '{"results":[]}' }));
    const provider = new AgenticSearchProvider({ sessions });

    const response = await provider.search({ query: "something obscure" }, async () => {
      throw new Error("unused");
    });
    expect(response.hits).toEqual([]);
  });
});

describe("AgenticSearchProvider — malformed output fails loudly", () => {
  test("prose instead of JSON throws SearchResultParseError, never an empty result set", async () => {
    const sessions = new FakeAgenticSessionPort(() => ({
      text: "I searched and found a few relevant pages about Linear's design system.",
    }));
    const provider = new AgenticSearchProvider({ sessions });

    const error = await expectRejection(
      provider.search({ query: "linear design" }, async () => {
        throw new Error("unused");
      }),
      SearchResultParseError,
    );
    expect(error.query).toBe("linear design");
    expect(error.rawText).toContain("I searched and found");
  });

  test("valid JSON in the wrong shape throws SearchResultParseError", async () => {
    const sessions = new FakeAgenticSessionPort(() => ({
      text: JSON.stringify({ hits: [{ link: "https://example.com" }] }),
    }));
    const provider = new AgenticSearchProvider({ sessions });

    await expectRejection(
      provider.search({ query: "x" }, async () => {
        throw new Error("unused");
      }),
      SearchResultParseError,
    );
  });

  test("an isError turn throws SearchSessionTurnFailedError, not a parse error", async () => {
    const sessions = new FakeAgenticSessionPort(() => ({
      isError: true,
      stopReason: "error",
      text: "subprocess crashed",
    }));
    const provider = new AgenticSearchProvider({ sessions });

    await expectRejection(
      provider.search({ query: "x" }, async () => {
        throw new Error("unused");
      }),
      SearchSessionTurnFailedError,
    );
  });

  test("parseSearchResults is exported and independently strict", () => {
    expect(() => parseSearchResults("q", "not json at all", undefined)).toThrow(
      SearchResultParseError,
    );
    expect(() => parseSearchResults("q", '{"results": "not an array"}', undefined)).toThrow(
      SearchResultParseError,
    );
    expect(parseSearchResults("q", '{"results":[]}', undefined)).toEqual([]);
  });
});

describe("AgenticSearchProvider — session reuse (D6)", () => {
  test("one session serves every search() call on the same instance, not one per call", async () => {
    let turnCount = 0;
    const sessions = new FakeAgenticSessionPort(() => {
      turnCount += 1;
      return { text: VALID_RESULTS_JSON };
    });
    const provider = new AgenticSearchProvider({ sessions });

    await provider.search({ query: "first" }, async () => {
      throw new Error("unused");
    });
    await provider.search({ query: "second" }, async () => {
      throw new Error("unused");
    });
    await provider.search({ query: "third" }, async () => {
      throw new Error("unused");
    });

    expect(turnCount).toBe(3);
    expect(sessions.sessions).toHaveLength(1);
    expect(sessions.sessions[0]?.prompts).toHaveLength(3);
    expect(provider.sessionId).toBe(sessions.sessions[0]?.sessionId);
  });
});

describe("AgenticSearchProvider — structural tool-allowlist hardening", () => {
  test("allowedTools names exactly WebSearch; disallowedTools names WebFetch/Bash/Read/Write; settingSources is empty", async () => {
    const sessions = new FakeAgenticSessionPort(() => ({ text: VALID_RESULTS_JSON }));
    const provider = new AgenticSearchProvider({ sessions });

    await provider.search({ query: "x" }, async () => {
      throw new Error("unused");
    });

    const options = sessions.sessions[0]?.options;
    expect(options?.allowedTools).toEqual(["WebSearch"]);
    expect(options?.disallowedTools).toContain("WebFetch");
    expect(options?.disallowedTools).toContain("Bash");
    expect(options?.disallowedTools).toContain("Read");
    expect(options?.disallowedTools).toContain("Write");
    // WebSearch must never be in disallowedTools — that would contradict allowedTools.
    expect(options?.disallowedTools).not.toContain("WebSearch");
    expect(options?.settingSources).toEqual([]);
    expect(options?.persistSession).not.toBe(false);
  });
});

async function withTempCorpus(fn: (corpus: FixtureCorpus) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "shadow-research-search-provider-"));
  try {
    await fn(new FixtureCorpus(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("AgenticSearchProvider — record/replay round-trip", () => {
  test("a search recorded through AgenticSearchProvider replays offline identically", async () => {
    await withTempCorpus(async (corpus) => {
      const sessions = new FakeAgenticSessionPort(() => ({ text: VALID_RESULTS_JSON }));
      const provider = new AgenticSearchProvider({ sessions });
      const live = new LiveTransport({
        search: provider,
        fetchImpl: async () => {
          throw new Error("fetchPage not exercised in this test");
        },
      });
      const recorder = new RecordTransport(live, corpus);

      const recorded = await recorder.search({ query: "linear design system", maxResults: 5 });
      expect(recorded.transport).toBe("live"); // genuinely live, just also persisted

      const replay = new ReplayTransport(corpus);
      const replayed = await replay.search({ query: "linear design system", maxResults: 5 });

      expect(replayed.hits).toEqual(recorded.hits);
      expect(replayed.query).toBe(recorded.query);
      expect(replayed.transport).toBe("fixture");
      // The replayed call never touched the session at all.
      expect(sessions.sessions[0]?.prompts).toHaveLength(1);
    });
  });

  test("a query that was never recorded still fails loudly on replay", async () => {
    await withTempCorpus(async (corpus) => {
      const sessions = new FakeAgenticSessionPort(() => ({ text: VALID_RESULTS_JSON }));
      const provider = new AgenticSearchProvider({ sessions });
      const live = new LiveTransport({
        search: provider,
        fetchImpl: async () => {
          throw new Error("unused");
        },
      });
      const recorder = new RecordTransport(live, corpus);
      await recorder.search({ query: "recorded query" });

      const replay = new ReplayTransport(corpus);
      const error = await expectRejection(
        replay.search({ query: "never recorded query" }),
        FixtureMissError,
      );
      expect(error.kind).toBe("search");
    });
  });
});

test("DEFAULT_SEARCH_MAX_RESULTS is a sane positive default", () => {
  expect(DEFAULT_SEARCH_MAX_RESULTS).toBeGreaterThan(0);
});
