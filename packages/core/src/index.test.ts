import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChapterNotFoundError,
  FileSystemVolumeStore,
  InvalidSlugError,
  toChapterSlug,
  toVolumeSlug,
  VolumeNotFoundError,
} from "./index.ts";
import { expectRejection } from "./test-helpers.ts";

// A smoke test of the *public* surface only — everything imported here comes
// from "./index.ts", not from internal modules. Exhaustive behavior is
// covered by the per-module test files; this just proves the exported API
// composes end to end the way a consumer package would use it.
describe("@shadow/core public surface", () => {
  test("create a volume, write a chapter, read it back, and observe not-found errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "shadow-core-index-test-"));
    try {
      const store = new FileSystemVolumeStore(root);

      const volume = await store.createVolume({
        slug: toVolumeSlug("linear-ui"),
        title: "Linear UI",
        description: "How Linear designs UI",
      });

      const chapter = await store.putChapter(volume.slug, {
        slug: toChapterSlug("component-density"),
        title: "Component Density",
        body: "Linear favors dense, keyboard-first layouts.\n",
        frontmatter: { when_to_use: ["designing a dense UI"] },
      });

      const fetched = await store.getChapter(volume.slug, chapter.slug);
      expect(fetched.title).toBe("Component Density");
      expect(fetched.frontmatter).toEqual({ when_to_use: ["designing a dense UI"] });

      await expectRejection(store.getVolume(toVolumeSlug("nonexistent")), VolumeNotFoundError);
      await expectRejection(
        store.getChapter(volume.slug, toChapterSlug("nonexistent")),
        ChapterNotFoundError,
      );
      expect(() => toVolumeSlug("../escape")).toThrow(InvalidSlugError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
