/**
 * `shadow lint` (T2.6, D14) — the composition model every check plugs into.
 *
 * Mirrors `@shadow/evidence`'s `EvidenceCheck`/`CheckOutcome` shape (see its
 * `checks/types.ts`) on purpose — that package already solved "the audit is
 * a composition of independent checks; adding one must not modify the
 * others" for the same kind of problem, and lint's checks are shaped
 * identically: a fixed input bag in, a list of structured findings out. This
 * package does **not** import `@shadow/evidence`, though — the pattern is
 * copied, not the code.
 *
 * The one place lint's shape diverges: `LintCheck.requiresModel` is a static
 * property (not a per-run `blocking` flag like evidence's checks), because
 * it is what lets `runLint`'s `--offline` mode filter the check list
 * *before* running anything rather than run-and-discard. See `lint.ts`.
 */

export type LintSeverity = "error" | "warning" | "info";

/** One structured finding from a check. Never a printed string — T3.1 (CLI) renders these, T4.1 (evaluation) consumes `self-retrieval` findings as a metric. */
export interface LintFinding {
  /** Machine-readable, stable — e.g. `"discriminability-collision"`, `"self-retrieval-miss"`, `"orphan-chapter"`, `"contradiction"`, `"chapter-too-large"`. Callers may branch on it. */
  readonly code: string;
  readonly severity: LintSeverity;
  readonly message: string;
  /** The node_id(s) this finding concerns — 1 for a per-chapter finding, 2 for a pairwise finding (discriminability, contradiction), 0 for a corpus-wide finding. */
  readonly nodeIds: readonly string[];
  /** Check-specific structured payload (e.g. the computed similarity score, the generated probe task), opaque to the composition layer. */
  readonly data?: unknown;
}

/** The result of running one check over the corpus. */
export interface LintCheckResult {
  /** e.g. `"discriminability"`, `"self-retrieval"`, `"orphan"`, `"contradiction"`, `"cost-model"`. */
  readonly checkId: string;
  /** Whether this check made at least one call through `@shadow/model`'s structured-generation port. Static per check (not per finding) — `runLint`'s `--offline` mode uses this to decide which checks to run *before* running any of them, never by discarding a model-backed result after the fact. */
  readonly requiresModel: boolean;
  readonly findings: readonly LintFinding[];
}

/** A single check, generic over whatever input bag it needs — same shape as `@shadow/evidence`'s `EvidenceCheck<TInput>`. */
export interface LintCheck<TInput> {
  readonly id: string;
  readonly requiresModel: boolean;
  run(input: TInput): LintCheckResult | Promise<LintCheckResult>;
}

/** Run a list of checks over one shared input and collect their results, in order. */
export async function runLintChecks<TInput>(
  checks: readonly LintCheck<TInput>[],
  input: TInput,
): Promise<LintCheckResult[]> {
  const results: LintCheckResult[] = [];
  for (const check of checks) {
    results.push(await check.run(input));
  }
  return results;
}
