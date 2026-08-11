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
 */

import { Bm25Index, type Bm25Document, type Bm25Hit } from "./bm25.ts";
import { sliceBytesToText, toBytes } from "./byte-text.ts";
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
