/**
 * T4.1/T4.2 measurement entry point.
 *
 *   bun run src/run-eval.ts                    # naive BM25 only — zero LLM calls, always safe/offline
 *   bun run src/run-eval.ts --live              # all three strategies + self-retrieval, real model calls
 *   bun run src/run-eval.ts --live --rounds=2 --top-k=3 --out=results/baseline.live.json
 *
 * Without `--live`, `tree-navigator`/`ablation-no-routing-fields`/self-
 * retrieval are skipped entirely rather than run against a scripted
 * stand-in: a scripted oracle "measures the machinery, not the retrieval
 * quality" (this package's brief), and writing scripted numbers into a
 * file that looks like a quality baseline is exactly what must not happen.
 * Naive BM25 needs no model at all, so it is the only strategy this script
 * ever runs offline — real, honest, zero-LLM numbers either way.
 *
 * `--live` requires the `claude` CLI authenticated via subscription OAuth
 * on this machine (`claude login`), the same requirement
 * `packages/model/src/live-smoke.test.ts` documents — `@shadow/model`'s
 * own guardrail (D5) throws `SubscriptionAuthError` rather than silently
 * falling back to an API key.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ModelNavigationAgent } from "@shadow/indexing";
import { createClaudeCodeStructuredGenerationPort } from "@shadow/model";
import { listChapterIds } from "./corpus/chapter-id.ts";
import { loadFixtureCorpus } from "./corpus/fixture-corpus.ts";
import { loadGoldenSet } from "./golden/golden-set.ts";
import { runComparison, type StrategyReport } from "./harness/harness.ts";
import {
  buildEvaluationReport,
  renderComparisonTable,
  type SelfRetrievalSummary,
  summarizeSelfRetrieval,
  writeResultsFile,
} from "./harness/report.ts";
import { createAblationStrategy } from "./strategies/ablation-strategy.ts";
import { NaiveBm25Strategy } from "./strategies/naive-bm25-strategy.ts";
import { MeasuringStructuredGenerationPort } from "./strategies/token-tracking.ts";
import { TreeNavigatorStrategy } from "./strategies/tree-navigator-strategy.ts";

interface Args {
  readonly live: boolean;
  readonly rounds?: number;
  readonly topK?: number;
  readonly model?: string;
  readonly out?: string;
  readonly selfRetrieval: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let live = false;
  let rounds: number | undefined;
  let topK: number | undefined;
  let model: string | undefined;
  let out: string | undefined;
  let selfRetrieval = true;

  for (const arg of argv) {
    if (arg === "--live") {
      live = true;
    } else if (arg === "--no-self-retrieval") {
      selfRetrieval = false;
    } else if (arg.startsWith("--rounds=")) {
      rounds = Number(arg.slice("--rounds=".length));
    } else if (arg.startsWith("--top-k=")) {
      topK = Number(arg.slice("--top-k=".length));
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
    } else if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
    }
  }

  return { live, rounds, topK, model, out, selfRetrieval };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const corpus = await loadFixtureCorpus();

  try {
    const goldenSet = loadGoldenSet(listChapterIds(corpus.document));
    console.log(
      `Loaded corpus: ${corpus.document.stats.volumes} volumes, ${corpus.document.stats.chapters} chapters, ${corpus.document.stats.tokens} tokens (corpus_hash ${corpus.document.corpus_hash}).`,
    );
    console.log(`Golden set ${goldenSet.version}: ${goldenSet.queries.length} queries.`);

    if (!args.live) {
      console.log(
        "Running naive-bm25 only (pass --live for the tree-navigator/ablation/self-retrieval comparison, which needs real model calls).",
      );
      const naive = new NaiveBm25Strategy(corpus.store, corpus.document, { topK: args.topK });
      const strategies = await runComparison([naive], goldenSet);
      const report = buildEvaluationReport({
        mode: "scripted",
        document: corpus.document,
        goldenSet,
        strategies,
      });
      console.log(`\n${renderComparisonTable(report)}`);

      const outPath = args.out ?? join(import.meta.dir, "../results/naive-bm25-only.json");
      await mkdir(dirname(outPath), { recursive: true });
      await writeResultsFile(outPath, report);
      console.log(`\nWrote ${outPath}`);
      return;
    }

    const modelId = args.model ?? "sonnet";
    const port = createClaudeCodeStructuredGenerationPort({ model: modelId });

    const naive = new NaiveBm25Strategy(corpus.store, corpus.document, { topK: args.topK });

    const navMeasuring = new MeasuringStructuredGenerationPort(port);
    const treeNavigator = new TreeNavigatorStrategy(
      corpus.store,
      corpus.document,
      new ModelNavigationAgent(navMeasuring),
      { rounds: args.rounds, costTracker: navMeasuring },
    );

    const ablationMeasuring = new MeasuringStructuredGenerationPort(port);
    const ablation = await createAblationStrategy(
      corpus.store,
      corpus.document,
      ablationMeasuring,
      {
        rounds: args.rounds,
        costTracker: ablationMeasuring,
      },
    );

    console.log(
      `Live mode: model=${modelId}. Running naive-bm25, tree-navigator, ablation-no-routing-fields...`,
    );
    const strategies: readonly StrategyReport[] = await runComparison(
      [naive, treeNavigator, ablation],
      goldenSet,
    );

    let selfRetrieval: SelfRetrievalSummary | undefined;
    if (args.selfRetrieval) {
      console.log("Running self-retrieval probes (D14) as a label-free coverage metric...");
      selfRetrieval = await summarizeSelfRetrieval(corpus.document, corpus.store, port);
    }

    const report = buildEvaluationReport({
      mode: "live",
      model: modelId,
      authNote:
        "Ran through @shadow/model's createClaudeCodeStructuredGenerationPort, which throws SubscriptionAuthError unless resolved auth is the operator's subscription (apiKeySource: 'none') — reaching a result at all is proof this held (D5).",
      document: corpus.document,
      goldenSet,
      strategies,
      selfRetrieval,
    });

    console.log(`\n${renderComparisonTable(report)}`);

    const outPath = args.out ?? join(import.meta.dir, "../results/baseline.live.json");
    await mkdir(dirname(outPath), { recursive: true });
    await writeResultsFile(outPath, report);
    console.log(`\nWrote ${outPath}`);
  } finally {
    await corpus.cleanup();
  }
}

await main();
