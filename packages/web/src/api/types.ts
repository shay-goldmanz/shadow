/**
 * Wire types for `@shadow/api`.
 *
 * These mirror the JSON `@shadow/api`'s handlers actually serialize —
 * verified against `packages/api/src/handlers/*.ts` and the pillar types
 * they pass straight through (`@shadow/core`, `@shadow/evidence`,
 * `@shadow/indexing`, `@shadow/research`, `@shadow/agent`'s `RepairDecision`).
 * `@shadow/web` deliberately does not depend on those packages (this is
 * browser code; they are server/Node-only), so this file hand-mirrors their
 * JSON shape rather than importing it — but every shape below is a
 * reconciled match, not a guess. See the reconciliation report for the
 * specific `docs/API.md` corrections this uncovered.
 *
 * Dates cross the wire as ISO 8601 strings (JSON has no Date type); pillar
 * types that are `Date` in-process (`@shadow/core`'s `Volume`/`Chapter`)
 * serialize to strings, which is what's typed here.
 */

// ---- volumes ----------------------------------------------------------

export interface OkfActor {
  readonly by: string;
  readonly at: string;
}

export type OkfStatus = "draft" | "stable" | "deprecated";

export interface Volume {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly type: string;
  readonly status: OkfStatus;
  readonly staleAfter: string | null;
  readonly generated: OkfActor;
  readonly verified: readonly OkfActor[];
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * `GET /api/volumes` returns `{ volumes: Volume[] }` — full `Volume` objects,
 * straight from `VolumeStore.listVolumes()` (`handlers/volumes.ts`). There is
 * no separate summary shape and, in particular, no `chapterCount`: nothing
 * in `@shadow/core`'s `Volume` carries one, and computing it would mean an
 * extra `listChapters` call per volume that `listVolumes` never makes. Kept
 * as a distinct alias (not a raw `Volume` reference) so call sites that mean
 * "a volume as it appears in a list" stay self-documenting.
 */
export type VolumeSummary = Volume;

export interface CreateVolumeInput {
  readonly slug?: string;
  readonly title: string;
  readonly description?: string;
}

export interface UpdateVolumeInput {
  readonly title?: string;
  readonly description?: string;
  readonly type?: string;
  readonly status?: OkfStatus;
  readonly staleAfter?: string | null;
  readonly generated?: OkfActor;
  readonly verified?: readonly OkfActor[];
  readonly frontmatter?: Readonly<Record<string, unknown>>;
}

// ---- chapters -----------------------------------------------------------

/**
 * `GET /api/volumes/:slug` embeds this for each chapter
 * (`handlers/volumes.ts`'s `toChapterSummary`) — `Chapter` minus `body`.
 * There is no top-level `whenToUse`; it lives in `frontmatter.when_to_use`
 * like every other routing field, same as a full `Chapter`. Use
 * `whenToUseOf()` below to read it.
 */
export interface ChapterSummary {
  readonly slug: string;
  readonly title: string;
  readonly type: string;
  readonly status: OkfStatus;
  readonly staleAfter: string | null;
  readonly generated: OkfActor;
  readonly verified: readonly OkfActor[];
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Chapter {
  readonly slug: string;
  readonly title: string;
  readonly body: string;
  readonly type: string;
  readonly status: OkfStatus;
  readonly staleAfter: string | null;
  readonly generated: OkfActor;
  readonly verified: readonly OkfActor[];
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** `frontmatter.when_to_use`, coerced — the one routing field the chapter list and index tree both surface. */
export function whenToUseOf(chapter: ChapterSummary | Chapter): string | undefined {
  const value = chapter.frontmatter.when_to_use;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export interface PutChapterInput {
  readonly title: string;
  readonly body: string;
  readonly type?: string;
  readonly status?: OkfStatus;
  readonly staleAfter?: string | null;
  readonly generated?: OkfActor;
  readonly verified?: readonly OkfActor[];
  readonly frontmatter?: Readonly<Record<string, unknown>>;
}

// ---- evidence (D9, D16, D18, D19, D22) -----------------------------------
//
// Field-for-field from `@shadow/evidence`'s `types.ts` and `checks/*.ts` —
// `handlers/chapters.ts`'s `GET` and `handlers/evidence.ts` pass these
// straight through with no reshaping.

/** How a resolved evidence span relates to its pinned snapshot. Orphan is a state, not an error (D16, D22). */
export type AnchorStatus = "anchored" | "anchored-fuzzy" | "orphaned";

export type RetrievalTransport = "live" | "fixture" | "session" | "file";
export type AuthorityTier = "primary" | "secondary" | "community" | "unknown";
export type Volatility = "never" | "slow-changing" | "fast-changing" | "unknown";

export interface RetrievalInfo {
  readonly retrievedAt: string;
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
  readonly path: string;
  readonly payloadSha256: string;
  readonly normalizedTextSha256: string;
  readonly normalization: string;
  readonly chars: number;
  readonly archived?: ArchivedCopy;
}

export interface AuthorityInfo {
  readonly tier: AuthorityTier;
  readonly rationale: string;
}

/** One retrieved source: a web page, or a session transcript stored the same way (D19). `GET .../evidence/sources/:id`. */
export interface SourceRecord {
  readonly schemaVersion: "1.0";
  readonly id: string;
  readonly url: string;
  readonly finalUrl: string;
  readonly title: string;
  readonly author: string | null;
  readonly publishedAt: string | null;
  readonly retrieval: RetrievalInfo;
  readonly snapshot: SnapshotInfo;
  readonly authority: AuthorityInfo;
  readonly volatility: Volatility;
}

export interface TextPositionSelector {
  readonly type: "TextPositionSelector";
  readonly start: number;
  readonly end: number;
}

export interface TextQuoteSelector {
  readonly type: "TextQuoteSelector";
  readonly exact: string;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly refinedBy?: TextPositionSelector;
}

export interface TimeState {
  readonly type: "TimeState";
  readonly sourceDate?: string;
  readonly cached?: string;
}

export type EvidenceRelation = "supports" | "partial" | "contradicts" | "context";

/** One evidence entry in a claim's `evidence[]`. */
export interface EvidenceSpan {
  readonly sourceId: string;
  readonly snapshotHash: string;
  readonly selector: TextQuoteSelector;
  readonly state?: TimeState;
  readonly relation: EvidenceRelation;
  readonly anchorStatus: AnchorStatus;
}

/** `sourced` cites external evidence; `derived` cites other claims; `operator` cites the session transcript (D19). */
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
  readonly inputHash: string;
  readonly rationale?: string;
  readonly relevance?: Relevance;
  readonly conflictsWith?: readonly string[];
}

export interface Claim {
  readonly id: string;
  readonly label: string;
  readonly kind: ClaimKind;
  readonly text: string;
  readonly decontextualized: string;
  readonly checkRequired: boolean;
  readonly evidence: readonly EvidenceSpan[];
  readonly supports: readonly string[];
  readonly verification: Verification;
  readonly overgeneralizationRisk?: OvergeneralizationRisk;
}

export interface NarrativeSentenceClassification {
  readonly sentenceHash: string;
  readonly checkRequired: boolean;
}

export interface NarrativeSummary {
  readonly sentences: number;
  readonly ratio: number;
  readonly classifiedBy?: string;
  readonly classifications?: readonly NarrativeSentenceClassification[];
}

/**
 * `GET /api/volumes/:slug/chapters/:chapter`'s `claims` field — the whole
 * sidecar, NOT a `Claim[]` (`handlers/chapters.ts`'s `getChapter` returns
 * `deps.evidenceStore.getClaims(...)` verbatim, and that's what
 * `EvidenceStore.getClaims` returns). `undefined` when the chapter has never
 * been audited. Read `.claims` for the array.
 */
export interface ClaimSidecar {
  readonly schemaVersion: "1.0";
  readonly chapter: string;
  readonly chapterTextSha256: string;
  readonly auditedAt?: string;
  readonly claims: readonly Claim[];
  readonly narrative?: NarrativeSummary;
}

// ---- audit ----------------------------------------------------------------
//
// Three distinct shapes on the wire, not one — reconciled toward each
// endpoint's real payload rather than forced into a shared `AuditResult`:
//   - `AuditRecord`: `GET .../chapters/:chapter`'s `audit` field
//     (`EvidenceStore.getAudit`, persisted `audits/<slug>.audit.json`).
//   - `PutChapterAudit`: `PUT .../chapters/:chapter`'s `audit` field
//     (`handlers/chapters.ts` builds this ad hoc from `PublishResult`).
//   - the SSE `audit` event's `data` (see `ChatStreamEvent` below) —
//     `chapter-audit`'s real fields, `{ volume, chapter, passed, repairs }`,
//     no `outcomes`/`issues` (those arrive later, on `chapter.rejected`).

export interface CheckIssue {
  readonly code: string;
  readonly message: string;
  readonly label?: string;
}

export interface CheckOutcome {
  readonly checkId: string;
  readonly tier: 0 | 2;
  readonly blocking: boolean;
  readonly passed: boolean;
  readonly issues: readonly CheckIssue[];
  readonly warnings?: readonly CheckIssue[];
  readonly data?: unknown;
}

export interface AuditVerdict {
  readonly chapter: string;
  readonly passed: boolean;
  readonly outcomes: readonly CheckOutcome[];
}

/** `GET .../chapters/:chapter`'s `audit` field — `undefined` until the chapter is first audited. */
export interface AuditRecord {
  readonly chapter: string;
  readonly auditedAt: string;
  readonly verdict: AuditVerdict;
  readonly routingMetadataHash?: string;
}

/** `PUT .../chapters/:chapter`'s `audit` field — `PublishResult` reshaped by `handlers/chapters.ts`, always present (a `PUT` always (re)audits). */
export interface PutChapterAudit {
  readonly verdict: AuditVerdict;
  readonly outcomes: readonly CheckOutcome[];
  readonly repairs: readonly RepairDecision[];
  readonly published: boolean;
}

/** Every failing/warning issue across an `AuditVerdict`'s outcomes, in outcome order — what a UI actually wants to list. */
export function issuesOf(verdict: AuditVerdict): readonly CheckIssue[] {
  return verdict.outcomes.flatMap((outcome) => outcome.issues);
}

// ---- ledger -------------------------------------------------------------

export interface SourceRetrievedEvent {
  readonly ts: string;
  readonly event: "source.retrieved";
  readonly sourceId: string;
  readonly normalizedTextSha256: string;
}

export interface ClaimVerifiedEvent {
  readonly ts: string;
  readonly event: "claim.verified";
  readonly claimId: string;
  readonly status: VerificationStatus;
  readonly inputHash: string;
}

export interface ClaimRestatedEvent {
  readonly ts: string;
  readonly event: "claim.restated";
  readonly claimId: string;
  /** The chapter this restatement happened in — the ledger is volume-wide, a restatement is not. */
  readonly chapter: string;
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  readonly levenshtein: number;
  readonly outcome: "applied" | "escalated";
}

export interface SourceDriftedEvent {
  readonly ts: string;
  readonly event: "source.drifted";
  readonly sourceId: string;
  readonly was: string;
  readonly now: string;
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

export interface ClaimLabelRetiredEvent {
  readonly ts: string;
  readonly event: "claim.label.retired";
  readonly chapter: string;
  readonly label: string;
  readonly claimId: string;
}

export type LedgerEvent =
  | SourceRetrievedEvent
  | ClaimVerifiedEvent
  | ClaimRestatedEvent
  | SourceDriftedEvent
  | AuditCompletedEvent
  | ClaimLabelRetiredEvent;

// ---- index (D11, D11a, D13, D14) -------------------------------------------
//
// `snake_case`, matching `@shadow/indexing`'s `index.json` schema exactly —
// `GET .../index` returns the persisted `VolumeIndexDocument` verbatim, no
// camelCase reshaping layer.

export type Confidence = "high" | "medium" | "provisional";

export interface IndexSpan {
  readonly start_byte: number;
  readonly end_byte: number;
}

export interface SectionIndexNode {
  readonly node_id: string;
  readonly kind: "section";
  readonly title: string;
  readonly level: number;
  readonly heading_path: readonly string[];
  readonly span: IndexSpan;
  readonly tokens: number;
  readonly content_hash: string;
  readonly subtree_hash: string;
  readonly sections?: readonly SectionIndexNode[];
}

export interface ChapterIndexNode {
  readonly node_id: string;
  readonly kind: "chapter";
  readonly title: string;
  readonly slug: string;
  readonly path: readonly [volumeTitle: string, chapterTitle: string];
  readonly file: string;
  readonly when_to_use?: string;
  readonly not_for?: string;
  readonly keywords?: readonly string[];
  readonly confidence?: Confidence;
  readonly supersedes?: readonly string[];
  readonly aliases?: readonly string[];
  readonly updated?: string;
  readonly tokens: number;
  readonly span: IndexSpan;
  readonly content_hash: string;
  readonly subtree_hash: string;
  /** Present only when `tokens >= SECTION_TOKEN_THRESHOLD`. */
  readonly sections?: readonly SectionIndexNode[];
  /** Present only when `sections` is absent. */
  readonly key_items?: readonly string[];
}

export interface VolumeIndexNode {
  readonly volume_id: string;
  readonly title: string;
  readonly when_to_use?: string;
  readonly not_for?: string;
  readonly keywords?: readonly string[];
  readonly chapter_count: number;
  readonly volume_hash: string;
  readonly chapters: readonly ChapterIndexNode[];
}

export interface IndexStats {
  readonly volumes: number;
  readonly chapters: number;
  readonly tokens: number;
}

/**
 * `GET /api/volumes/:slug/index`'s entire response body (the document
 * itself, NOT wrapped in `{ index: ... }` — `handlers/indexing.ts`'s
 * `getIndex` returns it verbatim). A volume that has never been indexed —
 * true of every volume immediately after creation, before its first chapter
 * publishes — 404s with `index_not_built`: a normal state, not a fault
 * (`errors.ts`'s `IndexNotBuiltError`).
 *
 * `POST /api/volumes/:slug/reindex` wraps the SAME document shape as
 * `{ index: VolumeIndexDocument, stats: IndexStats }` instead — a different
 * envelope for the same body, because that handler also returns `stats`.
 */
export interface VolumeIndexDocument {
  readonly schema_version: number;
  readonly generated_at: string;
  readonly corpus_hash: string;
  readonly volume: VolumeIndexNode;
}

export interface LintFinding {
  readonly rule: string;
  readonly chapter?: string;
  readonly message: string;
}

export interface LintReport {
  readonly findings: readonly LintFinding[];
}

// ---- chat / SSE (D5, D6, D9) ----------------------------------------------

export interface ChatInput {
  readonly volumeSlug?: string;
  readonly message: string;
  readonly sessionId?: string;
}

/** What Shadow asked a tool-agent to go find out (`@shadow/research`'s `ResearchBrief`). */
export interface ResearchBrief {
  readonly volume: string;
  readonly goal: string;
  readonly subjectDomains?: readonly string[];
  readonly constraints?: readonly string[];
  readonly maxSources?: number;
}

export interface Citation {
  readonly sourceId: string;
  readonly quote: string;
}

/** One thing a research brief found out (`@shadow/research`'s `Finding`) — NOT a string. */
export interface Finding {
  readonly text: string;
  readonly citations: readonly Citation[];
}

/** One `RepairDecision` (`@shadow/evidence`) — D9's repair table, D21's preservation bound. */
export interface RepairDecision {
  readonly claimId: string;
  readonly label: string;
  readonly chapter: string;
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  readonly levenshtein: number;
  readonly bound: number;
  readonly outcome: "applied" | "escalated";
}

/**
 * `handlers/chat.ts`'s real mapping from `ShadowEvent` to SSE, not
 * `docs/API.md`'s table verbatim — see that handler's module doc for every
 * gap. In particular: `indexed` is never emitted for chat (flagged for
 * `docs/API.md`); `research.failed`, `chapter.published`, `chapter.rejected`
 * ARE emitted despite having no row in the doc table.
 */
export type ChatStreamEvent =
  | { readonly event: "session"; readonly data: { readonly sessionId: string } }
  | { readonly event: "text"; readonly data: { readonly delta: string } }
  | {
      readonly event: "research.started";
      readonly data: { readonly briefId: string; readonly brief: ResearchBrief };
    }
  | {
      readonly event: "research.source";
      readonly data: { readonly sourceId: string; readonly url: string; readonly title: string };
    }
  | {
      readonly event: "research.finished";
      readonly data: { readonly briefId: string; readonly findings: readonly Finding[] };
    }
  | {
      readonly event: "research.failed";
      readonly data: {
        readonly briefId: string;
        readonly brief: ResearchBrief;
        readonly error: string;
      };
    }
  | {
      readonly event: "chapter.drafted";
      readonly data: { readonly volume: string; readonly chapter: string };
    }
  | {
      readonly event: "audit";
      readonly data: {
        readonly volume: string;
        readonly chapter: string;
        readonly passed: boolean;
        readonly repairs: readonly RepairDecision[];
      };
    }
  | {
      readonly event: "chapter.restated";
      readonly data: {
        readonly claim: string;
        readonly from: string;
        readonly to: string;
        readonly reason: string;
        readonly outcome: "applied" | "escalated";
      };
    }
  | {
      readonly event: "chapter.published";
      readonly data: { readonly volume: string; readonly chapter: string };
    }
  | {
      readonly event: "chapter.rejected";
      readonly data: {
        readonly volume: string;
        readonly chapter: string;
        readonly issues: readonly CheckIssue[];
      };
    }
  | { readonly event: "error"; readonly data: { readonly message: string; readonly code: string } }
  | { readonly event: "done"; readonly data: Record<string, never> };

// ---- errors ---------------------------------------------------------------

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
  };
}

export class ApiError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }
}
