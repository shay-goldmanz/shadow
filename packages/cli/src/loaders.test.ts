import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemVolumeStore, toChapterSlug, toVolumeSlug } from "@shadow/core";
import { StructuralIndexer } from "@shadow/indexing";
import { IndexMissingError } from "./errors.ts";
import { loadCorpusIndex } from "./loaders.ts";

async function withStore(fn: (store: FileSystemVolumeStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shadow-loaders-test-"));
  try {
    await fn(new FileSystemVolumeStore(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("loadCorpusIndex", () => {
  test("throws IndexMissingError when nothing has been built yet", async () => {
    await withStore(async (store) => {
      // `expect(promise).rejects...` is documented Bun API, but its
      // matchers are typed `void` despite needing an await, which trips
      // oxlint's type-aware `await-thenable` rule (D8) — plain try/catch
      // sidesteps it, matching the pattern `@shadow/core`'s test helpers use.
      const error = await loadCorpusIndex(store).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IndexMissingError);
    });
  });

  test("returns the persisted corpus document once one has been built", async () => {
    await withStore(async (store) => {
      const volume = toVolumeSlug("v");
      await store.createVolume({ slug: volume, title: "V" });
      await store.putChapter(volume, { slug: toChapterSlug("c"), title: "C", body: "body text" });
      await new StructuralIndexer().reindex(store);

      const document = await loadCorpusIndex(store);
      expect(document.stats.chapters).toBe(1);
      expect(document.volumes[0]?.volume_id).toBe("v");
    });
  });
});
