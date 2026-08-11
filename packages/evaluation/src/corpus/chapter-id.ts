/**
 * A stable chapter identity for scoring, independent of the ULID
 * `@shadow/indexing` mints into frontmatter.
 *
 * The golden set (`golden/golden-set.ts`) references chapters by
 * `(volumeSlug, chapterSlug)`, not by `node_id` — `loadFixtureCorpus`
 * rebuilds the index against a fresh scratch copy on every run, and a
 * chapter with no `id` in its committed frontmatter (true of every fixture
 * chapter here — see `fixtures/corpus`) gets a *freshly minted* ULID each
 * time (D13's "mint once" is per corpus, not across independent scratch
 * copies of the same corpus). Scoring against `node_id` directly would
 * silently break the moment a run reused a different scratch copy; slug
 * pairs are stable for as long as the fixture files themselves are, which
 * is exactly the stability the golden set needs (D2/D11a: "a moving corpus
 * makes retrieval scores meaningless").
 */

import type { IndexDocument } from "@shadow/indexing";

/** `"<volumeSlug>/<chapterSlug>"` — the golden set's and every strategy's shared vocabulary for "which chapter". */
export type ChapterId = string;

export function chapterId(volumeSlug: string, chapterSlug: string): ChapterId {
  return `${volumeSlug}/${chapterSlug}`;
}

/**
 * Map every `node_id` in `document` — chapters *and* their sections — to
 * the `ChapterId` of the chapter that owns it. A section's `node_id` is
 * `<chapter ULID>#<slug-path>` (`docs/INDEXING.md`, D13), so a citation
 * naming a section still resolves to its owning chapter for golden-set
 * scoring, which judges relevance at chapter granularity (`docs/PLAN.md`
 * T4.1: "queries paired with the chapter(s) that genuinely answer them").
 */
export function buildNodeToChapterMap(document: IndexDocument): ReadonlyMap<string, ChapterId> {
  const map = new Map<string, ChapterId>();
  for (const volume of document.volumes) {
    for (const chapter of volume.chapters) {
      const id = chapterId(volume.volume_id, chapter.slug);
      map.set(chapter.node_id, id);
      // Sections address as `${chapter.node_id}#...`; every node_id in the
      // document graph that starts with a chapter's own node_id belongs to
      // that chapter, however deeply nested.
    }
  }
  return map;
}

/** Resolve any node_id (chapter or section) to its owning `ChapterId`, using the prefix rule `buildNodeToChapterMap`'s doc comment describes. `undefined` if `nodeId` matches no known chapter. */
export function resolveChapterId(
  nodeToChapter: ReadonlyMap<string, ChapterId>,
  nodeId: string,
): ChapterId | undefined {
  const direct = nodeToChapter.get(nodeId);
  if (direct) {
    return direct;
  }
  const hashIndex = nodeId.indexOf("#");
  if (hashIndex === -1) {
    return undefined;
  }
  return nodeToChapter.get(nodeId.slice(0, hashIndex));
}

/** Every chapter in `document` as a `ChapterId`, in document order — used to validate the golden set references real chapters. */
export function listChapterIds(document: IndexDocument): readonly ChapterId[] {
  const ids: ChapterId[] = [];
  for (const volume of document.volumes) {
    for (const chapter of volume.chapters) {
      ids.push(chapterId(volume.volume_id, chapter.slug));
    }
  }
  return ids;
}
