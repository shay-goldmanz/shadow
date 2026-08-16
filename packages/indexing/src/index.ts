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
export type { DisagreementSignal, RollupPromotion } from "./bm25-fallback.ts";
export {
  bm25Fallback,
  buildFallbackIndex,
  detectDisagreement,
  rollupFallbackPromotion,
} from "./bm25-fallback.ts";
export { byteLength, bytesToText, sliceBytesToText, toBytes } from "./byte-text.ts";
export type { BuildChapterIndexNodeInput } from "./chapter-index.ts";
// ---- building blocks, exported for T2.3/T2.6 and for direct unit testing ---
export { buildChapterIndexNode, SECTION_TOKEN_THRESHOLD } from "./chapter-index.ts";
// ---- STAGE 4 (EXPAND): ancestor closure + indented outline rendering -------
export type { FlatNode, NodeKind } from "./closure.ts";
export { ancestorClosure, flattenIndex, renderOutline } from "./closure.ts";
export { buildIndexDocument } from "./corpus-index.ts";
// ---- errors -----------------------------------------------------------------
export {
  ChapterIndexBuildError,
  InvalidRoutingFieldError,
  LintConfigError,
  NodeNotFoundError,
  ShadowIndexingError,
} from "./errors.ts";
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
// ---- OKF index.md / log.md generation (Phase 2) ----------------------------
export { generateRootIndexMd, generateVolumeIndexMd } from "./index-md.ts";
export { generateRootLogMd, generateVolumeLogMd } from "./log-md.ts";
// ---- OKF conformance validation (Phase 3) -----------------------------------
export type {
  OkfBundleArtifacts,
  OkfChapterRecord,
  OkfConformanceInput,
  OkfVolumeRecord,
} from "./lint-okf.ts";
export { checkOkfConformance, okfConformanceCheck } from "./lint-okf.ts";
// ---- OKF conformance input construction (the I/O side of the check) -------
export { loadOkfBundleArtifacts, okfChapterRecordsFrom, okfVolumeRecordsFrom } from "./okf-input.ts";
// ---- the build port -------------------------------------------------------
export type { BuildIndexResult, Indexer, MintedId } from "./indexer.ts";
export { StructuralIndexer } from "./indexer.ts";
export type { LintDeps, LintOptions, LintReport } from "./lint.ts";
// ---- shadow lint (T2.6, D14): index self-critique, offline, no query path -
export { runLint } from "./lint.ts";
export type { ContradictionFindingData, ContradictionOptions } from "./lint-contradiction.ts";
export { checkContradiction, DEFAULT_OVERLAP_THRESHOLD } from "./lint-contradiction.ts";
export type { CostModelFindingData, CostModelOptions, CostNode } from "./lint-cost-model.ts";
export {
  checkChapterCost,
  costModelCheck,
  DEFAULT_ROUTING_ROW_TOKENS,
  treeCost,
} from "./lint-cost-model.ts";
export type {
  DiscriminabilityFindingData,
  DiscriminabilityOptions,
} from "./lint-discriminability.ts";
export {
  checkDiscriminability,
  DEFAULT_DISCRIMINABILITY_THRESHOLD,
  discriminabilityCheck,
} from "./lint-discriminability.ts";
export type { MissLogEntry, MissLogStore } from "./lint-miss-log.ts";
export { FileMissLog, InMemoryMissLog } from "./lint-miss-log.ts";
export { ModelNavigationAgent } from "./lint-model-navigation-agent.ts";
export type { OrphanFindingData } from "./lint-orphan.ts";
export { checkOrphans } from "./lint-orphan.ts";
export { pairs } from "./lint-pairs.ts";
export type {
  SelfRetrievalOptions,
  SelfRetrievalProbe,
  SelfRetrievalRunResult,
} from "./lint-self-retrieval.ts";
export { checkSelfRetrieval } from "./lint-self-retrieval.ts";
export { tokenize, tokenSetJaccard } from "./lint-similarity.ts";
export type {
  LintCheck,
  LintCheckResult,
  LintFinding,
  LintSeverity,
} from "./lint-types.ts";
export { runLintChecks } from "./lint-types.ts";
// ---- the retrieval port and its default implementation (T2.3) -------------
export type {
  ChapterIndexRow,
  Citation,
  GradePayload,
  NavigateOptions,
  NavigatePayload,
  NavigationAgent,
  Navigator,
  Rejection,
  RetrievalTrace,
  RetrievalVerdict,
  RouteDecision,
  RoutePayload,
  TraceStep,
  VolumeManifestRow,
} from "./navigator.ts";
export { ReasoningNavigator } from "./navigator.ts";
export { normalizeForHashing } from "./normalize.ts";
// ---- passage assembly, document order (not relevance order) ----------------
export type { Passage, PassageSource } from "./passages.ts";
export { assemblePassages } from "./passages.ts";
export type { BuildNavigatePayloadOptions } from "./payloads.ts";
// ---- STAGE 2/3 payload preparation (route + navigate) ----------------------
export {
  buildNavigatePayload,
  buildRoutePayload,
  CHAPTER_INDEX_THRESHOLD,
  shouldSkipRouting,
} from "./payloads.ts";
// ---- STAGE 4 (READ): resolve a node_id's structural context and body -------
export type { ReadContext, ReadResult } from "./read.ts";
export { readNode, resolveReadContext } from "./read.ts";
// ---- STAGE 1: the 1/√(N+1)·Σ rollup -----------------------------------------
export { rollupScore } from "./rollup.ts";
// ---- the round loop: visited[] + rejections, bounded at 3 rounds -----------
export type { NavigateDecision, RoundState } from "./round-loop.ts";
export { advanceRound, canContinue, initialRoundState, MAX_ROUNDS } from "./round-loop.ts";
export {
  coerceConfidence,
  coerceDateLike,
  coerceRoutingText,
  coerceStringArray,
} from "./routing-fields.ts";
export type { SpannedNode } from "./spans.ts";
export { assignSpans, chapterSpan } from "./spans.ts";

export { estimateTokens } from "./tokens.ts";
// ---- the retrieval trace and its citations ----------------------------------
export { buildTrace, citationForChapter, citationForSection } from "./trace.ts";
export type {
  ChapterIndexNode,
  Confidence,
  IndexDocument,
  IndexStats,
  SectionIndexNode,
  Span,
  VolumeIndexDocument,
  VolumeIndexNode,
} from "./types.ts";
// ---- index.json schema, owned and versioned by this package ----------------
export { INDEX_SCHEMA_VERSION } from "./types.ts";
export { generateUlid, isValidUlid } from "./ulid.ts";
export type { BuildVolumeIndexNodeInput } from "./volume-index.ts";
export { buildVolumeIndexNode } from "./volume-index.ts";
