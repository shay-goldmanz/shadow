/**
 * C3 (span entailment) + C5 (chapter relevance), judged together in one
 * batched call because D15 requires C5 to "share C3's prompt turn" —
 * literally the same `generate()` call, via `EntailmentRelevanceJudge`
 * (`../ports.ts`). This is the one deliberate exception to "one
 * `EvidenceCheck` registered per check" elsewhere in this package: C3 and
 * C5 cannot each independently call the model without doubling the cost
 * D15 specifically says to avoid, so this file produces *both*
 * `CheckOutcome`s from a single judging pass instead of being two separate
 * `EvidenceCheck.run` implementations.
 *
 * **Memoized per D20**, using the memoization filter Tier 0 already
 * computed (`checks/audit.ts`'s `computeInputHashes`) rather than
 * recomputing it — "runs Tier 0 then Tier 2 with the memoization filter
 * between them" (see `checks/tier2.ts`'s `runFullAudit`). A claim whose
 * current `inputHash` still matches its stored `verification.inputHash`
 * (and which has actually been judged before — `status !== "unchecked"`,
 * guarding a coincidental hash match on a never-verified claim) is reused
 * with zero model involvement; only the rest go into the batch.
 *
 * **Extractiveness (D21) is computed unconditionally** for every claim with
 * evidence, judged or memoized alike — it's a pure function of
 * `decontextualized` and the cited spans, costs nothing, and is a watched
 * metric precisely because burying it defeats the point (`extractiveness.ts`).
 */

import type { Sha256Digest } from "../digest.ts";
import { meanExtractiveness } from "../extractiveness.ts";
import type {
  EntailmentRelevanceInput,
  EntailmentRelevanceJudge,
  EntailmentRelevanceVerdict,
} from "../ports.ts";
import type { Claim, ClaimSidecar, Verification } from "../types.ts";
import type { CheckIssue, CheckOutcome } from "./types.ts";

export interface EntailmentRelevanceBundle {
  readonly sidecar: ClaimSidecar;
  readonly chapterSubject: string;
  readonly whenToUse?: string;
  readonly judge: EntailmentRelevanceJudge;
  /** Every current claim's freshly-computed `inputHash`, keyed by label — Tier 0's `computeInputHashes` output; this *is* the memoization filter. */
  readonly currentInputHashes: Readonly<Record<string, Sha256Digest>>;
  readonly classifiedBy?: string;
}

export interface EntailmentRelevanceResult {
  readonly c3Outcome: CheckOutcome;
  readonly c5Outcome: CheckOutcome;
  /** `sidecar.claims`, with `verification` (and, for `derived`, `overgeneralizationRisk`) updated for every freshly-judged claim. Memoized claims are returned unchanged (same object). */
  readonly claims: readonly Claim[];
  readonly extractiveness: Readonly<Record<string, number>>;
  readonly meanExtractiveness: number | undefined;
}

function candidatesFor(claim: Claim): EntailmentRelevanceInput["candidates"] {
  if (claim.kind === "derived") return [];
  return claim.evidence.map((span) => ({ exact: span.selector.exact, sourceId: span.sourceId }));
}

function supportingClaimsFor(
  claim: Claim,
  byLabel: ReadonlyMap<string, Claim>,
): string[] | undefined {
  if (claim.kind !== "derived") return undefined;
  return claim.supports
    .map((label) => byLabel.get(label)?.decontextualized)
    .filter((text): text is string => text !== undefined);
}

