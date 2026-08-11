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
import { coerceRoutingText, coerceStringArray } from "./routing-fields.ts";
import type {
  ChapterIndexNode,
  IndexDocument,
  VolumeIndexDocument,
  VolumeIndexNode,
} from "./types.ts";
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

  /**
   * `build`, then persist the result: the corpus-wide document to the
   * root-level corpus index (`VolumeStore.writeCorpusIndex`), and a
   * volume-scoped view (just that volume's own node) to each volume's own
   * `index.json` (`VolumeStore.writeIndex`).
   */
  reindex(store: VolumeStore): Promise<BuildIndexResult>;
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
    // Corpus-wide document goes to the root-level corpus index
    // (`@shadow/core`'s `writeCorpusIndex`, added in T1.4/f02692f
    // specifically to close this gap — T2.2 had no corpus-level slot and
    // wrote the whole corpus document into every volume's own index.json
    // as a workaround, so volume A's index listed volume B's chapters).
    await store.writeCorpusIndex(result.document);
    // Each volume's own index.json gets a *scoped* view — just its own
    // node, not the corpus. This is still worth writing (not dropped
    // entirely): it is what a consumer who only cares about one volume
    // (the web UI's index-tree viewer for that volume, `shadow read`
    // resolving a citation without needing the whole corpus) reads without
    // paying for every other volume's chapters, and it is the volume's own
    // durable historical record independent of corpus growth elsewhere.
    for (const [i, slug] of volumeSlugs.entries()) {
      const volumeNode = result.document.volumes[i];
      if (!volumeNode) {
        continue; // unreachable: volumeSlugs and document.volumes are built in lockstep in buildInternal
      }
      const volumeView: VolumeIndexDocument = {
        schema_version: result.document.schema_version,
        generated_at: result.document.generated_at,
        corpus_hash: result.document.corpus_hash,
        volume: volumeNode,
      };
      await store.writeIndex(slug, volumeView);
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
              file: store.chapterRelativePath(volume.slug, ensured.chapter.slug),
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
          // @shadow/core's Volume now carries an open `frontmatter` record
          // (T1.4/f02692f), the volume-level counterpart of a chapter's
          // frontmatter — VOLUME.md round-trips `when_to_use`/`not_for`/
          // `keywords` the same way a chapter document does. `description`
          // (the VOLUME.md body, free prose) is kept only as a fallback for
          // `when_to_use` when the operator hasn't authored routing
          // frontmatter yet, since it is at least a content-adjacent signal
          // and better than leaving routing empty.
          whenToUse:
            coerceRoutingText(volume.frontmatter.when_to_use) ??
            coerceRoutingText(volume.description),
          notFor: coerceRoutingText(volume.frontmatter.not_for),
          keywords: coerceStringArray(volume.frontmatter.keywords),
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
