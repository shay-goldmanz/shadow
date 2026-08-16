/**
 * Shared fixture builders for command-layer tests. Not a `*.test.ts` file —
 * `bun test` won't pick this up on its own. Mirrors the pattern
 * `@shadow/indexing`'s own tests use (`withStore` + a small built corpus),
 * so `@shadow/cli`'s tests exercise the same real `FileSystemVolumeStore` +
 * `StructuralIndexer` path an operator's disk actually has, rather than a
 * hand-rolled fake.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemVolumeStore, toChapterSlug, toVolumeSlug, type VolumeStore } from "@shadow/core";
import { StructuralIndexer } from "@shadow/indexing";

export async function withStore(
  fn: (store: VolumeStore, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shadow-cli-test-"));
  try {
    await fn(new FileSystemVolumeStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * A small, realistic two-volume corpus (well under `CHAPTER_INDEX_THRESHOLD`,
 * so `find` skips STAGE 2 routing by default) drawn from the acceptance
 * critical path: Linear/Notion UI design, and Epoch's one-pager expertise.
 */
export async function buildSmallFixture(store: VolumeStore, root: string): Promise<void> {
  const uiDesign = toVolumeSlug("ui-design");
  await store.createVolume({
    slug: uiDesign,
    title: "Interface Design",
    frontmatter: {
      when_to_use: "Designing UI: layout, density, navigation, component behavior.",
      not_for: "brand identity, illustration, motion design",
      keywords: ["linear", "notion", "density"],
    },
  });
  await store.putChapter(uiDesign, {
    slug: toChapterSlug("linear-density"),
    title: "How Linear handles information density",
    body:
      "# How Linear handles information density\n\n" +
      "Linear renders table rows at a tight 32px height and truncates labels aggressively.\n\n" +
      "## Density vs whitespace\n\nRow height should default to compact for data-heavy views.\n",
    frontmatter: {
      when_to_use:
        "Designing list views, tables, dashboards. Choosing between density and whitespace.",
      not_for: "marketing pages, onboarding flows, empty states",
      keywords: ["density", "list view", "table", "row height", "linear"],
      confidence: "high",
    },
  });
  await store.putChapter(uiDesign, {
    slug: toChapterSlug("notion-whitespace"),
    title: "Notion's near-zero chrome",
    body:
      "# Notion's near-zero chrome\n\n" +
      "Notion favors generous whitespace and near-monochrome warm grey, with almost no visible chrome.\n",
    frontmatter: {
      when_to_use: "Designing calm, content-first surfaces with minimal UI chrome.",
      not_for: "dense data tables, dashboards",
      keywords: ["notion", "whitespace", "chrome", "calm"],
      confidence: "medium",
    },
  });

  const writing = toVolumeSlug("writing");
  await store.createVolume({
    slug: writing,
    title: "Writing",
    frontmatter: {
      when_to_use: "Drafting documents: one-pagers, reports, editorial formats.",
      not_for: "UI design, code",
      keywords: ["epoch", "one-pager", "editorial"],
    },
  });
  await store.putChapter(writing, {
    slug: toChapterSlug("epoch-onepager"),
    title: "How Epoch designs a one-pager",
    body:
      "# How Epoch designs a one-pager\n\n" +
      "Epoch magazine leans on strong editorial hierarchy: one dominant image, a single pull quote.\n",
    frontmatter: {
      when_to_use: "Designing a one-pager, a single-page editorial layout, or a pitch document.",
      not_for: "multi-page documents, slide decks",
      keywords: ["epoch", "one-pager", "editorial", "pull quote"],
      confidence: "high",
    },
  });

  await new StructuralIndexer({ rootDir: root }).reindex(store);
}

/**
 * A corpus with more than `CHAPTER_INDEX_THRESHOLD` (60) chapters across
 * multiple volumes, so `find` exercises STAGE 2 (ROUTE) instead of skipping
 * straight to the flat chapter index.
 */
export async function buildLargeFixture(store: VolumeStore, root: string): Promise<void> {
  const volumeCount = 4;
  const chaptersPerVolume = 16; // 64 total, > CHAPTER_INDEX_THRESHOLD (60)
  for (let v = 0; v < volumeCount; v += 1) {
    const slug = toVolumeSlug(`volume-${v}`);
    await store.createVolume({
      slug,
      title: `Volume ${v}`,
      frontmatter: { when_to_use: `Topic area ${v}.`, keywords: [`topic${v}`] },
    });
    for (let c = 0; c < chaptersPerVolume; c += 1) {
      await store.putChapter(slug, {
        slug: toChapterSlug(`chapter-${c}`),
        title: `Volume ${v} Chapter ${c}`,
        body: `# Volume ${v} Chapter ${c}\n\nBody text for volume ${v} chapter ${c}.\n`,
        frontmatter: {
          when_to_use: `Working on topic ${v}, subtopic ${c}.`,
          keywords: [`topic${v}`, `subtopic${c}`],
        },
      });
    }
  }
  await new StructuralIndexer({ rootDir: root }).reindex(store);
}
