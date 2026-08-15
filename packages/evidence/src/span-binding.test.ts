import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemVolumeStore, toVolumeSlug } from "@shadow/core";
import { UnknownSourceError, UnresolvedEvidenceQuoteError } from "./errors.ts";
import { toSourceId } from "./ids.ts";
import { buildSpanFromQuote } from "./span-binding.ts";
import { FileSystemEvidenceStore } from "./store.ts";
import { expectRejection, makeFileWitness, makeSourceMetadata } from "./test-helpers.ts";

async function makeHarness() {
  const root = await mkdtemp(join(tmpdir(), "shadow-evidence-span-binding-test-"));
  const volumeStore = new FileSystemVolumeStore(root);
  const volume = toVolumeSlug("test-volume");
  await volumeStore.createVolume({ slug: volume, title: "Test Volume" });
  const evidenceStore = new FileSystemEvidenceStore(volumeStore);
  return {
    evidenceStore,
    volume,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

describe("buildSpanFromQuote", () => {
  test("resolves a real, verbatim quote against a witnessed source into an anchored EvidenceSpan", async () => {
    const { evidenceStore, volume, cleanup } = await makeHarness();
    try {
      const source = await evidenceStore.putSourceFromFile(
        volume,
        makeFileWitness({ text: "Every measurement in the sidebar is a multiple of four." }),
        makeSourceMetadata(),
      );

      const span = await buildSpanFromQuote(evidenceStore, volume, "rb-4px", {
        sourceId: source.id,
        quote: "a multiple of four",
      });

      expect(span.sourceId).toBe(source.id);
      expect(span.snapshotHash).toBe(source.snapshot.normalizedTextSha256);
      expect(span.selector.exact).toBe("a multiple of four");
      expect(span.anchorStatus).toBe("anchored");
      expect(span.selector.refinedBy).toBeDefined();
    } finally {
      await cleanup();
    }
  });

  test("throws UnknownSourceError when the sourceId does not exist", async () => {
    const { evidenceStore, volume, cleanup } = await makeHarness();
    try {
      await expectRejection(
        buildSpanFromQuote(evidenceStore, volume, "label", {
          sourceId: toSourceId(`src_${"0".repeat(26)}`),
          quote: "anything",
        }),
        UnknownSourceError,
      );
    } finally {
      await cleanup();
    }
  });

  test("throws UnresolvedEvidenceQuoteError when the quote is not a verbatim substring", async () => {
    const { evidenceStore, volume, cleanup } = await makeHarness();
    try {
      const source = await evidenceStore.putSourceFromFile(
        volume,
        makeFileWitness({ text: "The real sentence is here." }),
        makeSourceMetadata(),
      );

      await expectRejection(
        buildSpanFromQuote(evidenceStore, volume, "label", {
          sourceId: source.id,
          quote: "a paraphrase that was never actually said",
        }),
        UnresolvedEvidenceQuoteError,
      );
    } finally {
      await cleanup();
    }
  });
});
