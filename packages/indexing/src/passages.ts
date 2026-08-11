/**
 * Passage assembly — "Return passages in document order, not whole
 * chapters" (`docs/INDEXING.md`; D11's CRAG citation: decompose-then-
 * recompose was their single largest ablation, since a mostly-irrelevant
 * chapter can still contribute its one good section).
 *
 * Pure: given a chapter's body bytes (already fetched by the caller — see
 * `read.ts`/`navigator.ts` for the I/O) and a list of relevant section
 * locations in *whatever order relevance ranked them*, reorders and
 * slices them into passages sorted by where they actually sit in the
 * source document, so a reader gets the chapter's own narrative order
 * back rather than a relevance-scrambled one.
 */

import { sliceBytesToText } from "./byte-text.ts";
import type { Span } from "./types.ts";

/** The minimal shape `assemblePassages` needs from a section (or chapter) node — deliberately narrower than `SectionIndexNode` so callers can pass ranked hits from any source (agent selection, BM25) without reshaping them first. */
export interface PassageSource {
  readonly node_id: string;
  readonly heading_path: readonly string[];
  readonly span: Span;
}

export interface Passage {
  readonly node_id: string;
  readonly heading_path: readonly string[];
  readonly span: Span;
  readonly text: string;
}

/**
 * Slice `sources` against `bodyBytes` and return them ordered by
 * `span.start_byte` — document order — regardless of the order `sources`
 * was given in (e.g. a relevance-ranked list from BM25 or an agent's
 * selection).
 */
export function assemblePassages(
  bodyBytes: Uint8Array,
  sources: readonly PassageSource[],
): readonly Passage[] {
  return sources
    .toSorted((a, b) => a.span.start_byte - b.span.start_byte)
    .map((source) => ({
      node_id: source.node_id,
      heading_path: source.heading_path,
      span: source.span,
      text: sliceBytesToText(bodyBytes, source.span.start_byte, source.span.end_byte),
    }));
}
