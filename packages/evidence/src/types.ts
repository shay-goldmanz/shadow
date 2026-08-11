/**
 * The evidence domain model, field-for-field from `docs/EVIDENCE.md`'s
 * "Source record" and "Claim sidecar" sections. Selector/annotation field
 * names follow the W3C Web Annotation REC (`TextQuoteSelector`,
 * `TextPositionSelector`, `refinedBy`, `TimeState`) deliberately, so the
 * ledger is exportable rather than proprietary (see that doc).
 *
 * Two modelling decisions not spelled out verbatim in the spec, flagged
 * here rather than silently assumed:
 *
 * 1. `Claim.supports` (for `derived` claims) references other claims **by
 *    label**, not by `ClaimId`. Labels are what the writer puts in the
 *    Markdown (`[^=label]`) and are guaranteed unique-per-chapter and
 *    never-reused (D18); `ClaimId`s are ULIDs minted by tooling that the
 *    writer has no way to know ahead of authoring the sidecar. Labels are
 *    also what a human reads in the ledger/audit output.
 * 2. `ClaimKind` includes `"narrative"` for forward compatibility with
 *    Tier 2's check-worthiness sweep (C1b, T2.4/T2.5), but Tier 0's
 *    footnote parser (`footnotes.ts`) only ever produces markers — and
 *    therefore claims — of kind `sourced | derived | operator`. A
 *    `narrative`-kind `Claim` is never constructed by this package; it
 *    exists only so the auditor pass can promote an unmarked sentence into
 *    a real (non-check-required) record without a second parallel type.
 */

import type { Sha256Digest } from "./digest.ts";
import type { ClaimId, SourceId } from "./ids.ts";
import type { NORMALIZATION_ALGORITHM } from "./normalize.ts";

// ---- source record ---------------------------------------------------------

/** How a source's content was obtained. `session` is the transcript case (D19/D9's second legitimate origin). */
export type RetrievalTransport = "live" | "fixture" | "session";

/** Relationship of a source to its subject — advisory, never a credibility gate (`docs/EVIDENCE.md`). */
export type AuthorityTier = "primary" | "secondary" | "community" | "unknown";

/** Expected rate of change, driving recency policy (`docs/EVIDENCE.md`, "Conflict, recency, repair"). */
export type Volatility = "never" | "slow-changing" | "fast-changing" | "unknown";

export interface RetrievalInfo {
  readonly retrievedAt: string; // ISO 8601 datetime
  readonly agent: string;
  readonly transport: RetrievalTransport;
  readonly query?: string | null;
  readonly httpStatus?: number | null;
  readonly contentType?: string | null;
}

export interface ArchivedCopy {
  readonly mementoUrl: string;
  readonly mementoDatetime: string;
}

export interface SnapshotInfo {
  /** Relative path under the volume's evidence dir, e.g. `snapshots/<hex>.txt`. */
  readonly path: string;
  readonly payloadSha256: Sha256Digest;
  readonly normalizedTextSha256: Sha256Digest;
  readonly normalization: typeof NORMALIZATION_ALGORITHM;
  readonly chars: number;
  readonly archived?: ArchivedCopy;
}

export interface AuthorityInfo {
  readonly tier: AuthorityTier;
  readonly rationale: string;
}

/** One retrieved source: a web page, or a session transcript stored the same way (D19). */
export interface SourceRecord {
  readonly schemaVersion: "1.0";
  readonly id: SourceId;
  readonly url: string;
  readonly finalUrl: string;
  readonly title: string;
  readonly author: string | null;
  readonly publishedAt: string | null; // ISO date, nullable
  readonly retrieval: RetrievalInfo;
  readonly snapshot: SnapshotInfo;
  readonly authority: AuthorityInfo;
  readonly volatility: Volatility;
}

// ---- evidence spans (W3C Web Annotation selectors) -------------------------

export interface TextPositionSelector {
  readonly type: "TextPositionSelector";
  readonly start: number; // character offset, not byte offset (docs/EVIDENCE.md)
  readonly end: number;
}

export interface TextQuoteSelector {
  readonly type: "TextQuoteSelector";
  readonly exact: string;
  readonly prefix?: string;
  readonly suffix?: string;
  /** Cached fast-path offset. A cache, never trusted without re-validation — see `anchoring.ts`. */
  readonly refinedBy?: TextPositionSelector;
}

