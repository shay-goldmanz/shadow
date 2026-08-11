/**
 * Operator-claim verification (Tier 0, `docs/EVIDENCE.md`): `operator`
 * claims verify by (1) resolving the cited source and requiring
 * `transport === "session"`, then (2) matching the quote against the
 * session snapshot by **exact substring match**. No model, no fuzzy
 * fallback. Per D19, this is what stops Shadow minting a belief the
 * operator never expressed — "the operator either said it or did not."
 *
 * **Step (1) is not optional — it is the whole point, per D23.** Without
 * it, exact-matching the quote alone would let an `operator` claim point at
 * *any* snapshot (a web page, a fixture — anything containing the same
 * sentence) and verify as "the operator said this," which defeats D19's
 * entire guarantee. The Wave 1 review reproduced exactly this: the previous
 * version of this check never called `lookup.getSource()` at all, so
 * nothing anywhere on the Tier 0 path ever inspected `retrieval.transport`.
 *
 * This is deliberately *not* folded into `checkSourceIntegrity`: C2 governs
 * `sourced` evidence resolving against arbitrary web snapshots, where a
 * fuzzy match is a legitimate, recorded outcome (`anchored-fuzzy`) and any
 * transport is legitimate. Operator claims have a strictly narrower bar on
 * both axes — transport must be `session`, and the quote must match
 * exactly — so the loopholes this check exists to close (wrong source,
 * near-but-not-exact quote) must never fall through to C2's more permissive
 * rules.
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
      // D23/D19: resolve the cited source and require it to actually *be*
      // a session transcript before trusting anything about the quote.
      // This is provenance, not text-matching — a claim can only be
      // "operator" if its evidence really originated from the transcript.
      const source = lookup.getSource(span.sourceId);
      if (!source) {
        issues.push({
          code: "missing-source",
          message: `Operator claim "${claim.label}" cites source "${span.sourceId}", which does not exist`,
          label: claim.label,
        });
        continue;
      }
      if (source.retrieval.transport !== "session") {
        issues.push({
          code: "not-session-source",
          message: `Operator claim "${claim.label}" cites source "${span.sourceId}", whose retrieval transport is "${source.retrieval.transport}", not "session" — an operator claim must cite the session transcript (D19/D23)`,
          label: claim.label,
        });
        continue;
      }

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
