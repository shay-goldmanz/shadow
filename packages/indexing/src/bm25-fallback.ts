/**
 * BM25 as fallback locator and disagreement signal (D11a) — explicitly
 * *not* on the default query path. The agent reading the full chapter
 * index is STAGE 0's default locator at our scale; BM25 only earns its
 * keep in two situations:
 *
 * - **Fallback**: STAGE 3 (NAVIGATE) came back with nothing chosen — BM25
 *   catches vocabulary `when_to_use` fields miss (product names, error
 *   codes, people).
 * - **Disagreement signal**: the agent *did* choose something, but BM25's
 *   independently-computed top hit sits far from that choice — logged as
 *   a routing-quality alarm, the feedback loop that tells the operator a
 *   `when_to_use` is wrong.
 *
 * Building the BM25 index needs chapter body text, which `IndexDocument`
 * deliberately never carries (`docs/INDEXING.md`: "never put body text in
 * a structure payload"). So this module stays pure and testable by taking
 * bodies as an explicit `chapterBodies` map — the caller (`navigator.ts`'s
 * concrete `Navigator`) is the one that does the `VolumeStore` I/O to
 * fetch them, only when this path actually triggers.
 *
 * **I-6 (Wave 2 review): rollup, wired into promotion.** `rollupScore`
 * (`rollup.ts`) implements the `1/√(N+1)·Σ` aggregator, but before this
 * fix its only reference outside its own test was the package's barrel
 * export — `docs/INDEXING.md`'s STAGE 1 says the rollup "applies... when
 * scoring", and the BM25 fallback is the only place this package ever
 * scores anything, so an unwired rollup meant the fallback's promotion
 * decision — `resolveChosen` in `navigator.ts` — simply took the single
 * raw top hit across the whole flat corpus (chapters and sections as
 * independent documents), with no chapter-level aggregation at all.
 *
 * `rollupFallbackPromotion` below closes that gap, applied at exactly the
 * level `docs/INDEXING.md` names first — chapter level, `N` = the
 * chapter's own sections: `NodeScore(chapter) = 1/√(N+1) · Σ score(section)`
 * for a chapter that has sections, or the chapter's own flat document score
 * unchanged for a chapter that does not (the overwhelming majority at this
 * package's scale — sections only exist above `SECTION_TOKEN_THRESHOLD`).
 * This rewards a chapter whose *several* sections each partially match over
 * a chapter with one single higher-scoring section elsewhere, which a bare
 * top-hit promotion structurally cannot do — see `bm25-fallback.test.ts`'s
 * "aggregation beats a single higher-scoring section" for a hand-computed
 * case where this changes the actual promoted node versus the flat top hit.
 *
 * **Why not also volume-level.** `docs/INDEXING.md` names the rollup at
 * both chapter and volume level, but the fallback never routes to a volume
 * first — it promotes one specific citeable node directly out of the whole
 * corpus, which is a chapter-vs-chapter (not volume-vs-volume) decision.
 * Volume-level rollup has nothing to feed here; wiring it in would compute
 * a number nothing consumes. `detectDisagreement`'s signal is deliberately
 * left on the raw single top hit, not this aggregate — it exists to catch
 * one specific passage's vocabulary beating the agent's pick, a
 * finer-grained alarm than "which chapter aggregates best".
 */

import { type Bm25Document, type Bm25Hit, Bm25Index } from "./bm25.ts";
import { sliceBytesToText, toBytes } from "./byte-text.ts";
import { rollupScore } from "./rollup.ts";
import type { ChapterIndexNode, IndexDocument, SectionIndexNode } from "./types.ts";

function chapterBm25Document(chapter: ChapterIndexNode, bodyText: string): Bm25Document {
  return {
    id: chapter.node_id,
    fields: {
      title: chapter.title,
      when_to_use: chapter.when_to_use ?? "",
      keywords: (chapter.keywords ?? []).join(" "),
      body: bodyText,
    },
  };
}

function pushSectionDocuments(
  sections: readonly SectionIndexNode[],
  bodyBytes: Uint8Array,
  out: Bm25Document[],
): void {
  for (const section of sections) {
    out.push({
      id: section.node_id,
      fields: {
        title: section.title,
        when_to_use: "",
        keywords: "",
        body: sliceBytesToText(bodyBytes, section.span.start_byte, section.span.end_byte),
      },
    });
    if (section.sections) {
      pushSectionDocuments(section.sections, bodyBytes, out);
    }
  }
}

/**
 * Build a BM25 index over every chapter (and, where sections exist, every
 * section — `docs/INDEXING.md`, step 4 of `build_index`: "unit = chapter
 * (and section where sections exist)") in `document`, given each
 * chapter's body text keyed by its `node_id`. Chapters with no entry in
 * `chapterBodies` are indexed with an empty body field (title/when_to_use/
 * keywords still contribute) rather than omitted, so a caller does not
 * need to guarantee full coverage.
 */
export function buildFallbackIndex(
  document: IndexDocument,
  chapterBodies: ReadonlyMap<string, string>,
): Bm25Index {
  const docs: Bm25Document[] = [];
  for (const volume of document.volumes) {
    for (const chapter of volume.chapters) {
      const bodyText = chapterBodies.get(chapter.node_id) ?? "";
      docs.push(chapterBm25Document(chapter, bodyText));
      if (chapter.sections) {
        pushSectionDocuments(chapter.sections, toBytes(bodyText), docs);
      }
    }
  }
  return new Bm25Index(docs);
}

