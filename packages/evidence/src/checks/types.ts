/**
 * The check/audit composition model. This is the answer to "the audit is a
 * composition of checks... model it so Tier 2 checks are added without
 * modifying Tier 0" (Open/Closed): every check — Tier 0 or Tier 2 —
 * produces the same `CheckOutcome` shape and is run by the same
 * `runChecks`/`verdictFromOutcomes` pair. Tier 0 checks in `./` implement
 * `EvidenceCheck<Tier0AuditInput>` today; `@shadow/evidence`'s Tier 2 port
 * consumers (T2.4/T2.5) implement `EvidenceCheck` against their own input
 * shape and are appended to whatever list `runChecks` is given — nothing in
 * this file, or in the Tier 0 checks, has to change for that to work.
 */

/** One structural finding from a check — a failure if the check is blocking, a warning otherwise. */
export interface CheckIssue {
  /** Machine-readable, e.g. `"orphan-marker"`, `"supports-cycle"`. Stable — callers may branch on it. */
  readonly code: string;
  readonly message: string;
  /** The claim label this issue concerns, if any. */
  readonly label?: string;
}

/** The result of running one check over one chapter's evidence. */
export interface CheckOutcome {
  /** e.g. `"C1a"`, `"C2"`, `"operator-verification"`. */
  readonly checkId: string;
  readonly tier: 0 | 2;
  /** Whether a failure here blocks chapter publication (`docs/EVIDENCE.md`'s verdict rule) or only warns (e.g. C5). */
  readonly blocking: boolean;
  readonly passed: boolean;
  readonly issues: readonly CheckIssue[];
  /** Non-blocking findings, surfaced even on a passing check (e.g. anchored-fuzzy spans). */
  readonly warnings?: readonly CheckIssue[];
  /** Check-specific structured payload (e.g. C2's per-numeral results), opaque to the composition layer. */
  readonly data?: unknown;
}

/** A single check, generic over whatever input bag it needs. */
export interface EvidenceCheck<TInput> {
  readonly id: string;
  readonly tier: 0 | 2;
  readonly blocking: boolean;
  run(input: TInput): CheckOutcome | Promise<CheckOutcome>;
}

/** Run a list of checks over one shared input and collect their outcomes, in order. */
export async function runChecks<TInput>(
  checks: readonly EvidenceCheck<TInput>[],
  input: TInput,
): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];
  for (const check of checks) {
    outcomes.push(await check.run(input));
  }
  return outcomes;
}

export interface AuditVerdict {
  readonly chapter: string;
  /** `true` iff every *blocking* check passed. Non-blocking failures (warnings) never flip this. */
  readonly passed: boolean;
  readonly outcomes: readonly CheckOutcome[];
}

/** Fold a set of check outcomes into a pass/fail verdict, per `docs/EVIDENCE.md`'s rule: only blocking checks gate. */
export function verdictFromOutcomes(
  chapter: string,
  outcomes: readonly CheckOutcome[],
): AuditVerdict {
  const passed = outcomes.every((outcome) => !outcome.blocking || outcome.passed);
  return { chapter, passed, outcomes };
}
