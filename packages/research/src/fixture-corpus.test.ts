import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureCorpusError } from "./errors.ts";
import { FixtureCorpus } from "./fixture-corpus.ts";
import { sha256Hex } from "./hashing.ts";
import { expectRejection } from "./test-helpers.ts";
import type { FetchedPage, SearchResponse } from "./types.ts";

async function withTempCorpus(fn: (corpus: FixtureCorpus, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "shadow-research-fixtures-"));
  try {
    await fn(new FixtureCorpus(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function page(overrides: Partial<FetchedPage> = {}): FetchedPage {
  return {
    requestedUrl: "https://example.com/article",
    finalUrl: "https://example.com/article",
    httpStatus: 200,
    contentType: "text/html; charset=utf-8",
    headers: { "content-type": "text/html; charset=utf-8" },
    bytes: new TextEncoder().encode("<p>Hello fixture corpus</p>"),
    retrievedAt: "2026-08-11T09:14:22.000Z",
    transport: "live",
    ...overrides,
  };
}

describe("FixtureCorpus: pages", () => {
  test("reading a page that was never written returns undefined (not an error)", async () => {
    await withTempCorpus(async (corpus) => {
      expect(await corpus.readPage("https://example.com/nope")).toBeUndefined();
    });
  });

  test("round-trips a written page byte-for-byte", async () => {
    await withTempCorpus(async (corpus) => {
      const written = page();
      await corpus.writePage(written);
      const read = await corpus.readPage(written.requestedUrl);
      expect(read).toBeDefined();
      expect(read?.requestedUrl).toBe(written.requestedUrl);
      expect(read?.finalUrl).toBe(written.finalUrl);
      expect(read?.httpStatus).toBe(written.httpStatus);
      expect(read?.contentType).toBe(written.contentType);
      expect(read?.headers).toEqual(written.headers);
      expect(read?.retrievedAt).toBe(written.retrievedAt);
      expect(Array.from(read?.bytes ?? [])).toEqual(Array.from(written.bytes));
      // Replay always reports transport "fixture", regardless of how it was recorded.
      expect(read?.transport).toBe("fixture");
    });
  });

  test("content-addresses the payload: two different URLs with identical bytes share one payload file", async () => {
    await withTempCorpus(async (corpus, root) => {
      const bytes = new TextEncoder().encode("<p>same bytes</p>");
      await corpus.writePage(page({ requestedUrl: "https://example.com/a", bytes }));
      await corpus.writePage(page({ requestedUrl: "https://example.com/b", bytes }));

      const payloadHex = sha256Hex(bytes);
      const payloadFiles = new Bun.Glob("payloads/*").scanSync({ cwd: root });
      const names = Array.from(payloadFiles);
      expect(names).toEqual([`payloads/${payloadHex}`]);

      const a = await corpus.readPage("https://example.com/a");
      const b = await corpus.readPage("https://example.com/b");
      expect(Array.from(a?.bytes ?? [])).toEqual(Array.from(b?.bytes ?? []));
    });
  });

  test("writing the same page twice is idempotent", async () => {
    await withTempCorpus(async (corpus) => {
      const written = page();
      await corpus.writePage(written);
      await corpus.writePage(written);
      const read = await corpus.readPage(written.requestedUrl);
      expect(Array.from(read?.bytes ?? [])).toEqual(Array.from(written.bytes));
    });
  });

  test("a page fixture whose payload file is missing throws FixtureCorpusError, not a silent miss", async () => {
    await withTempCorpus(async (corpus, root) => {
      await corpus.writePage(page());
      // Corrupt the corpus: delete every payload file.
      const payloadFiles = Array.from(new Bun.Glob("payloads/*").scanSync({ cwd: root }));
      for (const rel of payloadFiles) {
        await rm(join(root, rel));
      }
      await expectRejection(corpus.readPage("https://example.com/article"), FixtureCorpusError);
    });
  });

  test("an unparsable page fixture file throws FixtureCorpusError", async () => {
    await withTempCorpus(async (corpus, root) => {
      const key = sha256Hex("https://example.com/broken");
      await Bun.write(join(root, "pages", `${key}.json`), "{ not valid json");
      await expectRejection(corpus.readPage("https://example.com/broken"), FixtureCorpusError);
    });
  });
});

function search(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    query: "how linear designs its UI",
    hits: [{ url: "https://linear.app/blog", title: "Linear blog" }],
    retrievedAt: "2026-08-11T09:14:22.000Z",
    transport: "live",
    ...overrides,
  };
}

describe("FixtureCorpus: searches", () => {
  test("reading a search that was never written returns undefined", async () => {
    await withTempCorpus(async (corpus) => {
      expect(await corpus.readSearch("nothing recorded")).toBeUndefined();
    });
  });

  test("round-trips a written search response", async () => {
    await withTempCorpus(async (corpus) => {
      const written = search();
      await corpus.writeSearch(written, 5);
      const read = await corpus.readSearch(written.query, 5);
      expect(read).toBeDefined();
      expect(read?.query).toBe(written.query);
      expect(read?.hits).toEqual(written.hits);
      expect(read?.transport).toBe("fixture");
    });
  });

  test("maxResults is part of the lookup key: same query, different maxResults, distinct fixtures", async () => {
    await withTempCorpus(async (corpus) => {
      await corpus.writeSearch(search({ hits: [{ url: "https://a.example", title: "A" }] }), 3);
      await corpus.writeSearch(search({ hits: [{ url: "https://b.example", title: "B" }] }), 10);

      const withThree = await corpus.readSearch(search().query, 3);
      const withTen = await corpus.readSearch(search().query, 10);
      expect(withThree?.hits[0]?.url).toBe("https://a.example");
      expect(withTen?.hits[0]?.url).toBe("https://b.example");
    });
  });
});
