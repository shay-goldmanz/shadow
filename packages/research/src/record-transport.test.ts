import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureMissError } from "./errors.ts";
import { FixtureCorpus } from "./fixture-corpus.ts";
import { LiveTransport } from "./live-transport.ts";
import { RecordTransport } from "./record-transport.ts";
import { ReplayTransport } from "./replay-transport.ts";
import { expectRejection } from "./test-helpers.ts";
import type { FetchLike, FetchResponseLike, HeadersLike } from "./types.ts";

function fakeHeaders(entries: Record<string, string>): HeadersLike {
  const map = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => map.get(name.toLowerCase()) ?? null };
}

async function withTempCorpus(fn: (corpus: FixtureCorpus) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "shadow-research-record-"));
  try {
    await fn(new FixtureCorpus(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("RecordTransport -> ReplayTransport round trip", () => {
  test("what RecordTransport writes, ReplayTransport reads back identically", async () => {
    await withTempCorpus(async (corpus) => {
      const bodyText = "<html><body><p>Recorded via a fake live fetch</p></body></html>";
      const fetchImpl: FetchLike = async (): Promise<FetchResponseLike> => {
        const bytes = new TextEncoder().encode(bodyText);
        return {
          status: 200,
          url: "https://example.com/final",
          headers: fakeHeaders({ "content-type": "text/html" }),
          body: null,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
      };

      const live = new LiveTransport({ fetchImpl });
      const recorder = new RecordTransport(live, corpus);

      const recorded = await recorder.fetchPage({ url: "https://example.com/original" });
      expect(recorded.transport).toBe("live"); // genuinely a live retrieval, just also persisted

      const replay = new ReplayTransport(corpus);
      const replayed = await replay.fetchPage({ url: "https://example.com/original" });

      expect(replayed.requestedUrl).toBe(recorded.requestedUrl);
      expect(replayed.finalUrl).toBe(recorded.finalUrl);
      expect(replayed.httpStatus).toBe(recorded.httpStatus);
      expect(replayed.contentType).toBe(recorded.contentType);
      expect(Array.from(replayed.bytes)).toEqual(Array.from(recorded.bytes));
      expect(new TextDecoder().decode(replayed.bytes)).toBe(bodyText);
      // Only the reported transport kind differs between the two reads.
      expect(replayed.transport).toBe("fixture");
    });
  });

  test("record round-trips a search response too", async () => {
    await withTempCorpus(async (corpus) => {
      const live = new LiveTransport({
        fetchImpl: async () => {
          throw new Error("fetchPage not exercised in this test");
        },
        search: {
          search: async (request) => ({
            query: request.query,
            hits: [{ url: "https://linear.app/blog", title: "Linear blog" }],
            retrievedAt: "2026-08-11T09:14:22.000Z",
            transport: "live",
          }),
        },
      });
      const recorder = new RecordTransport(live, corpus);

      const recorded = await recorder.search({ query: "linear design system", maxResults: 3 });
      const replayed = await new ReplayTransport(corpus).search({
        query: "linear design system",
        maxResults: 3,
      });

      expect(replayed.hits).toEqual(recorded.hits);
      expect(replayed.transport).toBe("fixture");
    });
  });

  test("a URL that was never recorded still fails loudly on replay after other URLs were recorded", async () => {
    await withTempCorpus(async (corpus) => {
      const fetchImpl: FetchLike = async (): Promise<FetchResponseLike> => {
        const bytes = new TextEncoder().encode("<p>x</p>");
        return {
          status: 200,
          url: "https://example.com/recorded",
          headers: fakeHeaders({ "content-type": "text/html" }),
          body: null,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
      };
      const recorder = new RecordTransport(new LiveTransport({ fetchImpl }), corpus);
      await recorder.fetchPage({ url: "https://example.com/recorded" });

      const replay = new ReplayTransport(corpus);
      await expectRejection(
        replay.fetchPage({ url: "https://example.com/never-recorded" }),
        FixtureMissError,
      );
    });
  });
});
