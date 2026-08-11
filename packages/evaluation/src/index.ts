/**
 * @shadow/evaluation — measured indexing effectiveness (T4.1/T4.2).
 *
 * A fixed, versioned fixture corpus (`fixtures/corpus`) plus a golden query
 * set score three retrieval strategies — naive flat BM25, the tree
 * navigator (our design, D11/D11a), and an ablation with authored routing
 * metadata stripped from what the agent sees — on the same corpus and
 * queries. This is what turns `docs/DECISIONS.md` D11a's "or better" claim
 * from an assertion into a measurement (`ARCHITECTURE.md`'s invariant: "a
 * baseline is established before the index is tuned").
 *
 * See `run-eval.ts` for the CLI entry point (`bun run eval` / `bun run eval
 * --live`) and `docs/PLAN.md` T4.1/T4.2 for the brief this package was
 * built against.
 */

export const PACKAGE_NAME = "@shadow/evaluation";

// ---- corpus: the fixed, versioned fixture corpus --------------------------
export type { ChapterId } from "./corpus/chapter-id.ts";
export {
  buildNodeToChapterMap,
  chapterId,
  listChapterIds,
  resolveChapterId,
} from "./corpus/chapter-id.ts";
export type { LoadedCorpus } from "./corpus/fixture-corpus.ts";
export { FIXTURE_CORPUS_PATH, loadFixtureCorpus } from "./corpus/fixture-corpus.ts";

// ---- errors -----------------------------------------------------------------
export {
  CorpusLoadError,
  GoldenSetValidationError,
  LiveModeConfigError,
  ShadowEvaluationError,
} from "./errors.ts";
export { loadGoldenSet, validateGoldenSet } from "./golden/golden-set.ts";
// ---- golden set: queries paired with known-correct chapters ---------------
export { GOLDEN_QUERIES, GOLDEN_SET_VERSION } from "./golden/golden-set-data.ts";
export type { GoldenQuery, GoldenQueryTag, GoldenSet } from "./golden/types.ts";
// ---- harness: run a strategy (or every strategy) over the golden set ------
export type { QueryReportEntry, StrategyReport } from "./harness/harness.ts";
export { runComparison, runStrategy } from "./harness/harness.ts";
export type {
  BuildEvaluationReportInput,
  CorpusSummary,
  EvaluationMode,
  EvaluationReport,
  SelfRetrievalSummary,
} from "./harness/report.ts";
export {
  buildEvaluationReport,
  REPORT_SCHEMA_VERSION,
  renderComparisonTable,
  summarizeSelfRetrieval,
  writeResultsFile,
} from "./harness/report.ts";
// ---- metrics: precision, recall, MRR, nDCG, holesRatio (D17) --------------
export type { AggregateMetrics, QueryJudgment, QueryScore } from "./metrics/metrics.ts";
export { aggregateScores, scoreQuery } from "./metrics/metrics.ts";
// ---- strategies: the RetrievalStrategy port and its three implementations -
export {
  ABLATION_EXCERPT_CHARS,
  AblationNavigationAgent,
  AblationStrategy,
  buildAblationBodyExcerpts,
  createAblationStrategy,
} from "./strategies/ablation-strategy.ts";
export type { NaiveBm25StrategyOptions } from "./strategies/naive-bm25-strategy.ts";
export { NaiveBm25Strategy } from "./strategies/naive-bm25-strategy.ts";
export type {
  RetrievalStrategy,
  StrategyQueryResult,
  StrategyVerdict,
} from "./strategies/strategy.ts";
export { dedupeChapterIds } from "./strategies/strategy.ts";
export type {
  TokenCost,
  TokenCostTracker,
} from "./strategies/token-tracking.ts";
export {
  addTokenCost,
  MeasuringStructuredGenerationPort,
  ZERO_TOKEN_COST,
} from "./strategies/token-tracking.ts";
export type { TreeNavigatorStrategyOptions } from "./strategies/tree-navigator-strategy.ts";
export { TreeNavigatorStrategy } from "./strategies/tree-navigator-strategy.ts";
