import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRetrievalTransport } from "./create-retrieval-transport.ts";
import { FixtureMissError } from "./errors.ts";
import { LiveTransport } from "./live-transport.ts";
import { RecordTransport } from "./record-transport.ts";
import { ReplayTransport } from "./replay-transport.ts";
import { expectRejection } from "./test-helpers.ts";

describe("createRetrievalTransport", () => {
  test('mode "live" constructs a LiveTransport', () => {
    const transport = createRetrievalTransport({ mode: "live" });
    expect(transport).toBeInstanceOf(LiveTransport);
  });

  test('mode "replay" constructs a ReplayTransport that never touches the network', async () => {
    const root = await mkdtemp(join(tmpdir(), "shadow-research-factory-"));
    try {
      const transport = createRetrievalTransport({ mode: "replay", fixturesRoot: root });
      expect(transport).toBeInstanceOf(ReplayTransport);
      // Proves it: on an empty corpus, a fetch attempt fails loudly rather
      // than silently reaching out to the real network.
      await expectRejection(
        transport.fetchPage({ url: "https://example.com/x" }),
        FixtureMissError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('mode "record" constructs a RecordTransport wrapping a live transport', async () => {
    const root = await mkdtemp(join(tmpdir(), "shadow-research-factory-"));
    try {
      const transport = createRetrievalTransport({ mode: "record", fixturesRoot: root });
      expect(transport).toBeInstanceOf(RecordTransport);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("mode is a required field at the type level (no implicit default)", () => {
    // @ts-expect-error mode is required — this file must not compile if it becomes optional.
    const build = () => createRetrievalTransport({});
    expect(build).toThrow();
  });
});