export interface TimeState {
  readonly type: "TimeState";
  readonly sourceDate?: string;
  readonly cached?: string;
}

/** How a resolved evidence span relates to the claim it's attached to. */
export type EvidenceRelation = "supports" | "partial" | "contradicts" | "context";

/** Outcome of resolving a `TextQuoteSelector` against its pinned snapshot. Orphan is a state, not an error. */
export type AnchorStatus = "anchored" | "anchored-fuzzy" | "orphaned";

/** One evidence entry in a claim's `evidence[]` — a `SpecificResource` in all but name (`docs/EVIDENCE.md`). */
export interface EvidenceSpan {
  readonly sourceId: SourceId;
  /** Pins WHICH version of the source this span was resolved against. */
  readonly snapshotHash: Sha256Digest;
  readonly selector: TextQuoteSelector;
  readonly state?: TimeState;
  readonly relation: EvidenceRelation;
  readonly anchorStatus: AnchorStatus;
}

// ---- claims -----------------------------------------------------------------

/**
 * `sourced` cites external evidence; `derived` cites other claims in the
 * same chapter; `operator` cites the session transcript; `narrative` needs
 * nothing (see module doc for why this package never constructs one).
 */
export type ClaimKind = "sourced" | "derived" | "operator" | "narrative";

export type VerificationStatus =
  | "supported"
  | "partial"
  | "unsupported"
  | "conflicted"
  | "unchecked";

export type Relevance = "on-topic" | "off-topic";

export type OvergeneralizationRisk = "low" | "medium" | "high";

export interface Verification {
  readonly status: VerificationStatus;
  readonly checkedAt?: string;
  readonly checkedBy?: string;
  /** THE memoization key: `sha256(decontextualized ‖ evidence[].exact ‖ snapshotHash ‖ supports)`. See `input-hash.ts`. */
  readonly inputHash: Sha256Digest;
  readonly rationale?: string;
  readonly relevance?: Relevance;
  /** Labels of conflicting claims (see module doc: labels, not ids). */
  readonly conflictsWith?: readonly string[];
}

export interface Claim {
  readonly id: ClaimId;
  /** The `[^label]` marker. Lowercase kebab-case, unique per chapter, never reused (D18). */
  readonly label: string;
  readonly kind: ClaimKind;
  /** The sentence, exactly as written. */
  readonly text: string;
  /** The sentence rewritten to stand alone outside its paragraph, for judging (Tier 2). */
  readonly decontextualized: string;
  /** Set by the auditor pass (C1b, Tier 2), never by the writer (D19). Tier 0 sets this `true` for every marked claim, since marking is itself the writer's assertion that a chain is required. */
  readonly checkRequired: boolean;
  readonly evidence: readonly EvidenceSpan[];
  /** Non-empty for `derived`: labels of claims in the same chapter this one is built from. */
  readonly supports: readonly string[];
  readonly verification: Verification;
  /** `derived` only. */
  readonly overgeneralizationRisk?: OvergeneralizationRisk;
}

/**
 * One unmarked sentence's C1b verdict, keyed by a hash of its judged inputs
 * — the memoization record `docs/EVIDENCE.md`'s "only unmarked sentences
 * that are new or changed" requires. **T2.4/T2.5 amendment**: unlike marked
 * claims, an unmarked sentence has no stable label to key off (D18's label
 * machinery is for the writer's citations, not the auditor's sweep), so its
 * identity for memoization purposes is `sentenceHash = sha256(context ‖
 * sentence ‖ chapterSubject)` (see `checks/check-worthiness.ts`) rather than
 * a `[^label]`. A hash present in the previous audit's
 * `narrative.classifications` means this exact sentence-in-context was
 * already judged; only hashes absent from that list go into C1b's batch.
 */
export interface NarrativeSentenceClassification {
  readonly sentenceHash: Sha256Digest;
  readonly checkRequired: boolean;
}

export interface NarrativeSummary {
  readonly sentences: number;
  readonly ratio: number;
  readonly classifiedBy?: string;
  /** Per-sentence C1b memoization record — see `NarrativeSentenceClassification`. */
  readonly classifications?: readonly NarrativeSentenceClassification[];
}

