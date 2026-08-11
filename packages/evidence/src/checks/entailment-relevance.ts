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
 *
 * **The judge reads resolved snapshot bytes, never `selector.exact` (D24,
 * Wave 2 review, C-1).** `candidatesFor` used to hand the judge each span's
 * `selector.exact` directly — the writer's own copy of the quote. That makes
 * C3 circular: a fabricated quote is checked against itself and cannot fail.
 * `candidatesFor` now resolves each span against the pinned snapshot via
 * `resolveEvidenceText` (`./source-integrity.ts`, exact-only per D24) and
 * sends *that* text instead; a span that fails to resolve is simply dropped
 * from the candidate list rather than falling back to the claim's own
 * unverified copy — C2 (Tier 0, blocking) is what reports why it didn't
 * resolve, so this file doesn't need to duplicate that judgment, only
 * refuse to launder unresolved text into a judge prompt.
 *
 * **`operator` claims never enter the batch (Wave 2 review, minor item).**
 * `docs/EVIDENCE.md` is explicit that operator claims "verify at Tier 0 —
 * exact substring match against the session snapshot. No model, no cost."
 * `judgeEntailmentAndRelevance`'s `toJudge` filter excludes `kind ===
 * "operator"` outright, before the memoization check even runs, so a fresh
 * operator claim doesn't cost a model call it was never spec'd to cost.
 */

import type { AnchoringConfig } from "../anchoring.ts";
import type { Sha256Digest } from "../digest.ts";
import { meanExtractiveness } from "../extractiveness.ts";
import type {
  EntailmentRelevanceInput,
  EntailmentRelevanceJudge,
  EntailmentRelevanceVerdict,
} from "../ports.ts";
import type { Claim, ClaimSidecar, Verification } from "../types.ts";
import { type EvidenceLookup, resolveEvidenceText } from "./source-integrity.ts";
import type { CheckIssue, CheckOutcome } from "./types.ts";

export interface EntailmentRelevanceBundle {
  readonly sidecar: ClaimSidecar;
  readonly chapterSubject: string;
  readonly whenToUse?: string;
  readonly judge: EntailmentRelevanceJudge;
  /** Every current claim's freshly-computed `inputHash`, keyed by label — Tier 0's `computeInputHashes` output; this *is* the memoization filter. */
  readonly currentInputHashes: Readonly<Record<string, Sha256Digest>>;
  /** Resolves each evidence span against its pinned snapshot (D24) — the same lookup C2 (`source-integrity.ts`) uses, so the judge reads exactly the bytes C2 verified rather than the claim's own copy of the quote. */
  readonly lookup: EvidenceLookup;
  readonly anchoringConfig?: AnchoringConfig;
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

/**
 * Candidates for the judge: for `sourced`/`operator` claims, each evidence
 * span's *resolved* stored text (never `selector.exact` — D24). A span that
 * doesn't resolve against its pinned snapshot is dropped, not laundered
 * through as the claim's own unverified copy; C2 is what blocks the chapter
 * for that span, so the judge simply never sees it.
 */
function candidatesFor(
  claim: Claim,
  lookup: EvidenceLookup,
  config: AnchoringConfig | undefined,
): EntailmentRelevanceInput["candidates"] {
  if (claim.kind === "derived") return [];
  const candidates: EntailmentRelevanceInput["candidates"][number][] = [];
  for (const span of claim.evidence) {
    const resolvedText = resolveEvidenceText(span, lookup, config);
    if (resolvedText === undefined) continue;
    candidates.push({ exact: resolvedText, sourceId: span.sourceId });
  }
  return candidates;
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
  const { sidecar, chapterSubject, whenToUse, judge, currentInputHashes, lookup, anchoringConfig } =
    bundle;
  const classifiedBy = bundle.classifiedBy ?? "llm-judge/claude@shadow-model";
  const claimsByLabel = new Map(sidecar.claims.map((c) => [c.label, c] as const));

  const toJudge = sidecar.claims.filter((claim) => {
    // `operator` claims verify at Tier 0 — exact substring match against
    // the session transcript, no model, no cost (docs/EVIDENCE.md; Wave 2
    // review, minor item). Batching them into C3 anyway costs a model call
    // for a verdict Tier 0 already settled with certainty.
    if (claim.kind === "operator") return false;
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
      candidates: candidatesFor(claim, lookup, anchoringConfig),
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
