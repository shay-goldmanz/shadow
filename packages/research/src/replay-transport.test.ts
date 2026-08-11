import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureMissError } from "./errors.ts";
import { FixtureCorpus } from "./fixture-corpus.ts";
import { ReplayTransport } from "./replay-transport.ts";
import { expectRejection } from "./test-helpers.ts";
import type { FetchedPage, SearchResponse } from "./types.ts";

async function withTempCorpus(fn: (corpus: FixtureCorpus) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "shadow-research-replay-"));
  try {
    await fn(new FixtureCorpus(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("ReplayTransport", () => {
  test("a fetch hit returns exactly the recorded payload", async () => {
    await withTempCorpus(async (corpus) => {
      const recorded: FetchedPage = {
        requestedUrl: "https://example.com/article",
        finalUrl: "https://example.com/article",
        httpStatus: 200,
        contentType: "text/html",
        headers: { "content-type": "text/html" },
        bytes: new TextEncoder().encode("<p>Recorded body</p>"),
        retrievedAt: "2026-08-11T09:14:22.000Z",
        transport: "live",
      };
      await corpus.writePage(recorded);

      const transport = new ReplayTransport(corpus);
      const page = await transport.fetchPage({ url: "https://example.com/article" });

      expect(new TextDecoder().decode(page.bytes)).toBe("<p>Recorded body</p>");
      expect(page.finalUrl).toBe(recorded.finalUrl);
      expect(page.httpStatus).toBe(200);
      expect(page.transport).toBe("fixture");
    });
  });

  test("a fetch miss fails loudly with FixtureMissError and does not fall through to live", async () => {
    await withTempCorpus(async (corpus) => {
      const transport = new ReplayTransport(corpus);
      const error = await expectRejection(
        transport.fetchPage({ url: "https://example.com/never-recorded" }),
        FixtureMissError,
      );
      expect(error.kind).toBe("page");
      expect(error.key).toBe("https://example.com/never-recorded");
    });
  });

  test("a search hit returns the recorded hits", async () => {
    await withTempCorpus(async (corpus) => {
      const recorded: SearchResponse = {
        query: "how linear designs its UI",
        hits: [{ url: "https://linear.app/blog", title: "Linear blog" }],
        retrievedAt: "2026-08-11T09:14:22.000Z",
        transport: "live",
      };
      await corpus.writeSearch(recorded, 5);

      const transport = new ReplayTransport(corpus);
      const response = await transport.search({
        query: "how linear designs its UI",
        maxResults: 5,
      });
      expect(response.hits).toEqual(recorded.hits);
      expect(response.transport).toBe("fixture");
    });
  });

  test("a search miss fails loudly with FixtureMissError", async () => {
    await withTempCorpus(async (corpus) => {
      const transport = new ReplayTransport(corpus);
      const error = await expectRejection(
        transport.search({ query: "never recorded" }),
        FixtureMissError,
      );
      expect(error.kind).toBe("search");
    });
  });

  test("ReplayTransport never imports fetch or LiveTransport — structurally incapable of reaching the network", async () => {
    // Not a network test — a source-level guardrail. Strip comments first
    // so the doc comment's own prose (which talks *about* fetch) can't
    // produce a false positive; only the executable code is checked.
    const raw = await Bun.file(new URL("./replay-transport.ts", import.meta.url)).text();
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toContain("LiveTransport");
    expect(code).not.toContain("globalThis.fetch");
  });
});
