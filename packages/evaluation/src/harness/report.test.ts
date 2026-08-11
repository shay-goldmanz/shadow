import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeStructuredGenerationPort } from "@shadow/model";
import { GOLDEN_SET_VERSION } from "../golden/golden-set-data.ts";
import type { GoldenSet } from "../golden/types.ts";
import type { RetrievalStrategy, StrategyQueryResult } from "../strategies/strategy.ts";
import { ZERO_TOKEN_COST } from "../strategies/token-tracking.ts";
import { withTinyCorpus } from "../test-helpers.ts";
import { runStrategy } from "./harness.ts";
import {
  buildEvaluationReport,
  REPORT_SCHEMA_VERSION,
  renderComparisonTable,
  summarizeSelfRetrieval,
  writeResultsFile,
} from "./report.ts";

const GOLDEN_SET: GoldenSet = {
  version: GOLDEN_SET_VERSION,
  queries: [{ id: "q1", query: "find a", relevant: ["vol/a"], tags: ["single-chapter"] }],
};

class StubStrategy implements RetrievalStrategy {
  readonly name = "stub";
  readonly description = "test stub";
  async retrieve(): Promise<StrategyQueryResult> {
    return { retrieved: ["vol/a"], verdict: "found", tokenCost: ZERO_TOKEN_COST };
  }
}

function fixedNow(): Date {
  return new Date("2026-01-01T00:00:00.000Z");
}

describe("buildEvaluationReport", () => {
  test("assembles a stable, versioned report from a strategy run", async () => {
    await withTinyCorpus(async ({ document }) => {
      const strategyReport = await runStrategy(new StubStrategy(), GOLDEN_SET);

      const report = buildEvaluationReport({
        mode: "scripted",
        document,
        goldenSet: GOLDEN_SET,
        strategies: [strategyReport],
        now: fixedNow,
      });

      expect(report.reportSchemaVersion).toBe(REPORT_SCHEMA_VERSION);
      expect(report.generatedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(report.mode).toBe("scripted");
      expect(report.model).toBeUndefined();
      expect(report.corpus.chapters).toBe(document.stats.chapters);
      expect(report.corpus.corpusHash).toBe(document.corpus_hash);
      expect(report.goldenSetVersion).toBe(GOLDEN_SET_VERSION);
      expect(report.goldenSetSize).toBe(1);
      expect(report.strategies).toHaveLength(1);
    });
  });

  test("live mode carries model and authNote through", async () => {
    await withTinyCorpus(async ({ document }) => {
      const strategyReport = await runStrategy(new StubStrategy(), GOLDEN_SET);
      const report = buildEvaluationReport({
        mode: "live",
        model: "sonnet",
        authNote: "ran on subscription auth",
        document,
        goldenSet: GOLDEN_SET,
        strategies: [strategyReport],
      });
      expect(report.mode).toBe("live");
      expect(report.model).toBe("sonnet");
      expect(report.authNote).toBe("ran on subscription auth");
    });
  });
});

describe("renderComparisonTable", () => {
  test("renders one row per strategy with metric and token-cost columns", async () => {
    await withTinyCorpus(async ({ document }) => {
      const strategyReport = await runStrategy(new StubStrategy(), GOLDEN_SET);
      const report = buildEvaluationReport({
        mode: "scripted",
        document,
        goldenSet: GOLDEN_SET,
        strategies: [strategyReport],
      });
      const table = renderComparisonTable(report);
      expect(table).toContain("stub");
      expect(table).toContain("holesRatio");
      expect(table).toContain("LLM calls");
    });
  });

  test("appends a self-retrieval summary line when present", async () => {
    await withTinyCorpus(async ({ document }) => {
      const strategyReport = await runStrategy(new StubStrategy(), GOLDEN_SET);
      const report = buildEvaluationReport({
        mode: "scripted",
        document,
        goldenSet: GOLDEN_SET,
        strategies: [strategyReport],
        selfRetrieval: {
          totalProbes: 3,
          retrievedSelfCount: 2,
          retrievedSelfRate: 2 / 3,
          missCount: 0,
          probes: [],
        },
      });
      const table = renderComparisonTable(report);
      expect(table).toContain("Self-retrieval coverage");
      expect(table).toContain("2/3");
    });
  });
});

describe("writeResultsFile", () => {
  test("round-trips a report through JSON on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shadow-eval-report-test-"));
    try {
      await withTinyCorpus(async ({ document }) => {
        const strategyReport = await runStrategy(new StubStrategy(), GOLDEN_SET);
        const report = buildEvaluationReport({
          mode: "scripted",
          document,
          goldenSet: GOLDEN_SET,
          strategies: [strategyReport],
        });
        const path = join(dir, "report.json");
        await writeResultsFile(path, report);
        const raw = await readFile(path, "utf8");
        expect(raw.endsWith("\n")).toBe(true);
        expect(JSON.parse(raw)).toEqual(JSON.parse(JSON.stringify(report)));
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("summarizeSelfRetrieval", () => {
  test("reduces checkSelfRetrieval's probes into rate/count summary fields", async () => {
    await withTinyCorpus(async ({ store, document }) => {
      // Deterministic fake: always propose the first chapter row listed in
      // the navigate prompt, and always grade "sufficient" — so exactly one
      // chapter (whichever is first in document order) retrieves itself,
      // and the other two probes retrieve the wrong chapter instead.
      const port = new FakeStructuredGenerationPort((request) => {
        if (request.schemaName === "plausible_task") {
          return { task: "a plausible task" };
        }
        if (request.schemaName === "navigate_decision") {
          const match = /- (\S+):/.exec(request.prompt);
          return { chosen: match ? [match[1]] : [], rejected: [] };
        }
        return { verdict: "sufficient" };
      });

      const summary = await summarizeSelfRetrieval(document, store, port);
      expect(summary.totalProbes).toBe(3);
      expect(summary.retrievedSelfCount).toBe(1);
      expect(summary.retrievedSelfRate).toBeCloseTo(1 / 3, 10);
      expect(summary.missCount).toBe(0);
      expect(summary.probes).toHaveLength(3);
    });
  });
});
