/**
 * The repair loop (D9/D21/T2.5): claims that come back `partial`,
 * `unsupported`, or `conflicted` from C3 are restated conservatively
 * against their evidence, never silently deleted — D9's rule, "restate
 * conservatively against the source, not deleted... the point is that they
 * see where their volume is thin."
 *
 * `off-topic` (a C5 `Relevance`, not a `VerificationStatus`) is
 * deliberately absent from `REPAIRABLE_STATUSES`: D15 is explicit that
 * off-topic never auto-rewrites — "the fix is usually deletion or a
 * different chapter", which is the operator's call, not a rewrite Shadow
 * proposes. `orphaned` is likewise absent — it is an `AnchorStatus` on an
 * evidence *span*, not a claim verdict; "refetch, and if genuinely gone,
 * warn and surface" is C2/`@shadow/research`'s territory (fetching), not
 * this loop's.
 *
 * **Two guardrails, because a naive repair loop is trivially gameable
 * (D21):**
 *
 * 1. **Preservation bound** (`applyPreservationBound`). RARR's attack: "an
 *    adversarial editor could ensure 100% attribution by simply replacing
 *    the input with the text of any arbitrary retrieved document, which is
 *    trivially attributable to itself." Reject any restatement whose
 *    Levenshtein distance from the original exceeds `max(80, 0.5 ×
 *    |original|)` and escalate to the operator instead — the bound can't
 *    distinguish a well-intentioned large rewrite from that attack, so it
 *    rejects on distance alone regardless of intent. The distance is
 *    logged either way (`toLedgerEvent`), so an escalation is exactly as
 *    visible to the operator as an applied restatement, not silently
 *    dropped.
 * 2. **Extractiveness** (`extractiveness.ts`) — computed unconditionally
 *    over every claim's evidence, watched rather than targeted.
 */

import { levenshteinDistance } from "./edit-distance.ts";
import type { ClaimId } from "./ids.ts";
import type { ClaimRestater, RestatementCandidateInput, RestatementProposal } from "./ports.ts";
import type { Claim, ClaimRestatedEvent, VerificationStatus } from "./types.ts";

/** `VerificationStatus`es the repair loop acts on. See module doc for why `off-topic`/`orphaned` are absent. */
export const REPAIRABLE_STATUSES: readonly VerificationStatus[] = [
  "partial",
  "unsupported",
  "conflicted",
];

export function isRepairable(status: VerificationStatus): boolean {
  return REPAIRABLE_STATUSES.includes(status);
}

/** D21's preservation bound: `max(80 chars, 0.5 × original length)`. */
export function preservationBound(originalLength: number): number {
  return Math.max(80, Math.ceil(0.5 * originalLength));
}

export interface RepairDecision {
  readonly claimId: ClaimId;
  readonly label: string;
  /** The chapter being repaired (T3.6). Supplied by the caller — never inferred or defaulted, since a `Claim` does not carry its own chapter. */
  readonly chapter: string;
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  readonly levenshtein: number;
  readonly bound: number;
  /** `"applied"` — within the preservation bound. `"escalated"` — bound exceeded; `from` stands unchanged pending operator review. */
  readonly outcome: "applied" | "escalated";
}

/**
 * Apply the preservation-bound guardrail to one proposed restatement. Pure
 * — no model, no I/O. `claim.text` (the sentence as written, what the
 * operator actually reads) is what gets restated, not `decontextualized`
 * (that field exists purely for judging outside the paragraph). `chapter`
 * is the chapter actually being repaired (T3.6) — the caller's
 * responsibility, since a `Claim` does not carry it.
 */
export function applyPreservationBound(
  claim: Pick<Claim, "id" | "label" | "text">,
  proposal: RestatementProposal,
  chapter: string,
): RepairDecision {
  const from = claim.text;
  const levenshtein = levenshteinDistance(from, proposal.to);
  const bound = preservationBound(from.length);
  return {
    claimId: claim.id,
    label: claim.label,
    chapter,
    from,
    to: proposal.to,
    reason: proposal.reason,
    levenshtein,
    bound,
    outcome: levenshtein <= bound ? "applied" : "escalated",
  };
}

