/**
 * C2 — source integrity (Tier 0, `docs/EVIDENCE.md`): every `sourceId` and
 * `snapshotHash` exists; re-hashing a snapshot reproduces its filename;
 * every `selector.exact` resolves in its pinned snapshot. Plus the numeric
 * sub-check: every numeral in a claim appears in a cited span within 5%
 * relative tolerance.
 *
 * Takes an `EvidenceLookup` rather than the store directly, so this stays a
 * pure, filesystem-free function testable with an in-memory fake — the
 * store (`../store.ts`) is just one implementation of that lookup.
 */

import { type AnchoringConfig, resolveSelector } from "../anchoring.ts";
import { type Sha256Digest, sha256Of } from "../digest.ts";
import type { SourceId } from "../ids.ts";
import {
  checkNumericConsistency,
  DEFAULT_NUMERIC_TOLERANCE,
  type NumericCheckResult,
} from "../numeric.ts";
import type { Claim, ClaimSidecar, SourceRecord } from "../types.ts";
import type { CheckIssue, CheckOutcome, EvidenceCheck } from "./types.ts";

/** The narrow read surface C2 needs. Implemented by `EvidenceStore`, but kept separate so this check has no filesystem dependency of its own. */
export interface EvidenceLookup {
  getSource(id: SourceId): SourceRecord | undefined;
  /** The raw normalized-text content stored at `normalizedTextSha256`, or `undefined` if no such snapshot exists. */
  getSnapshotText(normalizedTextSha256: Sha256Digest): string | undefined;
}

export interface SourceIntegrityInput {
  readonly sidecar: ClaimSidecar;
  readonly lookup: EvidenceLookup;
  readonly anchoringConfig?: AnchoringConfig;
  readonly numericTolerance?: number;
}

export interface SourceIntegrityData {
  /** Per-claim numeric sub-check results, keyed by claim label. */
  readonly numeric: Readonly<Record<string, NumericCheckResult>>;
}

function checkEvidenceSpan(
  claim: Claim,
  spanIndex: number,
  lookup: EvidenceLookup,
  config: AnchoringConfig | undefined,
  issues: CheckIssue[],
  warnings: CheckIssue[],
): void {
  const span = claim.evidence[spanIndex];
  if (!span) return;
  const label = claim.label;

  const source = lookup.getSource(span.sourceId);
  if (!source) {
    issues.push({
      code: "missing-source",
      message: `Claim "${label}" cites source "${span.sourceId}", which does not exist`,
      label,
    });
    return;
  }

  const snapshotText = lookup.getSnapshotText(span.snapshotHash);
  if (snapshotText === undefined) {
    issues.push({
      code: "missing-snapshot",
      message: `Claim "${label}" pins snapshot "${span.snapshotHash}", which does not exist`,
      label,
    });
    return;
  }

  // Re-hash: the content actually stored under this hash must still
  // reproduce it. A mismatch means the snapshot file was tampered with (or
  // corrupted) independent of anything about the source's *current* live
  // content — this is purely "is our own stored copy self-consistent".
  const rehashed = sha256Of(snapshotText);
  if (rehashed !== span.snapshotHash) {
    issues.push({
      code: "tampered-snapshot",
      message: `Snapshot "${span.snapshotHash}" for claim "${label}" no longer hashes to its own filename (got "${rehashed}")`,
      label,
    });
    return;
  }

  const resolution = resolveSelector(span.selector, snapshotText, { config });
  if (resolution.status === "orphaned") {
    issues.push({
      code: "unresolved-selector",
      message: `Claim "${label}"'s evidence selector no longer resolves in its pinned snapshot`,
      label,
    });
  } else if (resolution.status === "anchored-fuzzy") {
    warnings.push({
      code: "anchored-fuzzy",
      message: `Claim "${label}"'s evidence selector resolved only approximately (edit distance ${resolution.distance})`,
      label,
    });
  }
}

/** Run C2 (source integrity + numeric sub-check) over one chapter. */
export function checkSourceIntegrity(input: SourceIntegrityInput): CheckOutcome {
  const { sidecar, lookup } = input;
  const tolerance = input.numericTolerance ?? DEFAULT_NUMERIC_TOLERANCE;
  const issues: CheckIssue[] = [];
  const warnings: CheckIssue[] = [];
  const numeric: Record<string, NumericCheckResult> = {};

  for (const claim of sidecar.claims) {
    for (let i = 0; i < claim.evidence.length; i++) {
      checkEvidenceSpan(claim, i, lookup, input.anchoringConfig, issues, warnings);
    }

    if (claim.evidence.length > 0) {
      const citedTexts = claim.evidence.map((e) => e.selector.exact);
      const result = checkNumericConsistency(
        claim.decontextualized || claim.text,
        citedTexts,
        tolerance,
      );
      numeric[claim.label] = result;
      if (!result.passed) {
        for (const outcome of result.outcomes) {
          if (!outcome.matched) {
            issues.push({
              code: "numeric-mismatch",
              message: `Claim "${claim.label}" states "${outcome.numeral.raw}", which is not within ${Math.round(
                tolerance * 100,
              )}% of any cited value`,
              label: claim.label,
            });
          }
        }
      }
    }
  }

  return {
    checkId: "C2",
    tier: 0,
    blocking: true,
    passed: issues.length === 0,
    issues,
    warnings,
    data: { numeric } satisfies SourceIntegrityData,
  };
}

export const sourceIntegrityCheck: EvidenceCheck<SourceIntegrityInput> = {
  id: "C2",
  tier: 0,
  blocking: true,
  run: checkSourceIntegrity,
};
