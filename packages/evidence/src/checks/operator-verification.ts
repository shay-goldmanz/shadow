/**
 * Operator-claim exact-quote verification (Tier 0, `docs/EVIDENCE.md`):
 * `operator` claims verify against the session snapshot by **exact
 * substring match**. No model, no fuzzy fallback. Per D19, this is what
 * stops Shadow minting a belief the operator never expressed — "the
 * operator either said it or did not."
 *
 * This is deliberately *not* folded into `checkSourceIntegrity`: C2 governs
 * `sourced` evidence resolving against arbitrary web snapshots, where a
 * fuzzy match is a legitimate, recorded outcome (`anchored-fuzzy`).
 * Operator claims have a strictly narrower bar — the loophole this check
 * exists to close is exactly a near-but-not-exact quote being accepted, so
 * it must never fall through to the anchoring resolver's fuzzy step.
 */

import { resolveSelector } from "../anchoring.ts";
import type { ClaimSidecar } from "../types.ts";
import type { EvidenceLookup } from "./source-integrity.ts";
import type { CheckIssue, CheckOutcome, EvidenceCheck } from "./types.ts";

export interface OperatorVerificationInput {
  readonly sidecar: ClaimSidecar;
  readonly lookup: EvidenceLookup;
}

/** Run operator-claim exact-quote verification over one chapter. */
export function checkOperatorClaims(input: OperatorVerificationInput): CheckOutcome {
  const { sidecar, lookup } = input;
  const issues: CheckIssue[] = [];

  for (const claim of sidecar.claims) {
    if (claim.kind !== "operator") continue;

    if (claim.evidence.length === 0) {
      issues.push({
        code: "missing-evidence",
        message: `Operator claim "${claim.label}" cites no session transcript span`,
        label: claim.label,
      });
      continue;
    }

    for (const span of claim.evidence) {
      const snapshotText = lookup.getSnapshotText(span.snapshotHash);
      if (snapshotText === undefined) {
        issues.push({
          code: "missing-snapshot",
          message: `Operator claim "${claim.label}" cites a session snapshot that does not exist`,
          label: claim.label,
        });
        continue;
      }

      // allowFuzzy: false — an operator claim must match the transcript
      // exactly. "anchored-fuzzy" is a legitimate outcome for web evidence
      // (C2) but never for a belief attributed to the operator.
      const resolution = resolveSelector(span.selector, snapshotText, { allowFuzzy: false });
      if (resolution.status !== "anchored") {
        issues.push({
          code: "operator-quote-not-exact",
          message: `Operator claim "${claim.label}" does not exactly match the session transcript`,
          label: claim.label,
        });
      }
    }
  }

  return {
    checkId: "operator-verification",
    tier: 0,
    blocking: true,
    passed: issues.length === 0,
    issues,
  };
}

export const operatorVerificationCheck: EvidenceCheck<OperatorVerificationInput> = {
  id: "operator-verification",
  tier: 0,
  blocking: true,
  run: checkOperatorClaims,
};