/** Build the ledger event for one repair decision. Logged whether `applied` or `escalated` — "log the distance either way" (`docs/EVIDENCE.md`). */
export function toLedgerEvent(
  decision: RepairDecision,
  ts: string = new Date().toISOString(),
): ClaimRestatedEvent {
  return {
    ts,
    event: "claim.restated",
    claimId: decision.claimId,
    chapter: decision.chapter,
    from: decision.from,
    to: decision.to,
    reason: decision.reason,
    levenshtein: decision.levenshtein,
    outcome: decision.outcome,
  };
}

/** Build one `RestatementCandidateInput` per repairable claim, for a single batched `ClaimRestater.restate` call. */
export function buildRestatementRequests(
  claims: readonly Claim[],
  evidenceExcerptsFor: (claim: Claim) => readonly string[],
): RestatementCandidateInput[] {
  return claims
    .filter((claim) => isRepairable(claim.verification.status))
    .map((claim) => ({
      claimId: claim.id,
      label: claim.label,
      verdict: claim.verification.status,
      text: claim.text,
      decontextualized: claim.decontextualized,
      evidenceExcerpts: evidenceExcerptsFor(claim),
    }));
}

/**
 * Run the repair loop over a batch of claims: one `ClaimRestater.restate`
 * call proposes text for every repairable claim, then each proposal passes
 * independently through the preservation-bound guardrail. Returns one
 * `RepairDecision` per repairable claim, in the same order as `claims`
 * (non-repairable claims are simply absent from the result). Callers apply
 * `"applied"` decisions to the claim/chapter text and log every decision —
 * applied or escalated alike — via `toLedgerEvent`.
 *
 * `chapter` is the chapter actually being repaired (T3.6) — `claims` alone
 * doesn't carry it (a `Claim` is chapter-agnostic), so the caller, which
 * already knows which chapter it is publishing, supplies it explicitly.
 */
export async function runRepairLoop(
  claims: readonly Claim[],
  restater: ClaimRestater,
  evidenceExcerptsFor: (claim: Claim) => readonly string[],
  chapter: string,
): Promise<readonly RepairDecision[]> {
  const repairable = claims.filter((claim) => isRepairable(claim.verification.status));
  if (repairable.length === 0) return [];

  const requests = buildRestatementRequests(repairable, evidenceExcerptsFor);
  const proposals = await restater.restate(requests);
  if (proposals.length !== requests.length) {
    throw new Error(
      `ClaimRestater returned ${proposals.length} proposals for ${requests.length} claims`,
    );
  }

  return repairable.map((claim, i) => {
    const proposal = proposals[i];
    if (!proposal) {
      throw new Error(`Missing restatement proposal for claim "${claim.label}"`);
    }
    return applyPreservationBound(claim, proposal, chapter);
  });
}

/**
 * `unsupported → rewrite; downgrade to operator only with operator
 * confirmation, never silently` (`docs/EVIDENCE.md`). Downgrading a claim's
 * `kind` to `operator` asserts "the operator said this" — a materially
 * different claim about provenance than a failed entailment check can
 * license on its own, so it is deliberately not part of the restatement
 * flow above. This is a narrow, explicit primitive: it throws rather than
 * silently downgrading if `confirmedBy` is empty, and it does not attach
 * operator evidence itself (that requires a real session-transcript span,
 * which is `@shadow/evidence`'s store/witness layer's job, invoked by
 * whatever caller holds the actual confirmation) — a downgraded claim will
 * still fail C1a's `missing-evidence` rule for `operator` claims until real
 * evidence is attached.
 */
export function downgradeToOperatorClaim(
  claim: Claim,
  confirmation: { readonly confirmedBy: string },
): Claim {
  if (!confirmation.confirmedBy.trim()) {
    throw new Error(
      "downgradeToOperatorClaim requires a non-empty confirmedBy — never silent (D9)",
    );
  }
  return { ...claim, kind: "operator" };
}
