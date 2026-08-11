/**
 * Tier 2 ports — defined, not implemented (T2.4/T2.5 own the
 * implementations, behind `@shadow/model`). Each port is the narrow LLM
 * capability one Tier 2 check needs; none of them import `@shadow/model` or
 * any AI SDK, so this package stays offline-testable end to end (D20: "the
 * entire completeness property and the entire anti-fabrication property
 * live in Tier 0" — these ports are exactly the boundary past which that
 * guarantee stops applying).
 *
 * How a Tier 2 check built on these ports slots into the audit: implement
 * `EvidenceCheck<TInput>` (`checks/types.ts`) with a `run` that calls the
 * relevant port, wrapping its verdict as a `CheckOutcome`. That check is
 * then just another entry in the list passed to `runChecks` — see
 * `checks/audit.ts`'s module doc for the composition contract.
 */

import type { ClaimId, SourceId } from "./ids.ts";
import type { OvergeneralizationRisk, Relevance, VerificationStatus } from "./types.ts";

// ---- C1b — check-worthiness sweep -----------------------------------------

export interface CheckWorthinessInput {
  /** The unmarked sentence being judged. */
  readonly sentence: string;
  /** Surrounding paragraph text, for context. */
  readonly context: string;
  readonly chapterSubject: string;
}

export interface CheckWorthinessVerdict {
  /** `true` means the writer should have cited this and didn't — an orphan claim (D19). */
  readonly checkRequired: boolean;
  readonly rationale: string;
}

/** C1b (Tier 2): independently classifies every unmarked sentence as check-required or not. */
export interface CheckWorthinessClassifier {
  classify(input: CheckWorthinessInput): Promise<CheckWorthinessVerdict>;
}

// ---- C3 — span entailment --------------------------------------------------

export interface EntailmentCandidate {
  readonly exact: string;
  readonly sourceId: SourceId;
}

export interface EntailmentInput {
  readonly claimId: ClaimId;
  readonly decontextualized: string;
  /** For `sourced`/`operator`: the resolved evidence spans. For `derived`: empty — see `supportingClaims`. */
  readonly candidates: readonly EntailmentCandidate[];
  /** For `derived` claims: the decontextualized text of each claim in `supports[]`. */
  readonly supportingClaims?: readonly string[];
}

export interface EntailmentVerdict {
  readonly status: VerificationStatus;
  readonly rationale: string;
  readonly conflictsWith?: readonly ClaimId[];
  /** `derived` only. */
  readonly overgeneralizationRisk?: OvergeneralizationRisk;
}

/**
 * C3 (Tier 2): does the resolved span support the decontextualized claim?
 * For `derived`, does the conclusion follow from `supports[]` without
 * overgeneralizing? "The gap Science One explicitly names as future work"
 * (`docs/EVIDENCE.md`).
 */
export interface EntailmentJudge {
  judge(input: EntailmentInput): Promise<EntailmentVerdict>;
}

// ---- C4 — index alignment ---------------------------------------------------

export interface IndexAlignmentInput {
  /** The generated summary text from an index node (e.g. a chapter's `index.json` node summary, or its `when_to_use`). */
  readonly nodeSummary: string;
  /** The chapter's claim texts (decontextualized), which the summary must not exceed. */
  readonly chapterClaims: readonly string[];
}

export interface IndexAlignmentVerdict {
  readonly aligned: boolean;
  /** Claims the summary makes that the chapter body does not support. */
  readonly unsupportedAssertions: readonly string[];
}

/** C4 (Tier 2): every claim in an index node summary or `when_to_use` appears in, or is entailed by, the chapter beneath it. */
export interface IndexAlignmentChecker {
  check(input: IndexAlignmentInput): Promise<IndexAlignmentVerdict>;
}

// ---- C5 — chapter relevance (non-blocking, D15) ----------------------------

export interface RelevanceInput {
  readonly decontextualized: string;
  readonly chapterSubject: string;
  readonly whenToUse?: string;
}

export interface RelevanceVerdict {
  readonly relevance: Relevance;
  readonly rationale: string;
}

/** C5 (Tier 2, non-blocking, D15): does this claim serve the chapter's stated subject? */
export interface RelevanceClassifier {
  classify(input: RelevanceInput): Promise<RelevanceVerdict>;
}
