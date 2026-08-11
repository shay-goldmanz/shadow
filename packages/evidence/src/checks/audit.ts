/**
 * Tier 0 audit composition: wires C1a, C2, and operator-claim verification
 * together over one chapter, and computes every claim's `inputHash` (D20)
 * as a side product — Tier 2 (T2.4) needs exactly that hash to decide which
 * claims to re-judge at all.
 *
 * **How Tier 2 slots in without touching this file.** `TIER0_CHECKS` is
 * just an `EvidenceCheck<Tier0AuditInput>[]`. T2.4/T2.5 define their own
 * checks (`EvidenceCheck<Tier2AuditInput>`, built from the ports in
 * `../ports.ts`) and either (a) extend `Tier0AuditInput` with whatever
 * extra fields their checks need (a superset object satisfies every
 * narrower check's `run` structurally) and pass the combined list to
 * `runChecks`, or (b) run Tier 0 and Tier 2 separately and concatenate the
 * two `CheckOutcome[]` arrays before calling `verdictFromOutcomes`. Either
 * way, nothing in `checks/structural-completeness.ts`,
 * `checks/source-integrity.ts`, or `checks/operator-verification.ts`
 * changes — this is the Open/Closed seam the brief asked for.
 */

import type { Sha256Digest } from "../digest.ts";
import { computeInputHash } from "../input-hash.ts";
import type { ClaimSidecar } from "../types.ts";
import { checkOperatorClaims, type OperatorVerificationInput } from "./operator-verification.ts";
import { checkSourceIntegrity, type SourceIntegrityInput } from "./source-integrity.ts";
import {
  checkStructuralCompleteness,
  type StructuralCompletenessInput,
} from "./structural-completeness.ts";
import {
  type AuditVerdict,
  type CheckOutcome,
  type EvidenceCheck,
  runChecks,
  verdictFromOutcomes,
} from "./types.ts";

/** Union of every Tier 0 check's input needs — see module doc for why a superset bag, not per-check wiring. */
export type Tier0AuditInput = StructuralCompletenessInput &
  SourceIntegrityInput &
  OperatorVerificationInput;

/** The three Tier 0 checks, composed. Add Tier 2 checks alongside this list — never inside it. */
export const TIER0_CHECKS: readonly EvidenceCheck<Tier0AuditInput>[] = [
  { id: "C1a", tier: 0, blocking: true, run: (input) => checkStructuralCompleteness(input) },
  { id: "C2", tier: 0, blocking: true, run: (input) => checkSourceIntegrity(input) },
  {
    id: "operator-verification",
    tier: 0,
    blocking: true,
    run: (input) => checkOperatorClaims(input),
  },
];

/** Every current claim's `inputHash`, keyed by label — the memoization key Tier 2 diffs against `verification.inputHash` to decide what needs re-judging. */
export function computeInputHashes(sidecar: ClaimSidecar): Readonly<Record<string, Sha256Digest>> {
  const hashes: Record<string, Sha256Digest> = {};
  for (const claim of sidecar.claims) {
    hashes[claim.label] = computeInputHash({
      decontextualized: claim.decontextualized,
      evidence: claim.evidence.map((e) => ({
        exact: e.selector.exact,
        snapshotHash: e.snapshotHash,
      })),
      supports: claim.supports,
    });
  }
  return hashes;
}

export interface Tier0AuditResult {
  readonly chapter: string;
  readonly outcomes: readonly CheckOutcome[];
  readonly verdict: AuditVerdict;
  readonly inputHashes: Readonly<Record<string, Sha256Digest>>;
}

/** The persisted form of an audit result — `audits/<chapter-slug>.audit.json`. See `../store.ts`. */
export interface AuditRecord {
  readonly chapter: string;
  readonly auditedAt: string;
  readonly verdict: AuditVerdict;
}

/** Run every Tier 0 check over one chapter and compute the resulting per-claim `inputHash`es. Pure — no filesystem. */
export async function runTier0Audit(input: Tier0AuditInput): Promise<Tier0AuditResult> {
  const outcomes = await runChecks(TIER0_CHECKS, input);
  return {
    chapter: input.sidecar.chapter,
    outcomes,
    verdict: verdictFromOutcomes(input.sidecar.chapter, outcomes),
    inputHashes: computeInputHashes(input.sidecar),
  };
}
