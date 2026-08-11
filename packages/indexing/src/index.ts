/**
 * @shadow/indexing — the structural `Indexer` (T2.2) and the seams for
 * `Navigator` (T2.3) and `shadow lint` (T2.6).
 *
 * Zero LLM calls, zero network calls, no API key: structure comes from
 * Markdown headings, routing signals from frontmatter authored by Shadow
 * at write time. See `docs/INDEXING.md` for the full specification.
 */

export type { Bm25Document, Bm25Fields, Bm25Hit } from "./bm25.ts";
export { BM25_B, BM25_FIELD_BOOSTS, BM25_K1, Bm25Index } from "./bm25.ts";
export { byteLength, bytesToText, sliceBytesToText, toBytes } from "./byte-text.ts";
export type { BuildChapterIndexNodeInput } from "./chapter-index.ts";
// ---- building blocks, exported for T2.3/T2.6 and for direct unit testing ---
export { buildChapterIndexNode, SECTION_TOKEN_THRESHOLD } from "./chapter-index.ts";
export { buildIndexDocument } from "./corpus-index.ts";
// ---- errors -----------------------------------------------------------------
export { ChapterIndexBuildError, InvalidRoutingFieldError, ShadowIndexingError } from "./errors.ts";
export {
  combineHashes,
  computeContentHash,
  computeCorpusHash,
  computeSubtreeHash,
  computeVolumeHash,
  formatHash,
  ownText,
} from "./hashing.ts";
export type { FlatHeading, HeadingNode } from "./heading-tree.ts";
export { buildHeadingTree, extractHeadings, parseHeadingTree } from "./heading-tree.ts";
// ---- the build port -------------------------------------------------------
export type { BuildIndexResult, Indexer, MintedId } from "./indexer.ts";
export { StructuralIndexer } from "./indexer.ts";
// ---- the retrieval seam (T2.3 owns the implementation) ---------------------
export type {
  Citation,
  NavigateOptions,
  Navigator,
  RetrievalTrace,
  RetrievalVerdict,
} from "./navigator.ts";
export { normalizeForHashing } from "./normalize.ts";
export {
  coerceConfidence,
  coerceDateLike,
  coerceRoutingText,
  coerceStringArray,
} from "./routing-fields.ts";
export type { SpannedNode } from "./spans.ts";
export { assignSpans, chapterSpan } from "./spans.ts";

export { estimateTokens } from "./tokens.ts";
export type {
  ChapterIndexNode,
  Confidence,
  IndexDocument,
  IndexStats,
  SectionIndexNode,
  Span,
  VolumeIndexNode,
} from "./types.ts";
// ---- index.json schema, owned and versioned by this package ----------------
export { INDEX_SCHEMA_VERSION } from "./types.ts";
export { generateUlid, isValidUlid } from "./ulid.ts";
export type { BuildVolumeIndexNodeInput } from "./volume-index.ts";
export { buildVolumeIndexNode } from "./volume-index.ts";
