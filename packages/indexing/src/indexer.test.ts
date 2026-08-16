import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemVolumeStore, toChapterSlug, toVolumeSlug, type VolumeStore } from "@shadow/core";
import { StructuralIndexer } from "./indexer.ts";
import type { IndexDocument, VolumeIndexDocument } from "./types.ts";
import { isValidUlid } from "./ulid.ts";

async function withStore(
  fn: (store: VolumeStore, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shadow-indexing-test-"));
  try {
    await fn(new FileSystemVolumeStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("StructuralIndexer — ULID minting and write-back (D13)", () => {
  test("mints a ULID for a chapter with no `id` and writes it back to frontmatter", async () => {
    await withStore(async (store, root) => {
      const volume = toVolumeSlug("ui-design");
      await store.createVolume({ slug: volume, title: "Interface Design" });
      await store.putChapter(volume, {
        slug: toChapterSlug("density"),
        title: "Density",
        body: "Some prose about density.\n",
      });

      const indexer = new StructuralIndexer({ rootDir: root });
      const { document, mintedIds } = await indexer.build(store);

      expect(mintedIds).toHaveLength(1);
      expect(mintedIds[0]?.chapterSlug).toBe("density");
      expect(isValidUlid(mintedIds[0]?.id)).toBe(true);

      const chapterNode = document.volumes[0]?.chapters[0];
      expect(chapterNode?.node_id).toBe(mintedIds[0]?.id);

      const onDisk = await store.getChapter(volume, toChapterSlug("density"));
      const mintedId: string | undefined = mintedIds[0]?.id;
      expect(onDisk.frontmatter.id).toBe(mintedId);
    });
  });

  test("a second build does not change a previously minted id, and mints nothing new", async () => {
    await withStore(async (store, root) => {
      const volume = toVolumeSlug("ui-design");
      await store.createVolume({ slug: volume, title: "Interface Design" });
      await store.putChapter(volume, {
        slug: toChapterSlug("density"),
        title: "Density",
        body: "Some prose about density.\n",
      });

      const indexer = new StructuralIndexer({ rootDir: root });
      const first = await indexer.build(store);
      const mintedId = first.mintedIds[0]?.id;

      const second = await indexer.build(store);
      expect(second.mintedIds).toEqual([]);
      expect(second.document.volumes[0]?.chapters[0]?.node_id).toBe(mintedId);
    });
  });

  test("other frontmatter keys survive minting intact, including their order", async () => {
    await withStore(async (store, root) => {
      const volume = toVolumeSlug("ui-design");
      await store.createVolume({ slug: volume, title: "Interface Design" });
      const frontmatter = {
        when_to_use: "Designing dense tables",
        not_for: "marketing pages",
        keywords: ["density", "tables"],
        confidence: "high",
        custom_field: "preserved verbatim",
      };
      await store.putChapter(volume, {
        slug: toChapterSlug("density"),
        title: "Density",
        body: "prose\n",
        frontmatter,
      });

      const indexer = new StructuralIndexer({ rootDir: root });
      await indexer.build(store);

      const onDisk = await store.getChapter(volume, toChapterSlug("density"));
      for (const [key, value] of Object.entries(frontmatter)) {
        expect(onDisk.frontmatter[key]).toEqual(value);
      }
      expect(onDisk.frontmatter.id).toBeDefined();
      // The pre-existing keys keep their original relative order; `id` is appended.
      expect(Object.keys(onDisk.frontmatter).slice(0, -1)).toEqual(Object.keys(frontmatter));
    });
  });

  test("a chapter that already has an id is left untouched (not re-minted)", async () => {
    await withStore(async (store, root) => {
      const volume = toVolumeSlug("ui-design");
      await store.createVolume({ slug: volume, title: "Interface Design" });
      const existingId = "01J8X7QK3M2F5R7T9V0W1Y2Z3A";
      await store.putChapter(volume, {
        slug: toChapterSlug("density"),
        title: "Density",
        body: "prose\n",
        frontmatter: { id: existingId },
      });

      const indexer = new StructuralIndexer({ rootDir: root });
      const { document, mintedIds } = await indexer.build(store);

      expect(mintedIds).toEqual([]);
      expect(document.volumes[0]?.chapters[0]?.node_id).toBe(existingId);
    });
  });
});

describe("StructuralIndexer — end to end via VolumeStore", () => {
  test("builds and persists the full index.json shape over a small fixture volume", async () => {
    await withStore(async (store, root) => {
      const volume = toVolumeSlug("ui-design");
      await store.createVolume({
        slug: volume,
        title: "Interface Design",
        description: "How Linear and Notion design interfaces.",
      });

      await store.putChapter(volume, {
        slug: toChapterSlug("linear-density"),
        title: "How Linear handles information density",
        body: [
          "## Density vs whitespace",
          "x".repeat(4000),
          "### Row height",
          "y".repeat(200),
          "## Truncation rules",
          "z".repeat(200),
        ].join("\n"),
        frontmatter: {
          when_to_use: "Designing list views, tables, dashboards.",
          not_for: "marketing pages, onboarding flows",
          keywords: ["density", "list view", "row height"],
          confidence: "high",
        },
      });

      await store.putChapter(volume, {
        slug: toChapterSlug("short-note"),
        title: "A short note",
        body: "## Just one small heading\nBrief content.\n",
      });

      const indexer = new StructuralIndexer({ rootDir: root });
      const { document } = await indexer.reindex(store);

      // --- top-level shape ---
      expect(document.schema_version).toBe(1);
      expect(typeof document.generated_at).toBe("string");
      expect(document.corpus_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(document.stats).toEqual({ volumes: 1, chapters: 2, tokens: expect.any(Number) });

      // --- volume shape ---
      expect(document.volumes).toHaveLength(1);
      const volumeNode = document.volumes[0];
      expect(volumeNode?.volume_id).toBe("ui-design");
      expect(volumeNode?.title).toBe("Interface Design");
      expect(volumeNode?.chapter_count).toBe(2);
      expect(volumeNode?.volume_hash).toMatch(/^sha256:[0-9a-f]{64}$/);

      // --- chapter shape (sorted by slug: "linear-density" < "short-note") ---
      const [linear, short] = volumeNode?.chapters ?? [];
      expect(linear?.kind).toBe("chapter");
      expect(isValidUlid(linear?.node_id)).toBe(true);
      expect(linear?.slug).toBe("linear-density");
      expect(linear?.path).toEqual(["Interface Design", "How Linear handles information density"]);
      expect(linear?.file).toBe("volumes/ui-design/chapters/linear-density.md");
      expect(linear?.when_to_use).toBe("Designing list views, tables, dashboards.");
      expect(linear?.not_for).toBe("marketing pages, onboarding flows");
      expect(linear?.keywords).toEqual(["density", "list view", "row height"]);
      expect(linear?.confidence).toBe("high");
      expect(linear?.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(linear?.subtree_hash).toMatch(/^sha256:[0-9a-f]{64}$/);

      // --- section shape (over-threshold chapter) ---
      expect(linear?.sections).toBeDefined();
      expect(linear?.sections?.[0]?.title).toBe("Density vs whitespace");
      expect(linear?.sections?.[0]?.kind).toBe("section");
      expect(linear?.sections?.[0]?.node_id).toBe(`${linear?.node_id}#density-vs-whitespace`);
      expect(linear?.sections?.[0]?.sections?.map((s) => s.title)).toEqual(["Row height"]);
      // Non-overlap and union semantics, asserted at the full-document level too.
      const topSpans = linear?.sections?.map((s) => s.span) ?? [];
      expect(topSpans[0]?.end_byte).toBe(topSpans[1]?.start_byte);
      const parent = linear?.sections?.[0];
      const child = parent?.sections?.[0];
      expect(child?.span.start_byte).toBeGreaterThanOrEqual(parent?.span.start_byte ?? 0);
      expect(child?.span.end_byte).toBeLessThanOrEqual(parent?.span.end_byte ?? 0);

      // --- under-threshold chapter: key_items, no sections ---
      expect(short?.sections).toBeUndefined();
      expect(short?.key_items).toEqual(["Just one small heading"]);

      // --- persisted: corpus-wide document lives at the corpus index slot ---
      const persistedCorpus = await store.readCorpusIndex<IndexDocument>();
      expect(persistedCorpus).toEqual(document);

      // --- persisted: the volume's own index.json is a scoped view, not the corpus ---
      const persistedVolume = await store.readIndex<VolumeIndexDocument>(volume);
      expect(persistedVolume?.schema_version).toBe(document.schema_version);
      expect(persistedVolume?.generated_at).toBe(document.generated_at);
      expect(persistedVolume?.corpus_hash).toBe(document.corpus_hash);
      expect(persistedVolume?.volume).toEqual(volumeNode);
    });
  });

  test("reindex no longer duplicates the corpus into every volume's index.json (T2.2 follow-up)", async () => {
    await withStore(async (store, root) => {
      const volA = toVolumeSlug("volume-a");
      const volB = toVolumeSlug("volume-b");
      await store.createVolume({ slug: volA, title: "Volume A" });
      await store.createVolume({ slug: volB, title: "Volume B" });
      await store.putChapter(volA, { slug: toChapterSlug("a1"), title: "A1", body: "prose\n" });
      await store.putChapter(volB, { slug: toChapterSlug("b1"), title: "B1", body: "prose\n" });

      const indexer = new StructuralIndexer({ rootDir: root });
      const { document } = await indexer.reindex(store);

      expect(document.volumes).toHaveLength(2);

      // The corpus-wide document lives once, at the corpus index slot.
      const persistedCorpus = await store.readCorpusIndex<IndexDocument>();
      expect(persistedCorpus).toEqual(document);

      // Each volume's own index.json holds only that volume's own node —
      // volume A's index does not list volume B's chapters, and vice versa.
      const persistedA = await store.readIndex<VolumeIndexDocument>(volA);
      const persistedB = await store.readIndex<VolumeIndexDocument>(volB);
      expect(persistedA?.volume.volume_id).toBe("volume-a");
      expect(persistedA?.volume.chapters.map((c) => c.slug)).toEqual(["a1"]);
      expect(persistedB?.volume.volume_id).toBe("volume-b");
      expect(persistedB?.volume.chapters.map((c) => c.slug)).toEqual(["b1"]);
      // Neither per-volume view carries a `volumes` array (that's the
      // corpus document's shape) — each is scoped to a single `volume`.
      expect(persistedA).not.toHaveProperty("volumes");
      expect(persistedB).not.toHaveProperty("volumes");
    });
  });

  test("build() does not write index.json or the corpus index; only reindex() does", async () => {
    await withStore(async (store, root) => {
      const volume = toVolumeSlug("v");
      await store.createVolume({ slug: volume, title: "V" });
      await store.putChapter(volume, { slug: toChapterSlug("c"), title: "C", body: "prose\n" });

      const indexer = new StructuralIndexer({ rootDir: root });
      await indexer.build(store);

      expect(await store.readIndex(volume)).toBeUndefined();
      expect(await store.readCorpusIndex()).toBeUndefined();
    });
  });

  test("volume routing fields come from VOLUME.md frontmatter, with description as fallback when_to_use", async () => {
    await withStore(async (store, root) => {
      const routed = toVolumeSlug("routed");
      await store.createVolume({
        slug: routed,
        title: "Routed",
        description: "Fallback description, not used because frontmatter wins.",
        frontmatter: {
          when_to_use: "Designing UI: layout, density, navigation.",
          not_for: "brand identity, illustration",
          keywords: ["linear", "notion", "density"],
        },
      });
      await store.putChapter(routed, { slug: toChapterSlug("c"), title: "C", body: "prose\n" });

      const fallback = toVolumeSlug("fallback-only");
      await store.createVolume({
        slug: fallback,
        title: "Fallback Only",
        description: "How Linear and Notion design interfaces.",
      });
      await store.putChapter(fallback, { slug: toChapterSlug("c"), title: "C", body: "prose\n" });

      const indexer = new StructuralIndexer({ rootDir: root });
      const { document } = await indexer.build(store);

      const routedNode = document.volumes.find((v) => v.volume_id === "routed");
      expect(routedNode?.when_to_use).toBe("Designing UI: layout, density, navigation.");
      expect(routedNode?.not_for).toBe("brand identity, illustration");
      expect(routedNode?.keywords).toEqual(["linear", "notion", "density"]);

      const fallbackNode = document.volumes.find((v) => v.volume_id === "fallback-only");
      expect(fallbackNode?.when_to_use).toBe("How Linear and Notion design interfaces.");
      expect(fallbackNode?.not_for).toBeUndefined();
      expect(fallbackNode?.keywords).toBeUndefined();
    });
  });

  test("an empty corpus (no volumes) builds a valid, empty document without error", async () => {
    await withStore(async (store, root) => {
      const indexer = new StructuralIndexer({ rootDir: root });
      const { document, mintedIds } = await indexer.build(store);
      expect(document.volumes).toEqual([]);
      expect(document.stats).toEqual({ volumes: 0, chapters: 0, tokens: 0 });
      expect(mintedIds).toEqual([]);
    });
  });
});

describe("StructuralIndexer.reindex — OKF root/volume index.md and log.md placement (bug F1)", () => {
  test("root index.md and log.md land at <rootDir>/{index,log}.md, not under volumes/", async () => {
    await withStore(async (store, root) => {
      const volume = toVolumeSlug("ui-design");
      await store.createVolume({ slug: volume, title: "Interface Design" });
      await store.putChapter(volume, {
        slug: toChapterSlug("density"),
        title: "Density",
        body: "prose\n",
      });

      await new StructuralIndexer({ rootDir: root }).reindex(store);

      const rootIndex = Bun.file(join(root, "index.md"));
      const rootLog = Bun.file(join(root, "log.md"));
      expect(await rootIndex.exists()).toBe(true);
      expect(await rootLog.exists()).toBe(true);
      expect(await rootIndex.text()).toContain('okf_version: "0.2"');

      // The old off-by-one landed these one level too shallow, at
      // <rootDir>/volumes/{index,log}.md — must not exist there.
      expect(await Bun.file(join(root, "volumes", "index.md")).exists()).toBe(false);
      expect(await Bun.file(join(root, "volumes", "log.md")).exists()).toBe(false);
    });
  });

  test("an empty corpus (no volumes) still gets both root artifacts", async () => {
    await withStore(async (store, root) => {
      await new StructuralIndexer({ rootDir: root }).reindex(store);

      const rootIndex = Bun.file(join(root, "index.md"));
      const rootLog = Bun.file(join(root, "log.md"));
      expect(await rootIndex.exists()).toBe(true);
      expect(await rootLog.exists()).toBe(true);

      const indexText = await rootIndex.text();
      expect(indexText).toContain('okf_version: "0.2"');
      expect(indexText).toContain("# Volumes");
      expect(indexText).not.toContain("##"); // no volume sections

      expect(await rootLog.text()).toContain("_No changes recorded yet._");
    });
  });

  test("per-volume index.md and log.md still land unchanged inside each volume's own directory", async () => {
    await withStore(async (store, root) => {
      const volA = toVolumeSlug("volume-a");
      const volB = toVolumeSlug("volume-b");
      await store.createVolume({ slug: volA, title: "Volume A" });
      await store.createVolume({ slug: volB, title: "Volume B" });
      await store.putChapter(volA, { slug: toChapterSlug("a1"), title: "A1", body: "prose\n" });
      await store.putChapter(volB, { slug: toChapterSlug("b1"), title: "B1", body: "prose\n" });

      await new StructuralIndexer({ rootDir: root }).reindex(store);

      const volADir = join(root, "volumes", "volume-a");
      const volBDir = join(root, "volumes", "volume-b");

      expect(await Bun.file(join(volADir, "index.md")).exists()).toBe(true);
      expect(await Bun.file(join(volADir, "log.md")).exists()).toBe(true);
      expect(await Bun.file(join(volBDir, "index.md")).exists()).toBe(true);
      expect(await Bun.file(join(volBDir, "log.md")).exists()).toBe(true);

      const volAIndexText = await Bun.file(join(volADir, "index.md")).text();
      // Per-volume index.md keeps volume-relative chapter links and carries
      // no okf_version frontmatter (only the root index.md does).
      expect(volAIndexText).toContain("[A1](chapters/a1.md)");
      expect(volAIndexText).not.toContain("okf_version");
    });
  });
});