/** `claims/<chapter-slug>.claims.json` — the sidecar for one chapter. */
export interface ClaimSidecar {
  readonly schemaVersion: "1.0";
  readonly chapter: string; // chapter slug
  readonly chapterTextSha256: Sha256Digest;
  readonly auditedAt?: string;
  readonly claims: readonly Claim[];
  readonly narrative?: NarrativeSummary;
}

// ---- ledger -------------------------------------------------------------

export interface SourceRetrievedEvent {
  readonly ts: string;
  readonly event: "source.retrieved";
  readonly sourceId: SourceId;
  readonly normalizedTextSha256: Sha256Digest;
}

export interface ClaimVerifiedEvent {
  readonly ts: string;
  readonly event: "claim.verified";
  readonly claimId: ClaimId;
  readonly status: VerificationStatus;
  readonly inputHash: Sha256Digest;
}

/**
 * **`outcome` is a T2.5 amendment.** D21's preservation-bound guardrail can
 * *reject* a proposed restatement (distance exceeds `max(80,
 * 0.5×|from|)`) and escalate to the operator instead of applying it — and
 * `docs/EVIDENCE.md` is explicit that this must be "log[ged] the distance
 * either way." Without a field distinguishing the two, every line in the
 * ledger would look like a restatement Shadow actually made, which is
 * exactly backwards for the escalated case: that is the one the operator
 * most needs to notice, since the claim was left unchanged pending their
 * review.
 */
export interface ClaimRestatedEvent {
  readonly ts: string;
  readonly event: "claim.restated";
  readonly claimId: ClaimId;
  /**
   * The chapter this restatement happened in (T3.6, `docs/API.md` "`claim.restated`
   * carries its chapter"). The ledger is volume-wide but a restatement belongs to one
   * chapter, matching `AuditCompletedEvent.chapter` — same field name and type.
   * Required: a label deleted from a chapter still has ledger history (D18 labels are
   * never reused), so this is the only reliable way to scope the ledger to a chapter
   * without cross-referencing the chapter's *current* claim list, which is wrong at
   * that edge.
   */
  readonly chapter: string;
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  readonly levenshtein: number;
  /** `"applied"` — within the preservation bound, `claim.text` was updated. `"escalated"` — bound exceeded; `from` is unchanged, flagged for operator review (D21). */
  readonly outcome: "applied" | "escalated";
}

export interface SourceDriftedEvent {
  readonly ts: string;
  readonly event: "source.drifted";
  readonly sourceId: SourceId;
  readonly was: Sha256Digest;
  readonly now: Sha256Digest;
  readonly invalidatedClaims: number;
}

export interface AuditCompletedEvent {
  readonly ts: string;
  readonly event: "audit.completed";
  readonly chapter: string;
  readonly result: "pass" | "fail";
  readonly completeness: number;
  readonly narrativeRatio: number;
}

/**
 * `claim.label.retired` is **not** in `docs/EVIDENCE.md`'s ledger example
 * block, which is illustrative rather than an exhaustive event list ("one
 * object per line" — five sample lines are shown, not a closed union).
 * D18 requires labels to be "never reused after deletion" and says "the
 * ledger references them", but names no mechanism. Enforcing that rule
 * needs *some* durable record of every label a chapter has ever used, and
 * the ledger is the only append-only history this package has — a sidecar
 * only holds current state. This event is that record, appended by the
 * store whenever `putClaims` observes a label present in the previous
 * sidecar disappear from the new one. Flagged for spec review.
 */
export interface ClaimLabelRetiredEvent {
  readonly ts: string;
  readonly event: "claim.label.retired";
  readonly chapter: string;
  readonly label: string;
  readonly claimId: ClaimId;
}

export type LedgerEvent =
  | SourceRetrievedEvent
  | ClaimVerifiedEvent
  | ClaimRestatedEvent
  | SourceDriftedEvent
  | AuditCompletedEvent
  | ClaimLabelRetiredEvent;

// ---- manifest -------------------------------------------------------------

export interface ChapterAuditStatus {
  readonly result: "pass" | "fail" | "unaudited";
  readonly auditedAt?: string;
  readonly completeness?: number;
  readonly narrativeRatio?: number;
}

/** `manifest.json` — schema version, counts, per-chapter audit status. */
export interface EvidenceManifest {
  readonly schemaVersion: "1.0";
  readonly sourceCount: number;
  readonly snapshotCount: number;
  readonly chapters: Readonly<Record<string, ChapterAuditStatus>>;
}
