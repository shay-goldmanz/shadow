/**
 * Wire types for `docs/API.md`.
 *
 * `docs/API.md` pins endpoint signatures but not every JSON shape (it says
 * `{ volume }`, `{ chapter, claims?, audit? }`, `{ events }`, and so on
 * without a field-level schema for `Volume`, `Claim`, `AuditResult`,
 * `IndexTree`, `SourceRecord`, or `LedgerEvent`). This file is a
 * good-faith reconstruction, informed by `docs/DECISIONS.md` (D9, D13,
 * D16, D18, D19, D22) and the domain shapes those decisions describe, but
 * it is a guess at the wire format, not a shared contract with
 * `@shadow/api`. Flagged for reconciliation once `@shadow/api` exists —
 * see the final implementation report.
 *
 * Dates cross the wire as ISO 8601 strings (JSON has no Date type), unlike
 * the in-process domain types other packages may use.
 */

// ---- volumes ----------------------------------------------------------

export interface VolumeSummary {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly chapterCount: number;
  readonly updatedAt: string;
}

export interface Volume {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateVolumeInput {
  readonly slug?: string;
  readonly title: string;
  readonly description?: string;
}

export interface UpdateVolumeInput {
  readonly title?: string;
  readonly description?: string;
  readonly frontmatter?: Readonly<Record<string, unknown>>;
}

// ---- chapters -----------------------------------------------------------

export interface ChapterSummary {
  readonly slug: string;
  readonly title: string;
  readonly whenToUse?: string;
  readonly updatedAt: string;
}

export interface Chapter {
  readonly slug: string;
  readonly title: string;
  readonly body: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PutChapterInput {
  readonly title: string;
  readonly body: string;
  readonly frontmatter?: Readonly<Record<string, unknown>>;
}

// ---- evidence (D9, D16, D18, D19, D22) -----------------------------------

/** How a resolved evidence span relates to its pinned snapshot. Orphan is a state, not an error (D16, D22). */
export type AnchorStatus = "anchored" | "anchored-fuzzy" | "orphaned";

export interface EvidenceSpan {
  readonly sourceId: string;
  readonly snapshotHash: string;
  readonly exact: string;
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

export interface Claim {
  readonly label: string;
  readonly kind: ClaimKind;
  readonly text: string;
  readonly checkRequired: boolean;
  readonly evidence: readonly EvidenceSpan[];
  readonly status: VerificationStatus;
  readonly rationale?: string;
}

export interface AuditFinding {
  readonly claim: string;
  readonly check: string;
  readonly message: string;
}

export interface AuditResult {
  readonly verdict: "pass" | "fail";
  readonly findings: readonly AuditFinding[];
  readonly narrativeRatio?: number;
  readonly extractiveness?: number;
}

export interface SourceRecord {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly author: string | null;
  readonly publishedAt: string | null;
  readonly transport: "live" | "fixture" | "session";
  readonly retrievedAt: string;
}

export type LedgerEvent =
  | { readonly ts: string; readonly event: "source.retrieved"; readonly sourceId: string }
  | {
      readonly ts: string;
      readonly event: "claim.verified";
      readonly claimId: string;
      readonly status: VerificationStatus;
    }
  | {
      readonly ts: string;
      readonly event: "claim.restated";
      readonly claimId: string;
      readonly from: string;
      readonly to: string;
      readonly reason: string;
      readonly outcome: "applied" | "escalated";
    }
  | {
      readonly ts: string;
      readonly event: "source.drifted";
      readonly sourceId: string;
      readonly invalidatedClaims: number;
    }
  | {
      readonly ts: string;
      readonly event: "audit.completed";
      readonly chapter: string;
      readonly result: "pass" | "fail";
    };

// ---- index (D11, D11a, D13, D14) -----------------------------------------

export interface IndexNode {
  readonly id: string;
  readonly title: string;
  readonly headingPath: readonly string[];
  readonly whenToUse?: string;
  readonly notFor?: string;
  readonly children?: readonly IndexNode[];
}

export interface IndexTree {
  readonly volume: string;
  readonly generatedAt: string;
  readonly nodes: readonly IndexNode[];
}

export interface IndexStats {
  readonly volumes: number;
  readonly chapters: number;
  readonly tokens: number;
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

export type ChatStreamEvent =
  | { readonly event: "session"; readonly data: { readonly sessionId: string } }
  | { readonly event: "text"; readonly data: { readonly delta: string } }
  | { readonly event: "research.started"; readonly data: { readonly brief: string } }
  | {
      readonly event: "research.source";
      readonly data: { readonly sourceId: string; readonly url: string; readonly title: string };
    }
  | {
      readonly event: "research.finished";
      readonly data: { readonly briefId: string; readonly findings: string };
    }
  | {
      readonly event: "chapter.drafted";
      readonly data: { readonly volume: string; readonly chapter: string };
    }
  | {
      readonly event: "audit";
      readonly data: {
        readonly chapter: string;
        readonly verdict: "pass" | "fail";
        readonly findings: readonly AuditFinding[];
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
      readonly event: "indexed";
      readonly data: { readonly volume: string; readonly stats: IndexStats };
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
