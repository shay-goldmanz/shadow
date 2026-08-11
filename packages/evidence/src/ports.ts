/**
 * Tier 2 ports — the narrow LLM capability each Tier 2 check needs, backed
 * by `@shadow/model`'s `StructuredGenerationPort` (Zod-typed, tool-less).
 * None of them import `@shadow/model` or any AI SDK from *this* file, so
 * this package stays offline-testable end to end (D20: "the entire
 * completeness property and the entire anti-fabrication property live in
 * Tier 0" — these ports are exactly the boundary past which that guarantee
 * stops applying). The concrete adapters live in `checks/tier2-adapters.ts`,
 * which *does* import `@shadow/model`'s port type.
 *
 * **Batch-shaped, not per-item (T2.4/T2.5 amendment).** T1.3 shipped these
 * as one-input-in, one-verdict-out methods. D20's entire cost argument is
 * "one batched session" — a single `generate()` call judging every claim
 * that needs it, not one call per claim (D6: a fresh call pays ~18k tokens
 * of preamble). A per-item method signature makes that impossible to
 * express at the port boundary: any caller iterating `classify(one)` in a
 * loop pays for N calls no matter how disciplined the orchestrator above it
 * is. So every method here takes `readonly Input[]` and returns
 * `readonly Verdict[]`, same length, same order — "batch of one" for a
 * single item, "batch of everything this audit needs" for the real case.
 * See `checks/tier2-adapters.ts` for how one array turns into one
 * `generate()` call via a length-pinned Zod array schema.
 *
 * **`EntailmentRelevanceJudge` is new.** D15 says C5 "shares C3's prompt
 * turn" — literally the same `generate()` call judging both entailment and
 * relevance for a claim, not two calls. `EntailmentJudge`/`RelevanceClassifier`
 * stay as standalone, independently testable contracts (and as a home for
 * simple non-batched adapters), but the audit orchestrator
 * (`checks/tier2.ts`) uses `EntailmentRelevanceJudge` exclusively so C3 and
 * C5 for a given batch of claims cost exactly one call between them.
 *
 * **`EntailmentVerdict.conflictsWith` is `string[]`, not `ClaimId[]`
 * (bugfix).** `types.ts`'s `Verification.conflictsWith` is documented and
 * typed as claim *labels* — the same "labels, not tooling-minted ids the
 * writer can't know ahead of time" reasoning `docs/EVIDENCE.md`'s amendment
 * 1 gives for `supports[]`. The original port typed this `ClaimId[]`, which
 * would have forced a label→id lookup the judge has no way to perform (it
 * only ever sees decontextualized claim *text*, never ids). Fixed to match
 * `Verification.conflictsWith`.
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

/** C1b (Tier 2): independently classifies every unmarked sentence as check-required or not. Batched — see module doc. */
export interface CheckWorthinessClassifier {
  classify(inputs: readonly CheckWorthinessInput[]): Promise<readonly CheckWorthinessVerdict[]>;
}

// ---- C3 — span entailment --------------------------------------------------

export interface EntailmentCandidate {
  /** The resolved snapshot text for this evidence span — see `EntailmentInput.candidates`'s doc (D24). Named `exact` for continuity with `TextQuoteSelector.exact`, but this is the *resolved* text, not the writer-supplied selector field of that name. */
  readonly exact: string;
  readonly sourceId: SourceId;
}

export interface EntailmentInput {
  readonly claimId: ClaimId;
  readonly decontextualized: string;
  /**
   * For `sourced`/`operator`: each evidence span's *resolved* text — the
   * slice of the pinned snapshot the span's selector actually resolves to,
   * never the claim's own writer-supplied `selector.exact` (D24, Wave 2
   * review, C-1: handing a verifier the thing it is verifying makes the
   * check circular and unable to fail). Produced by
   * `checks/entailment-relevance.ts`'s `candidatesFor` via
   * `checks/source-integrity.ts`'s `resolveEvidenceText`, the same
   * exact-only resolution C2 uses. A span that doesn't resolve is simply
   * absent here, not backfilled with unverified text. For `derived`: empty
   * — see `supportingClaims`.
   */
  readonly candidates: readonly EntailmentCandidate[];
  /** For `derived` claims: the decontextualized text of each claim in `supports[]`. */
  readonly supportingClaims?: readonly string[];
}

export interface EntailmentVerdict {
  readonly status: VerificationStatus;
  readonly rationale: string;
  /** Labels of conflicting claims — see module doc's bugfix note. */
  readonly conflictsWith?: readonly string[];
  /** `derived` only. */
  readonly overgeneralizationRisk?: OvergeneralizationRisk;
}

/**
 * C3 (Tier 2): does the resolved span support the decontextualized claim?
 * For `derived`, does the conclusion follow from `supports[]` without
 * overgeneralizing? "The gap Science One explicitly names as future work"
 * (`docs/EVIDENCE.md`). Batched — see module doc.
 */
export interface EntailmentJudge {
  judge(inputs: readonly EntailmentInput[]): Promise<readonly EntailmentVerdict[]>;
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

/** C5 (Tier 2, non-blocking, D15): does this claim serve the chapter's stated subject? Batched — see module doc. */
export interface RelevanceClassifier {
  classify(inputs: readonly RelevanceInput[]): Promise<readonly RelevanceVerdict[]>;
}

// ---- C3 + C5 combined — one prompt turn (D15) ------------------------------

export interface EntailmentRelevanceInput extends EntailmentInput {
  readonly chapterSubject: string;
  readonly whenToUse?: string;
}

export interface EntailmentRelevanceVerdict {
  readonly entailment: EntailmentVerdict;
  readonly relevance: RelevanceVerdict;
}

/** The production seam for C3+C5: one batched `generate()` call judges both dimensions for every claim in `inputs`. See module doc. */
export interface EntailmentRelevanceJudge {
  judge(
    inputs: readonly EntailmentRelevanceInput[],
  ): Promise<readonly EntailmentRelevanceVerdict[]>;
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

/** C4 (Tier 2): every claim in an index node summary or `when_to_use` appears in, or is entailed by, the chapter beneath it. Batched — see module doc. */
export interface IndexAlignmentChecker {
  check(inputs: readonly IndexAlignmentInput[]): Promise<readonly IndexAlignmentVerdict[]>;
}

// ---- Repair loop (D9/D21): restatement proposal ----------------------------

/**
 * One claim's restatement request. `evidenceExcerpts` carries whatever the
 * rewrite should be conservative *against*: cited spans for
 * `partial`/`unsupported`, both sides' spans for `conflicted` (the prose
 * must surface both, per `docs/EVIDENCE.md`'s "Conflict, recency, repair").
 * `off-topic` claims (C5) are deliberately not modeled here — D15 says
 * off-topic never auto-rewrites, so there is no restatement input shape for
 * it; that verdict only ever produces a warning for the operator to act on.
 */
export interface RestatementCandidateInput {
  readonly claimId: ClaimId;
  readonly label: string;
  readonly verdict: VerificationStatus;
  readonly text: string;
  readonly decontextualized: string;
  readonly evidenceExcerpts: readonly string[];
}

export interface RestatementProposal {
  readonly to: string;
  readonly reason: string;
}

/** Proposes a conservative restatement for one or more claims. The preservation-bound guardrail (D21) is applied afterward, in `repair.ts` — this port only proposes; it never decides accept/reject. Batched. */
export interface ClaimRestater {
  restate(inputs: readonly RestatementCandidateInput[]): Promise<readonly RestatementProposal[]>;
}
