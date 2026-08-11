/**
 * `shadow lint` (T2.6, D14) — the top-level orchestrator composing all six
 * checks over a built `IndexDocument`. Runs **offline and never in the
 * query path** (D14) — this module is not imported by `navigator.ts` or
 * `indexer.ts`, and nothing in the retrieval path imports it either.
 *
 * **`--offline` enforcement.** `options.offline` is decided *before* any
 * check runs, not after: when set, `deps.port` (the
 * `StructuredGenerationPort`) is never read, never passed to anything, and
 * the model-backed checks (2 self-retrieval, 4 contradiction) are not even
 * constructed — `runLint`'s offline branch calls only
 * `checkDiscriminability`, `checkChapterCost`, and `checkOrphans`, all of
 * which have no `@shadow/model` import anywhere in their module graph. A
 * caller can therefore run `runLint(document, {}, { offline: true })` with
 * no `store` or `port` at all (see the "no deps" test in `lint.test.ts`)
 * and it is *structurally* impossible for a model call to happen, not
 * merely unlikely — the code path that would make one is not on the call
 * stack.
 *
 * Online, self-retrieval runs first: its output is both a `LintCheckResult`
 * (findings) and a `coverage` set (every node_id any probe cited across the
 * run), which orphan detection (check 3) then consumes — the one place two
 * checks are sequenced rather than independent, and why `runLint` exists
 * as more than "call every check with the same input" (`lint-orphan.ts`'s
 * doc comment explains why coverage has to come from *somewhere*).
 */

import type { VolumeStore } from "@shadow/core";
import type { StructuredGenerationPort } from "@shadow/model";
import { LintConfigError } from "./errors.ts";
import { type ContradictionOptions, checkContradiction } from "./lint-contradiction.ts";
import { type CostModelOptions, checkChapterCost } from "./lint-cost-model.ts";
import { checkDiscriminability, type DiscriminabilityOptions } from "./lint-discriminability.ts";
import type { MissLogStore } from "./lint-miss-log.ts";
import { checkOrphans } from "./lint-orphan.ts";
import { checkSelfRetrieval, type SelfRetrievalProbe } from "./lint-self-retrieval.ts";
import type { LintCheckResult } from "./lint-types.ts";
import type { IndexDocument } from "./types.ts";

/** Only required when `options.offline` is not set — the pure checks (1/3/6) need neither. */
export interface LintDeps {
  readonly store?: VolumeStore;
  readonly port?: StructuredGenerationPort;
  /** Every `not-in-corpus` self-retrieval verdict is appended here (check 5). Omit to skip miss logging entirely. */
  readonly missLog?: MissLogStore;
}

export interface LintOptions {
  /** Run only the pure checks (1 discriminability, 3 orphan, 6 cost-model) — zero model calls, `deps.store`/`deps.port` not required. Defaults to `false`. */
  readonly offline?: boolean;
  readonly discriminability?: DiscriminabilityOptions;
  readonly costModel?: CostModelOptions;
  readonly contradiction?: ContradictionOptions;
  /** Injectable clock, threaded through to check 2's miss-log timestamps. */
  readonly now?: () => Date;
}

export interface LintReport {
  readonly offline: boolean;
  /** One result per check that ran — 3 entries offline, 5 online. */
  readonly checks: readonly LintCheckResult[];
  /** Every self-retrieval probe run this pass. Empty when `offline`. `@shadow/evaluation` (T4.1) consumes this as a metric. */
  readonly probes: readonly SelfRetrievalProbe[];
}

/** Run `shadow lint` over `document`. See this module's doc comment for the `--offline` guarantee. */
export async function runLint(
  document: IndexDocument,
  deps: LintDeps = {},
  options: LintOptions = {},
): Promise<LintReport> {
  const offline = options.offline ?? false;
  const checks: LintCheckResult[] = [
    checkDiscriminability(document, options.discriminability),
    checkChapterCost(document, options.costModel),
  ];
  let probes: readonly SelfRetrievalProbe[] = [];
  let coverage: ReadonlySet<string> = new Set();

  if (!offline) {
    if (!deps.store || !deps.port) {
      throw new LintConfigError(
        "runLint requires deps.store and deps.port unless options.offline is set",
      );
    }
    const selfRetrieval = await checkSelfRetrieval(document, deps.store, deps.port, {
      missLog: deps.missLog,
      now: options.now,
    });
    checks.push(selfRetrieval.result);
    probes = selfRetrieval.probes;
    coverage = selfRetrieval.coverage;

    checks.push(await checkContradiction(document, deps.store, deps.port, options.contradiction));
  }

  checks.push(checkOrphans(document, coverage));

  return { offline, checks, probes };
}