/** Run C3+C5 over one chapter's claims. See module doc for why this isn't two independent `EvidenceCheck`s. */
export async function judgeEntailmentAndRelevance(
  bundle: EntailmentRelevanceBundle,
): Promise<EntailmentRelevanceResult> {
  const { sidecar, chapterSubject, whenToUse, judge, currentInputHashes } = bundle;
  const classifiedBy = bundle.classifiedBy ?? "llm-judge/claude@shadow-model";
  const claimsByLabel = new Map(sidecar.claims.map((c) => [c.label, c] as const));

  const toJudge = sidecar.claims.filter((claim) => {
    const currentHash = currentInputHashes[claim.label];
    const memoized =
      claim.verification.status !== "unchecked" && claim.verification.inputHash === currentHash;
    return !memoized;
  });

  const verdictsByLabel = new Map<string, EntailmentRelevanceVerdict>();

  if (toJudge.length > 0) {
    const requests: EntailmentRelevanceInput[] = toJudge.map((claim) => ({
      claimId: claim.id,
      decontextualized: claim.decontextualized,
      candidates: candidatesFor(claim),
      supportingClaims: supportingClaimsFor(claim, claimsByLabel),
      chapterSubject,
      whenToUse,
    }));
    const verdicts = await judge.judge(requests);
    if (verdicts.length !== requests.length) {
      throw new Error(
        `EntailmentRelevanceJudge returned ${verdicts.length} verdicts for ${requests.length} claims`,
      );
    }
    toJudge.forEach((claim, i) => {
      const verdict = verdicts[i];
      if (verdict) verdictsByLabel.set(claim.label, verdict);
    });
  }

  const updatedClaims: Claim[] = sidecar.claims.map((claim) => {
    const verdict = verdictsByLabel.get(claim.label);
    if (!verdict) return claim;
    const currentHash = currentInputHashes[claim.label];
    if (currentHash === undefined) return claim;
    const verification: Verification = {
      status: verdict.entailment.status,
      checkedAt: new Date().toISOString(),
      checkedBy: classifiedBy,
      inputHash: currentHash,
      rationale: verdict.entailment.rationale,
      relevance: verdict.relevance.relevance,
      conflictsWith: verdict.entailment.conflictsWith,
    };
    return {
      ...claim,
      verification,
      overgeneralizationRisk:
        claim.kind === "derived"
          ? verdict.entailment.overgeneralizationRisk
          : claim.overgeneralizationRisk,
    };
  });

  const c3Issues: CheckIssue[] = [];
  const c3Warnings: CheckIssue[] = [];
  const c5Warnings: CheckIssue[] = [];
  const extractiveness: Record<string, number> = {};

  for (const claim of updatedClaims) {
    const { status } = claim.verification;
    if (status === "unsupported") {
      c3Issues.push({
        code: "unsupported-claim",
        message: `Claim "${claim.label}" is not supported by its evidence${
          claim.verification.rationale ? `: ${claim.verification.rationale}` : ""
        }`,
        label: claim.label,
      });
    } else if (status === "partial") {
      c3Warnings.push({
        code: "partial-support",
        message: `Claim "${claim.label}" is only partially supported by its evidence`,
        label: claim.label,
      });
    } else if (status === "conflicted") {
      c3Warnings.push({
        code: "conflicting-evidence",
        message: `Claim "${claim.label}"'s evidence conflicts (conflicts with: ${(
          claim.verification.conflictsWith ?? []
        ).join(", ")})`,
        label: claim.label,
      });
    }

    if (claim.verification.relevance === "off-topic") {
      c5Warnings.push({
        code: "off-topic",
        message: `Claim "${claim.label}" is grounded but does not serve the chapter's stated subject`,
        label: claim.label,
      });
    }

    if (claim.evidence.length > 0) {
      const score = meanExtractiveness(
        claim.decontextualized,
        claim.evidence.map((e) => e.selector.exact),
      );
      if (score !== undefined) extractiveness[claim.label] = score;
    }
  }

  const scores = Object.values(extractiveness);
  const mean = scores.length === 0 ? undefined : scores.reduce((a, b) => a + b, 0) / scores.length;

  const c3Outcome: CheckOutcome = {
    checkId: "C3",
    tier: 2,
    blocking: true,
    passed: c3Issues.length === 0,
    issues: c3Issues,
    warnings: c3Warnings,
    data: { extractiveness, meanExtractiveness: mean },
  };

  const c5Outcome: CheckOutcome = {
    checkId: "C5",
    tier: 2,
    blocking: false,
    passed: true,
    issues: [],
    warnings: c5Warnings,
  };

  return { c3Outcome, c5Outcome, claims: updatedClaims, extractiveness, meanExtractiveness: mean };
}
