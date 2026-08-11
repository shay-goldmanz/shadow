/**
 * A smoke test of the *public* surface only — everything imported here
 * comes from "./index.ts", not from internal modules (mirrors the pattern
 * in `@shadow/core`'s `index.test.ts`). Exhaustive behavior is covered by
 * the per-module test files; this just proves record -> replay composes
 * end to end through the exported API the way T2.1b would use it.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeSnapshotDigests,
  createRetrievalTransport,
  type FetchLike,
  type FetchResponseLike,
  FixtureMissError,
  type HeadersLike,
} from "./index.ts";
import { expectRejection } from "./test-helpers.ts";

function fakeHeaders(entries: Record<string, string>): HeadersLike {
  const map = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => map.get(name.toLowerCase()) ?? null };
}

describe("@shadow/research public surface", () => {
  test("record a page through the public factory, then replay it, then compute its snapshot digests", async () => {
    const root = await mkdtemp(join(tmpdir(), "shadow-research-index-test-"));
    try {
      const html = `<html><head><title>T</title></head><body><nav>Home</nav><main><p>Public surface works.</p></main></body></html>`;
      const fetchImpl: FetchLike = async (): Promise<FetchResponseLike> => {
        const bytes = new TextEncoder().encode(html);
        return {
          status: 200,
          url: "https://example.com/page",
          headers: fakeHeaders({ "content-type": "text/html" }),
          body: null,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
      };

      const recorder = createRetrievalTransport({
        mode: "record",
        fixturesRoot: root,
        live: { fetchImpl },
      });
      const recorded = await recorder.fetchPage({ url: "https://example.com/page" });
      expect(recorded.transport).toBe("live");

      const replayer = createRetrievalTransport({ mode: "replay", fixturesRoot: root });
      const replayed = await replayer.fetchPage({ url: "https://example.com/page" });
      expect(replayed.transport).toBe("fixture");
      expect(new TextDecoder().decode(replayed.bytes)).toBe(html);

      // A URL that was never recorded fails loudly rather than reaching the network.
      await expectRejection(
        replayer.fetchPage({ url: "https://example.com/other" }),
        FixtureMissError,
      );

      const digests = computeSnapshotDigests(replayed.bytes, html);
      expect(digests.normalization).toBe("nfc-ws-v1");
      expect(digests.normalizedText).toContain("Public surface works.");
      expect(digests.normalizedText).not.toContain("Home");
      expect(digests.payloadSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(digests.normalizedTextSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
