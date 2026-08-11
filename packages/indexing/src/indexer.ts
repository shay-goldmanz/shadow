/**
 * The `Indexer` port and its default implementation: builds the
 * structural index over a corpus of volumes (`docs/INDEXING.md`,
 * "Algorithm: build"). Zero LLM calls, zero network calls — structure
 * comes from Markdown headings, routing signals from authored
 * frontmatter.
 *
 * `Navigator` (T2.3, retrieval) and `shadow lint` (T2.6, self-critique)
 * are separate ports that consume this interface's output (see
 * `navigator.ts` for the retrieval seam); neither is implemented here.
 */

import type { Chapter, VolumeSlug, VolumeStore } from "@shadow/core";
import { buildChapterIndexNode } from "./chapter-index.ts";
import { buildIndexDocument } from "./corpus-index.ts";
import { ChapterIndexBuildError } from "./errors.ts";
import { coerceRoutingText } from "./routing-fields.ts";
import type { ChapterIndexNode, IndexDocument, VolumeIndexNode } from "./types.ts";
import { generateUlid } from "./ulid.ts";
import { buildVolumeIndexNode } from "./volume-index.ts";

export interface MintedId {
  readonly volumeSlug: string;
  readonly chapterSlug: string;
  readonly id: string;
}

export interface BuildIndexResult {
  readonly document: IndexDocument;
  /**
   * Chapters that had no `id` in frontmatter before this build and got one
   * minted + written back (D13). Empty when every chapter already had a
   * stable id — in particular, always empty on a second consecutive build
   * over the same corpus.
   */
  readonly mintedIds: readonly MintedId[];
}

/**
 * Builds (and optionally persists) the structural index over every volume
 * `store` knows about.
 */
export interface Indexer {
  /**
   * Build the index in memory. The only write this performs is the
   * unavoidable ULID mint-and-write-back for chapters with no `id`
   * (D13) — `index.json` itself is not touched.
   */
  build(store: VolumeStore): Promise<BuildIndexResult>;

  /** `build`, then persist the result as every volume's `index.json`. */
  reindex(store: VolumeStore): Promise<BuildIndexResult>;
}

function chapterFilePath(volumeSlug: string, chapterSlug: string): string {
  return `volumes/${volumeSlug}/chapters/${chapterSlug}.md`;
}

function getExistingId(frontmatter: Readonly<Record<string, unknown>>): string | undefined {
  const id = frontmatter.id;
  return typeof id === "string" && id.trim().length > 0 ? id : undefined;
}

interface InternalBuild {
  readonly result: BuildIndexResult;
  /** Same volumes as `result.document.volumes`, same order, but as the branded `VolumeSlug` values `writeIndex` requires. */
  readonly volumeSlugs: readonly VolumeSlug[];
}

/**
 * Default `Indexer`: deterministic Markdown-heading structure + authored
 * frontmatter, no LLM. Rebuilds the whole corpus on every call (D11a) —
 * at our scale (~100 chapters) this runs in well under a second, so there
 * is no incremental/skip-work machinery to maintain.
 */
export class StructuralIndexer implements Indexer {
  async build(store: VolumeStore): Promise<BuildIndexResult> {
    return (await this.buildInternal(store)).result;
  }

  async reindex(store: VolumeStore): Promise<BuildIndexResult> {
    const { result, volumeSlugs } = await this.buildInternal(store);
    // Persist the identical corpus-wide document into every volume's own
    // index.json. VolumeStore.writeIndex is scoped per volume with no
    // corpus-level equivalent, and this package must not build a
    // filesystem path of its own for a hypothetical root-level file — so
    // this redundant-but-cheap (milliseconds, ~12k tokens per D11a) write
    // is how every volume's index.json ends up holding the full,
    // consistent corpus view that docs/INDEXING.md's schema describes.
    // Flagged in the implementation report as a boundary tension worth
    // revisiting if `VolumeStore` grows a corpus-level index slot.
    for (const slug of volumeSlugs) {
      await store.writeIndex(slug, result.document);
    }
    return result;
  }

  private async buildInternal(store: VolumeStore): Promise<InternalBuild> {
    const volumes = await store.listVolumes(); // sorted by slug (VolumeStore contract)
    const mintedIds: MintedId[] = [];
    const volumeNodes: VolumeIndexNode[] = [];
    const volumeSlugs: VolumeSlug[] = [];

    for (const volume of volumes) {
      volumeSlugs.push(volume.slug);
      const chapters = await store.listChapters(volume.slug); // sorted by slug
      const chapterNodes: ChapterIndexNode[] = [];

      for (const chapter of chapters) {
        const ensured = await this.ensureId(store, volume.slug, chapter, mintedIds);
        try {
          chapterNodes.push(
            buildChapterIndexNode({
              ulid: ensured.id,
              volumeTitle: volume.title,
              chapterSlug: ensured.chapter.slug,
              chapterTitle: ensured.chapter.title,
              body: ensured.chapter.body,
              frontmatter: ensured.chapter.frontmatter,
              file: chapterFilePath(volume.slug, ensured.chapter.slug),
            }),
          );
        } catch (cause) {
          throw new ChapterIndexBuildError(volume.slug, chapter.slug, cause);
        }
      }

      volumeNodes.push(
        buildVolumeIndexNode({
          volumeSlug: volume.slug,
          volumeTitle: volume.title,
          // @shadow/core's Volume carries only title/description — no
          // dedicated when_to_use/not_for/keywords fields. docs/INDEXING.md
          // assumes a VOLUME.md file with that frontmatter; core has no
          // such file or fields (frozen, out of this task's scope).
          // `description` is the closest available signal, used as a
          // best-effort `when_to_use`; `not_for`/`keywords` have no source
          // and are left absent. Flagged in the implementation report.
          whenToUse: coerceRoutingText(volume.description),
          notFor: undefined,
          keywords: undefined,
          chapters: chapterNodes,
        }),
      );
    }

    return { result: { document: buildIndexDocument(volumeNodes), mintedIds }, volumeSlugs };
  }

  private async ensureId(
    store: VolumeStore,
    volumeSlug: VolumeSlug,
    chapter: Chapter,
    mintedIds: MintedId[],
  ): Promise<{ id: string; chapter: Chapter }> {
    const existing = getExistingId(chapter.frontmatter);
    if (existing) {
      return { id: existing, chapter };
    }

    // Deliberate side effect during what looks like a read (D13): mint a
    // ULID and rewrite the chapter file with it. `putChapter` is an
    // upsert that preserves `createdAt` and merges frontmatter verbatim
    // via a shallow spread, so every other key survives unchanged; only
    // `updatedAt` advances, and `id` is appended.
    const id = generateUlid();
    const updated = await store.putChapter(volumeSlug, {
      slug: chapter.slug,
      title: chapter.title,
      body: chapter.body,
      frontmatter: { ...chapter.frontmatter, id },
    });
    mintedIds.push({ volumeSlug, chapterSlug: chapter.slug, id });
    return { id, chapter: updated };
  }
}