/** Score `query` and return the top `limit` hits, descending. Thin wrapper over `Bm25Index.score` for call-site symmetry with `detectDisagreement`. */
export function bm25Fallback(index: Bm25Index, query: string, limit = 5): readonly Bm25Hit[] {
  return index.score(query).slice(0, limit);
}

export interface DisagreementSignal {
  readonly bm25TopNodeId: string;
  readonly bm25TopScore: number;
  readonly agentChosen: readonly string[];
}

/**
 * `undefined` when there is nothing to flag: no scored hits, a zero-score
 * top hit (an empty/no-match query — not a real signal), or the agent's
 * own selection already includes BM25's top pick. Otherwise, the
 * disagreement: BM25's independently-ranked top node versus what the
 * agent actually chose — a routing-quality alarm for the operator, not an
 * override of the agent's decision.
 */
export function detectDisagreement(
  agentChosenNodeIds: readonly string[],
  bm25Hits: readonly Bm25Hit[],
): DisagreementSignal | undefined {
  const top = bm25Hits[0];
  if (!top || top.score <= 0) {
    return undefined;
  }
  if (agentChosenNodeIds.includes(top.id)) {
    return undefined;
  }
  return { bm25TopNodeId: top.id, bm25TopScore: top.score, agentChosen: agentChosenNodeIds };
}

/** `NodeScore(node) = 1/√(N+1)·Σ score(children)` when `node` has children, or its own raw score when it does not (the leaf/no-structure case — there is nothing "under" it to roll up). Recurses so a nested sub-section's own children are rolled up before its parent sums them, matching `lint-cost-model.ts`'s `treeCost` precedent for walking this same section tree shape. */
function rollupNodeScore(
  nodeId: string,
  children: readonly SectionIndexNode[] | undefined,
  scores: ReadonlyMap<string, number>,
): number {
  if (!children || children.length === 0) {
    return scores.get(nodeId) ?? 0;
  }
  return rollupScore(
    children.map((child) => rollupNodeScore(child.node_id, child.sections, scores)),
  );
}

/** Every node_id in `chapter`'s own subtree — itself plus every section at every depth — the candidate set for "which specific node do we actually cite" once a chapter has won on aggregate score. */
function chapterSubtreeIds(chapter: ChapterIndexNode): string[] {
  const ids: string[] = [chapter.node_id];
  const walk = (sections: readonly SectionIndexNode[] | undefined): void => {
    for (const section of sections ?? []) {
      ids.push(section.node_id);
      walk(section.sections);
    }
  };
  walk(chapter.sections);
  return ids;
}

/** The single highest *raw* (non-rolled-up) scoring node within `chapter`'s own subtree — the actual passage to cite once the chapter itself has been chosen by its aggregate score. Ties keep whichever candidate was seen first (document order: the chapter itself, then its sections in order). */
function bestNodeInChapter(
  chapter: ChapterIndexNode,
  scores: ReadonlyMap<string, number>,
): { readonly id: string; readonly score: number } {
  let best = { id: chapter.node_id, score: scores.get(chapter.node_id) ?? 0 };
  for (const id of chapterSubtreeIds(chapter)) {
    const score = scores.get(id) ?? 0;
    if (score > best.score) {
      best = { id, score };
    }
  }
  return best;
}

export interface RollupPromotion {
  /** The chapter that won on aggregate (rolled-up) score. */
  readonly chapterId: string;
  readonly chapterScore: number;
  /** The specific node actually promoted for citation — the winning chapter's own best-scoring node (itself, or its strongest section). */
  readonly bestNodeId: string;
}

/**
 * Pick the fallback promotion (`resolveChosen` in `navigator.ts`, when
 * STAGE 3 navigation returns nothing chosen): the chapter with the highest
 * rolled-up score (`rollupNodeScore`, STAGE 1's `1/√(N+1)·Σ`), then the
 * single best-scoring node within that chapter to actually cite. `hits`
 * should be the *full*, un-truncated score set (`Bm25Index.score`, not
 * `bm25Fallback`'s `limit`-sliced view) — every chapter and section needs
 * its own score for aggregation, not just the top few.
 *
 * Returns `undefined` when no chapter's aggregate score is positive — a
 * zero aggregate means no query term matched anything under that chapter
 * at all, and promoting it would fabricate a "find" out of noise (same
 * cutoff `detectDisagreement` and the pre-rollup fallback both used).
 */
export function rollupFallbackPromotion(
  document: IndexDocument,
  hits: readonly Bm25Hit[],
): RollupPromotion | undefined {
  const scores = new Map(hits.map((hit) => [hit.id, hit.score]));
  let winner: RollupPromotion | undefined;

  for (const volume of document.volumes) {
    for (const chapter of volume.chapters) {
      const chapterScore = rollupNodeScore(chapter.node_id, chapter.sections, scores);
      if (chapterScore <= 0) {
        continue;
      }
      if (!winner || chapterScore > winner.chapterScore) {
        const best = bestNodeInChapter(chapter, scores);
        winner = { chapterId: chapter.node_id, chapterScore, bestNodeId: best.id };
      }
    }
  }

  return winner;
}
