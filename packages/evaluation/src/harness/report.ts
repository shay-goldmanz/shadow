/**
 * Assembling and rendering the final `EvaluationReport` (T4.1/T4.2):
 * structured, versioned, and written to disk so regressions show up as a
 * diff — never just printed and discarded ("Results are structured data,
 * reproducible, and written to a versioned results file", this package's
 * own design brief).
 *
 * Also where `SelfRetrievalProbe` (D14, `@shadow/indexing`) gets consumed
 * as the label-free coverage metric T4.1 asks for: it needs zero golden-set
 * judgments (`checkSelfRetrieval` generates its own plausible task per
 * chapter from that chapter's own `when_to_use`), so it is a genuinely
 * independent signal from the golden-set-scored strategy comparison above
 * it — a strategy can win on the golden set while self-retrieval reveals
 * chapters that can't even find themselves.
 */

import type { VolumeStore } from "@shadow/core";
import { checkSelfRetrieval, type IndexDocument, type SelfRetrievalProbe } from "@shadow/indexing";
import type { StructuredGenerationPort } from "@shadow/model";
import type { GoldenSet } from "../golden/types.ts";
import type { StrategyReport } from "./harness.ts";

export interface SelfRetrievalSummary {
  readonly totalProbes: number;
  readonly retrievedSelfCount: number;
  /** `retrievedSelfCount / totalProbes` — the label-free coverage figure. */
  readonly retrievedSelfRate: number;
  /** How many probes came back `not-in-corpus` — a chapter that cannot even retrieve itself from a task generated off its own `when_to_use`. */
  readonly missCount: number;
  readonly probes: readonly SelfRetrievalProbe[];
}

/** Run `checkSelfRetrieval` (D14, `@shadow/indexing`) and reduce it to the summary this report carries. Requires a real (or fake) `StructuredGenerationPort` — self-retrieval generates a plausible task per chapter and then runs the full navigator, so it is inherently model-backed, unlike the pure metrics in `metrics/metrics.ts`. */
export async function summarizeSelfRetrieval(
  document: IndexDocument,
  store: VolumeStore,
  port: StructuredGenerationPort,
): Promise<SelfRetrievalSummary> {
  const { probes } = await checkSelfRetrieval(document, store, port);
  const retrievedSelfCount = probes.filter((probe) => probe.retrievedSelf).length;
  const missCount = probes.filter((probe) => probe.verdict.kind === "not-in-corpus").length;
  return {
    totalProbes: probes.length,
    retrievedSelfCount,
    retrievedSelfRate: probes.length === 0 ? 0 : retrievedSelfCount / probes.length,
    missCount,
    probes,
  };
}

export type EvaluationMode = "scripted" | "live";

/** Current `EvaluationReport` shape version — bump if the report's structure changes, independent of `goldenSetVersion` (query content) or `corpus.corpusHash` (fixture content). */
export const REPORT_SCHEMA_VERSION = 1;

export interface CorpusSummary {
  readonly volumes: number;
  readonly chapters: number;
  readonly tokens: number;
  readonly corpusHash: string;
}

export interface EvaluationReport {
  readonly reportSchemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly generatedAt: string;
  /**
   * `"scripted"` — every model-backed decision came from
   * `@shadow/model`'s fakes (a deterministic responder or a hand-scripted
   * `NavigationAgent`); this measures the harness's own machinery, never
   * retrieval quality. `"live"` — decisions came from a real model call
   * through `@shadow/model`'s structured-generation port. Every consumer
   * of this report (this package's own README-less doc string included)
   * must treat these as non-interchangeable.
   */
  readonly mode: EvaluationMode;
  /** The model id used for every model-backed call, when `mode === "live"` (e.g. `"sonnet"`, `@shadow/model`'s adapter default). `undefined` for a scripted run — there is no model. */
  readonly model?: string;
  /** Present only for a live run: confirmation that it ran on the operator's subscription (D5), not an API key. */
  readonly authNote?: string;
  readonly corpus: CorpusSummary;
  readonly goldenSetVersion: string;
  readonly goldenSetSize: number;
  readonly strategies: readonly StrategyReport[];
  readonly selfRetrieval?: SelfRetrievalSummary;
}

export interface BuildEvaluationReportInput {
  readonly mode: EvaluationMode;
  readonly model?: string;
  readonly authNote?: string;
  readonly document: IndexDocument;
  readonly goldenSet: GoldenSet;
  readonly strategies: readonly StrategyReport[];
  readonly selfRetrieval?: SelfRetrievalSummary;
  /** Injectable clock for deterministic tests. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

export function buildEvaluationReport(input: BuildEvaluationReportInput): EvaluationReport {
  const now = input.now ?? (() => new Date());
  return {
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: now().toISOString(),
    mode: input.mode,
    model: input.model,
    authNote: input.authNote,
    corpus: {
      volumes: input.document.stats.volumes,
      chapters: input.document.stats.chapters,
      tokens: input.document.stats.tokens,
      corpusHash: input.document.corpus_hash,
    },
    goldenSetVersion: input.goldenSet.version,
    goldenSetSize: input.goldenSet.queries.length,
    strategies: input.strategies,
    selfRetrieval: input.selfRetrieval,
  };
}

function fmt(value: number | undefined, digits = 3): string {
  return value === undefined ? "—" : value.toFixed(digits);
}

/** Render the strategy comparison as a Markdown table — quality metrics, `holesRatio` (D17), and token cost side by side, since D11's claim is economic, not accuracy-only. */
export function renderComparisonTable(report: EvaluationReport): string {
  const header =
    "| strategy | precision | recall | MRR | nDCG | holesRatio | correctRejection | est.prompt tok | actual tok (in+out) | LLM calls |";
  const divider = "|---|---|---|---|---|---|---|---|---|---|";
  const rows = report.strategies.map((strategy) => {
    const m = strategy.metrics;
    const actualTokens =
      strategy.tokenCost.usage.inputTokens + strategy.tokenCost.usage.outputTokens;
    return `| ${strategy.strategyName} | ${fmt(m.meanPrecision)} | ${fmt(m.meanRecall)} | ${fmt(m.mrr)} | ${fmt(m.meanNdcg)} | ${fmt(m.holesRatio)} | ${fmt(m.correctRejectionRate)} | ${strategy.tokenCost.estimatedPromptTokens} | ${actualTokens} | ${strategy.tokenCost.llmCalls} |`;
  });
  const lines = [header, divider, ...rows];
  if (report.selfRetrieval) {
    const sr = report.selfRetrieval;
    lines.push(
      "",
      `Self-retrieval coverage (label-free, D14): ${sr.retrievedSelfCount}/${sr.totalProbes} chapters retrieved themselves (${fmt(sr.retrievedSelfRate)}), ${sr.missCount} not-in-corpus misses.`,
    );
  }
  return lines.join("\n");
}

/** Write `report` to `path` as pretty-printed, trailing-newline-terminated JSON — stable formatting so a regression shows up as a real diff, not reformatting noise. */
export async function writeResultsFile(path: string, report: EvaluationReport): Promise<void> {
  await Bun.write(path, `${JSON.stringify(report, null, 2)}\n`);
}
