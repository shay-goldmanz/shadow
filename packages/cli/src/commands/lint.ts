/**
 * `shadow lint [--offline]` — run `@shadow/indexing`'s index self-critique
 * (T2.6, D14: discriminability, self-retrieval coverage, orphans,
 * contradictions) against the persisted corpus index, wired to the same
 * `FileMissLog` `shadow find` writes to (`../miss-log.ts`, T2.7) — so
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
 * `deps.port` (this module's own `LintCommandDeps`, distinct from
 * `@shadow/indexing`'s `LintDeps`) is a test-only escape hatch: production
 * (`cli.ts`) never passes it, so every real invocation gets the live
 * adapter; tests inject `FakeStructuredGenerationPort` to exercise the
 * online path deterministically and offline (`bun test`'s own constraint).
 */

import type { VolumeStore } from "@shadow/core";
import { type LintReport, runLint } from "@shadow/indexing";
import type { StructuredGenerationPort } from "@shadow/model";
import { loadCorpusIndex } from "../loaders.ts";
import { createMissLog } from "../miss-log.ts";

export interface LintCommandOptions {
  readonly offline: boolean;
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
  if (errors === 0) {
    return report.offline
      ? [
          "No errors from the offline checks (discriminability, cost-model, orphans).",
          "Run `shadow lint` without --offline to also run self-retrieval and contradiction coverage.",
        ]
      : ["No errors across every check. `shadow misses` still shows any earlier miss-log entries."];
  }
  return [
    "Findings above name the chapters to fix — start with `self-retrieval-miss` and `discriminability` errors.",
    "Run `shadow misses` to see the operator's authoring backlog this run may have added to.",
  ];
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

  if (options.offline) {
    const report = await runLint(document, { missLog }, { offline: true });
    return { ...report, next_steps: nextSteps(report) };
  }

  const port =
    deps.port ??
    (await import("@shadow/model").then(({ createClaudeCodeStructuredGenerationPort }) =>
      createClaudeCodeStructuredGenerationPort(),
    ));

  const report = await runLint(document, { store, port, missLog }, { offline: false });
  return { ...report, next_steps: nextSteps(report) };
}
