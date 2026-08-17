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

export type RetrievalTransport = "live" | "fixture" | "session";
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
  // T2.2's new wire event (F7 review fix — the web types/fake were built
  // before it existed). The user bubble: emitted once per turn, right
  // after `session` and before any agent event (`@shadow/api`'s
  // `handlers/chat.ts` synthesizes it — `@shadow/agent` never emits an
  // `operator-message` `ShadowEvent`). See `event-mapping.ts`'s module doc
  // for the full live/replay story.
  | { readonly event: "operator"; readonly data: { readonly text: string } }
  // `seq` (F2/F4 review fix): present ONLY on `GET /api/sessions/:id/events`
  // (`POST /api/chat` never stamps one — `@shadow/api`'s `event-mapping.ts`
  // module doc). Its presence, not its value, is the semantic switch
  // `chat-transcript.ts`'s reducer reads: a `seq`-carrying `text` is the
  // FULL text of one stored `assistant-message` record (the follow
  // endpoint's live tail now maps that record the same way replay always
  // has, instead of suppressing it) and REPLACES the current assistant
  // bubble outright; a seq-less `text` is one live, transient, chunked
  // delta and APPENDS. See `SessionEventEnvelope`'s doc below for why this
  // is the fix for a viewer who joined mid-message.
  | { readonly event: "text"; readonly data: { readonly delta: string; readonly seq?: number } }
  // T2.8's new wire event — `GET /api/sessions/:id/events` (T2.7) only, the
  // one `turn-boundary` shape that gets a wire representation
  // (`@shadow/api`'s `event-mapping.ts` module doc): a turn stalled with no
  // further events ever coming for it. `POST /api/chat` never sends this —
  // its own stream just ends (a client-side signal `chat-transcript.ts`'s
  // `markInterruptedIfPending` covers separately, for the shape T2.1's
  // torn-tail tolerance can produce that never even wrote a boundary
  // record, so the wire has nothing to carry at all).
  | { readonly event: "turn.interrupted"; readonly data: Record<string, never> }
  // F3 review fix — `GET /api/sessions/:id/events` only, same family as
  // `turn.interrupted` above: the OTHER `turn-boundary` outcome, a turn that
  // finished normally. Without this, a follow viewer's `turnPending`
  // (`chat-transcript.ts`'s `ChatState` doc) had no way to learn a turn it
  // watched actually completed — `?follow=true` never sends `done` (a
  // follow stream stays open across turns on purpose), so a later
  // connection blip on an already-finished turn would get mis-marked
  // `turn.interrupted` by `markInterruptedIfPending`, offering a live Retry
  // for a turn that already succeeded (resending would duplicate it). The
  // reducer clears `turnPending` on this and nothing else.
  | { readonly event: "turn.ended"; readonly data: Record<string, never> }
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

/**
 * One event from `GET /api/sessions/:id/events` (T2.7/T2.8) — replay,
 * optionally followed live. The same `ChatStreamEvent` vocabulary
 * `POST /api/chat` sends (`session` never actually appears; that event is
 * `POST /api/chat`-only, minted at enqueue time, not stored), plus
 * `turn.interrupted` and `turn.ended`.
 *
 * `seq` is lifted to the ENVELOPE rather than folded into each variant's
 * `data` — `ChatStreamEvent`'s own shapes stay exactly what `POST /api/chat`
 * sends, with no endpoint-specific field bolted onto all thirteen of them —
 * and is `undefined` for the two events this endpoint can send that carry
 * no backing `StoredEventRecord`: a live-tail `text` DELTA (chunked, no
 * seq'd record of its own) and the replay-only `done` marker (not derived
 * from any one record; `?follow=true` never sends it at all — `@shadow/api`'s
 * `session-events.ts` module doc). `seq` is the reconnect cursor per T2.7's
 * inclusive `fromSeq` contract: reconnecting with `fromSeq = seq + 1` never
 * re-delivers this event and never skips whatever came after it either.
 *
 * **F2/F4 review fix — what a `seq`-carrying `text` actually means.** The
 * claim this doc used to make here — a live delta's missing `seq` "doesn't
 * matter because the eventual `assistant-message` record's seq covers the
 * text it sums to" — was false: the follow endpoint's live tail used to
 * suppress the stored `assistant-message` record entirely (the same
 * suppression the LIVE `POST /api/chat` path needs, to avoid double-sending
 * text it already streamed chunk by chunk — but the follow endpoint has no
 * such live history to avoid duplicating, for a viewer who only just
 * subscribed). A viewer who joined mid-message therefore never received
 * that message's prefix from BEFORE they joined, and nothing ever arrived to
 * correct that gap. Fixed: the follow endpoint's live tail now maps a
 * completed `assistant-message` record the same way replay always has —
 * one `seq`-stamped `text` event carrying the FULL accumulated string. The
 * client reducer (`../pages/chat-transcript.ts`) reads `seq`'s mere
 * PRESENCE as the semantic switch: a `seq`-carrying `text` REPLACES the
 * current assistant bubble outright (it is the authoritative full text,
 * self-correcting any prefix loss or, on a `fromSeq` reconnect after a
 * partially-seen message, duplication); a seq-less `text` is a live,
 * transient, chunked delta and APPENDS, exactly as before.
 */
export interface SessionEventEnvelope {
  readonly event: ChatStreamEvent["event"];
  readonly data: unknown;
  readonly seq: number | undefined;
}

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
