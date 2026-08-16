/**
 * `shadow lint [--offline] [--okf]` — run `@shadow/indexing`'s index
 * self-critique (T2.6, D14: discriminability, self-retrieval coverage,
 * orphans, contradictions) against the persisted corpus index, wired to the
 * same `FileMissLog` `shadow find` writes to (`../miss-log.ts`, T2.7) — so
 * self-retrieval's `not-in-corpus` verdicts land in the operator's one
 * backlog instead of nowhere.
 *
 * Online (the default, matching `runLint`'s own default) needs a real
 * model call per self-retrieval/contradiction probe, so this is the one
 * place in `@shadow/cli` that constructs `@shadow/model`'s real adapter —
 * lazily (dynamic `import`), so no other command, and no offline test,
 * ever loads it. `--offline` runs only the zero-LLM checks (discriminability,
 * cost-model, orphans), matching `runLint`'s own `--offline` guarantee:
 * `deps.port` is never constructed at all in that branch.
 *
 * `--okf` runs the zero-LLM OKF v0.2 conformance check (`checkOkfConformance`)
 * alongside whatever else this invocation runs — it composes with
 * `--offline` because `runLint` appends the OKF check outside its
 * offline/online branch entirely. This command owns the one piece
 * `checkOkfConformance` itself deliberately doesn't: building its input.
 * `@shadow/indexing`'s `okfChapterRecordsFrom`/`okfVolumeRecordsFrom` are
 * pure mappers over the already-loaded index document plus `store.listVolumes`/
 * `listChapters`; `loadOkfBundleArtifacts(root)` is the one I/O read (the
 * bundle-root `index.md`/`log.md` `StructuralIndexer` writes on reindex).
 *
 * `deps.port` (this module's own `LintCommandDeps`, distinct from
 * `@shadow/indexing`'s `LintDeps`) is a test-only escape hatch: production
 * (`cli.ts`) never passes it, so every real invocation gets the live
 * adapter; tests inject `FakeStructuredGenerationPort` to exercise the
 * online path deterministically and offline (`bun test`'s own constraint).
 */

import type { VolumeStore } from "@shadow/core";
import {
  type LintReport,
  loadOkfBundleArtifacts,
  okfChapterRecordsFrom,
  okfVolumeRecordsFrom,
  runLint,
} from "@shadow/indexing";
import type { StructuredGenerationPort } from "@shadow/model";
import { loadCorpusIndex } from "../loaders.ts";
import { createMissLog } from "../miss-log.ts";

export interface LintCommandOptions {
  readonly offline: boolean;
  /** Run the OKF v0.2 conformance check (`checkOkfConformance`) alongside whatever else this invocation runs. Zero-LLM — composes with `offline`. */
  readonly okf: boolean;
}

export interface LintCommandDeps {
  /** Test-only override for the structured-generation port. Omit in production — the real adapter is constructed lazily. */
  readonly port?: StructuredGenerationPort;
}

export interface LintCommandResult extends LintReport {
  readonly next_steps: readonly string[];
}

function errorCount(report: LintReport): number {
  return report.checks.reduce(
    (total, check) => total + check.findings.filter((f) => f.severity === "error").length,
    0,
  );
}

function nextSteps(report: LintReport): readonly string[] {
  const errors = errorCount(report);
  const ranOkf = report.checks.some((check) => check.checkId === "okf-conformance");
  if (errors === 0) {
    return report.offline
      ? [
          `No errors from the offline checks (discriminability, cost-model, orphans${ranOkf ? ", okf-conformance" : ""}).`,
          "Run `shadow lint` without --offline to also run self-retrieval and contradiction coverage.",
        ]
      : ["No errors across every check. `shadow misses` still shows any earlier miss-log entries."];
  }
  return [
    "Findings above name the chapters to fix — start with `self-retrieval-miss` and `discriminability` errors.",
    "Run `shadow misses` to see the operator's authoring backlog this run may have added to.",
  ];
}

/**
 * Build `runLint`'s `LintOptions.okf` input bag: the pure record mappers
 * run over `document` plus every volume's chapters loaded from `store`,
 * and the one I/O read (`loadOkfBundleArtifacts`) over `root`'s bundle-root
 * `index.md`/`log.md`.
 */
async function buildOkfInput(
  store: VolumeStore,
  root: string,
  document: Awaited<ReturnType<typeof loadCorpusIndex>>,
): Promise<NonNullable<Parameters<typeof runLint>[2]>["okf"]> {
  const volumes = await store.listVolumes();
  const chaptersByVolume = new Map(
    await Promise.all(
      volumes.map(async (volume) => [volume.slug, await store.listChapters(volume.slug)] as const),
    ),
  );
  const artifacts = await loadOkfBundleArtifacts(root);

  return {
    chapters: okfChapterRecordsFrom(document, chaptersByVolume),
    volumes: okfVolumeRecordsFrom(document, volumes),
    artifacts,
  };
}

/** @throws {IndexMissingError} if `shadow index` has never been run. */
export async function runLintCommand(
  store: VolumeStore,
  root: string,
  options: LintCommandOptions,
  deps: LintCommandDeps = {},
): Promise<LintCommandResult> {
  const document = await loadCorpusIndex(store);
  const missLog = createMissLog(root);
  const okf = options.okf ? await buildOkfInput(store, root, document) : undefined;

  if (options.offline) {
    const report = await runLint(document, { missLog }, { offline: true, okf });
    return { ...report, next_steps: nextSteps(report) };
  }

  const port =
    deps.port ??
    (await import("@shadow/model").then(({ createClaudeCodeStructuredGenerationPort }) =>
      createClaudeCodeStructuredGenerationPort(),
    ));

  const report = await runLint(document, { store, port, missLog }, { offline: false, okf });
  return { ...report, next_steps: nextSteps(report) };
}
