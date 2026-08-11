import { describe, expect, test } from "bun:test";
import { CorpusLoadError } from "../errors.ts";
import { loadGoldenSet } from "../golden/golden-set.ts";
import { expectRejection } from "../test-helpers.ts";
import { listChapterIds } from "./chapter-id.ts";
import { FIXTURE_CORPUS_PATH, loadFixtureCorpus } from "./fixture-corpus.ts";

describe("loadFixtureCorpus — the real, committed T4.1 corpus", () => {
  test("loads within the brief's aimed-for size: 3-5 volumes, ~20-40 chapters", async () => {
    const corpus = await loadFixtureCorpus();
    try {
      expect(corpus.document.stats.volumes).toBeGreaterThanOrEqual(3);
      expect(corpus.document.stats.volumes).toBeLessThanOrEqual(5);
      expect(corpus.document.stats.chapters).toBeGreaterThanOrEqual(20);
      expect(corpus.document.stats.chapters).toBeLessThanOrEqual(40);
    } finally {
      await corpus.cleanup();
    }
  });

  test("every chapter carries authored when_to_use — routing signal, not generated summary", async () => {
    const corpus = await loadFixtureCorpus();
    try {
      for (const volume of corpus.document.volumes) {
        for (const chapter of volume.chapters) {
          expect(
            chapter.when_to_use,
            `${volume.volume_id}/${chapter.slug} has no when_to_use`,
          ).toBeTruthy();
        }
      }
    } finally {
      await corpus.cleanup();
    }
  });

  test("the committed golden set validates cleanly against this exact corpus", async () => {
    const corpus = await loadFixtureCorpus();
    try {
      const ids = listChapterIds(corpus.document);
      expect(() => loadGoldenSet(ids)).not.toThrow();
    } finally {
      await corpus.cleanup();
    }
  });

  test("loading twice does not mutate the committed fixture files (scratch-copy isolation)", async () => {
    const first = await loadFixtureCorpus();
    const second = await loadFixtureCorpus();
    try {
      // Both independent scratch copies index to the same structural content.
      expect(first.document.corpus_hash).toBe(second.document.corpus_hash);
      expect(first.document.stats).toEqual(second.document.stats);
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  test("cleanup() is idempotent — calling it twice does not throw", async () => {
    const corpus = await loadFixtureCorpus();
    await corpus.cleanup();
    await corpus.cleanup();
  });

  test("throws CorpusLoadError for a path with no volumes/ directory", async () => {
    await expectRejection(loadFixtureCorpus("/nonexistent/not-a-corpus"), CorpusLoadError);
  });

  test("FIXTURE_CORPUS_PATH resolves under this package regardless of caller cwd", () => {
    expect(FIXTURE_CORPUS_PATH).toContain("packages/evaluation/fixtures/corpus");
  });
});
