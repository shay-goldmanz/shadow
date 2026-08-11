/**
 * Tier 2 composition (T2.4/T2.5): wires C1b, C3, C5, and C4 together over
 * one chapter, and `runFullAudit` runs Tier 0 then Tier 2 with Tier 0's
 * `inputHash`es as the memoization filter between them (D20) — this is the
 * literal seam the brief asked for: Tier 0 computes each claim's current
 * `inputHash` as a pure, free side product of structural checking; Tier 2
 * diffs that map against every claim's stored `verification.inputHash` to
 * decide what needs re-judging, and never recomputes the hash itself.
 *
 * **Why C3+C5 aren't `EvidenceCheck` list entries, unlike C1a/C2/C1b/C4.**
 * `runChecks` (`checks/types.ts`) calls each check's `run` independently —
 * fine when every check owns its own model call, but D15 requires C3 and
 * C5 to share *one* call. `judgeEntailmentAndRelevance` produces both
 * outcomes from a single judging pass, so this file splices them into the
 * outcome list directly instead of registering two `EvidenceCheck`s that
 * would otherwise double the cost the sharing exists to avoid. C1b and C4
 * have no such coupling, so they stay ordinary async checks.
 *
 * **Nothing in `checks/audit.ts`, `TIER0_CHECKS`, or any Tier 0 check file
 * changes for this to exist** — exactly the Open/Closed seam
 * `checks/types.ts`'s module doc describes.
 */

import type { AnchoringConfig } from "../anchoring.ts";
import type { Sha256Digest } from "../digest.ts";
import type {
  CheckWorthinessClassifier,
  EntailmentRelevanceJudge,
  IndexAlignmentChecker,
} from "../ports.ts";
import type { ClaimSidecar } from "../types.ts";
import { type AuditRecord, runTier0Audit, type Tier0AuditInput } from "./audit.ts";
import { checkCheckWorthiness } from "./check-worthiness.ts";
import { judgeEntailmentAndRelevance } from "./entailment-relevance.ts";
import { checkIndexAlignment, computeRoutingMetadataHash } from "./index-alignment.ts";
import type { EvidenceLookup } from "./source-integrity.ts";
import type { AuditVerdict, CheckOutcome } from "./types.ts";
import { verdictFromOutcomes } from "./types.ts";

export interface Tier2AuditInput {
  readonly chapterBody: string;
  readonly chapterSubject: string;
  /** As loaded from disk — `sidecar.narrative` and each claim's `verification` already carry the previous audit's memoization state. */
  readonly sidecar: ClaimSidecar;
  readonly whenToUse?: string;
  readonly checkWorthinessClassifier: CheckWorthinessClassifier;
  readonly entailmentRelevanceJudge: EntailmentRelevanceJudge;
  /** Every current claim's `inputHash` — Tier 0's `computeInputHashes` output. The C3/C5 memoization filter. */
  readonly currentInputHashes: Readonly<Record<string, Sha256Digest>>;
  /** Resolves evidence spans against their pinned snapshots (D24) — threaded into C3's judging so it reads resolved stored bytes, never a claim's own `selector.exact`. The same lookup C2 uses. */
  readonly lookup: EvidenceLookup;
  readonly anchoringConfig?: AnchoringConfig;
  /** Index routing-metadata fragments (`when_to_use`, node summaries) to check with C4. Omit if this chapter has no index node yet. */
  readonly indexNodeSummaries?: readonly string[];
  readonly indexAlignmentChecker?: IndexAlignmentChecker;
  /** The hash C4 last judged, and the outcome it produced — from the previous `AuditRecord`. Enables C4's all-or-nothing memoization. */
  readonly previousRoutingMetadataHash?: Sha256Digest;
  readonly previousIndexAlignmentOutcome?: CheckOutcome;
  readonly classifiedBy?: string;
}

export interface Tier2AuditResult {
  readonly outcomes: readonly CheckOutcome[];
  /** `input.sidecar` with `claims` and `narrative` updated from this run's judging. */
  readonly sidecar: ClaimSidecar;
  /** The routing-metadata hash to persist on the next `AuditRecord` — unchanged from `previousRoutingMetadataHash` if C4 didn't run. */
  readonly routingMetadataHash?: Sha256Digest;
  readonly extractiveness: Readonly<Record<string, number>>;
  readonly meanExtractiveness: number | undefined;
}

/** Run Tier 2 (C1b, C3, C5, C4) over one chapter. See module doc for composition details. */
export async function runTier2Audit(input: Tier2AuditInput): Promise<Tier2AuditResult> {
  const classifiedBy = input.classifiedBy ?? "llm-judge/claude@shadow-model";

  const { outcome: c1bOutcome, narrative } = await checkCheckWorthiness({
    chapterBody: input.chapterBody,
    chapterSubject: input.chapterSubject,
    classifier: input.checkWorthinessClassifier,
    previousNarrative: input.sidecar.narrative,
    classifiedBy,
  });

  const { c3Outcome, c5Outcome, claims, extractiveness, meanExtractiveness } =
    await judgeEntailmentAndRelevance({
      sidecar: input.sidecar,
      chapterSubject: input.chapterSubject,
      whenToUse: input.whenToUse,
      judge: input.entailmentRelevanceJudge,
      currentInputHashes: input.currentInputHashes,
      lookup: input.lookup,
      anchoringConfig: input.anchoringConfig,
      classifiedBy,
    });

  const outcomes: CheckOutcome[] = [c1bOutcome, c3Outcome, c5Outcome];

  // I-3 (Wave 2 review): C4's memoization key must fold in `chapterClaims`,
  // not just the routing-metadata text. C4's verdict depends on both — if a
  // claim that supported a `when_to_use` is deleted or restated while the
  // frontmatter itself is untouched, `chapterClaims` changes but the old
  // `computeRoutingMetadataHash(nodeSummaries)`-only key would not, so C4
  // would replay a stale *pass* on a blocking check. Computed unconditionally
  // (not just inside the branch below) since it's needed to decide whether
  // anything changed at all.
  const chapterClaims = claims.map((c) => c.decontextualized);

  let routingMetadataHash = input.previousRoutingMetadataHash;
  if (input.indexNodeSummaries && input.indexNodeSummaries.length > 0) {
    if (!input.indexAlignmentChecker) {
      throw new Error("indexNodeSummaries was provided without an indexAlignmentChecker");
    }
    const currentHash = computeRoutingMetadataHash(input.indexNodeSummaries, chapterClaims);
    if (currentHash !== input.previousRoutingMetadataHash) {
      const c4Outcome = await checkIndexAlignment({
        fragments: input.indexNodeSummaries.map((nodeSummary) => ({ nodeSummary, chapterClaims })),
        checker: input.indexAlignmentChecker,
      });
      outcomes.push(c4Outcome);
      routingMetadataHash = currentHash;
    } else if (input.previousIndexAlignmentOutcome) {
      outcomes.push(input.previousIndexAlignmentOutcome);
    }
  }

  const sidecar: ClaimSidecar = {
    ...input.sidecar,
    claims,
    narrative,
    auditedAt: new Date().toISOString(),
  };

  return { outcomes, sidecar, routingMetadataHash, extractiveness, meanExtractiveness };
}

export interface FullAuditInput extends Tier0AuditInput {
  readonly chapterSubject: string;
  readonly whenToUse?: string;
  readonly checkWorthinessClassifier: CheckWorthinessClassifier;
  readonly entailmentRelevanceJudge: EntailmentRelevanceJudge;
  readonly indexNodeSummaries?: readonly string[];
  readonly indexAlignmentChecker?: IndexAlignmentChecker;
  readonly previousRoutingMetadataHash?: Sha256Digest;
  readonly previousIndexAlignmentOutcome?: CheckOutcome;
  readonly classifiedBy?: string;
}

export interface FullAuditResult {
  readonly chapter: string;
  readonly outcomes: readonly CheckOutcome[];
  readonly verdict: AuditVerdict;
  readonly sidecar: ClaimSidecar;
  readonly routingMetadataHash?: Sha256Digest;
  readonly extractiveness: Readonly<Record<string, number>>;
  readonly meanExtractiveness: number | undefined;
  readonly record: AuditRecord;
}

/**
 * The full-audit entry point: Tier 0 (C1a, C2, operator-verification), then
 * Tier 2 (C1b, C3, C5, C4) with Tier 0's `inputHash`es as the memoization
 * filter between them. Pure aside from the Tier 2 ports' model calls — no
 * filesystem; callers persist `sidecar`/`record` via `EvidenceStore`.
 */
export async function runFullAudit(input: FullAuditInput): Promise<FullAuditResult> {
  const tier0 = await runTier0Audit(input);

  const tier2 = await runTier2Audit({
    chapterBody: input.chapterBody,
    chapterSubject: input.chapterSubject,
    sidecar: input.sidecar,
    whenToUse: input.whenToUse,
    checkWorthinessClassifier: input.checkWorthinessClassifier,
    entailmentRelevanceJudge: input.entailmentRelevanceJudge,
    currentInputHashes: tier0.inputHashes,
    lookup: input.lookup,
    anchoringConfig: input.anchoringConfig,
    indexNodeSummaries: input.indexNodeSummaries,
    indexAlignmentChecker: input.indexAlignmentChecker,
    previousRoutingMetadataHash: input.previousRoutingMetadataHash,
    previousIndexAlignmentOutcome: input.previousIndexAlignmentOutcome,
    classifiedBy: input.classifiedBy,
  });

  const outcomes = [...tier0.outcomes, ...tier2.outcomes];
  const verdict = verdictFromOutcomes(input.sidecar.chapter, outcomes);
  const auditedAt = new Date().toISOString();

  const record: AuditRecord = {
    chapter: input.sidecar.chapter,
    auditedAt,
    verdict,
    routingMetadataHash: tier2.routingMetadataHash,
  };

  return {
    chapter: input.sidecar.chapter,
    outcomes,
    verdict,
    sidecar: { ...tier2.sidecar, auditedAt },
    routingMetadataHash: tier2.routingMetadataHash,
    extractiveness: tier2.extractiveness,
    meanExtractiveness: tier2.meanExtractiveness,
    record,
  };
}
