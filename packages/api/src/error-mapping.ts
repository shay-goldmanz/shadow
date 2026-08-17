/**
 * Turns any error a handler throws into `docs/API.md`'s stable error
 * envelope: `{ error: { code, message, details? } }`. This is the ONE place
 * that decides HTTP status codes for typed pillar errors — handlers never
 * catch and map errors themselves (`server.ts`'s `withErrorHandling` wraps
 * every route). That keeps the mapping exhaustive and auditable in one
 * file rather than scattered per-handler.
 *
 * The rule from `docs/API.md`: **4xx for operator error** (the pillars
 * already type these — an invalid slug, a not-found volume, a malformed
 * request), **5xx only for genuine faults** (a corrupt ledger, a parse
 * failure on a file that should never have been malformed, a subscription
 * auth failure, an unmapped/unexpected error).
 *
 * A failing CoE audit is explicitly NOT here: it is never thrown as an
 * error by any pillar (`publishChapter` returns a `PublishResult` with
 * `verdict.passed: false`), so there is nothing for this module to map —
 * the handlers that call it return 200 with the failing verdict in the
 * body, by construction.
 */

import {
  AutoTurnBudgetExceededError,
  ChapterHasNoClaimsError,
  ClaimMissingRequiredFieldError,
  MalformedDirectiveError,
  ShadowTurnFailedError,
  SkillInstallError,
  UnknownSourceError,
  UnresolvedEvidenceQuoteError,
} from "@shadow/agent";
import {
  ChapterNotFoundError,
  ChapterParseError,
  InvalidSlugError,
  ReservedFrontmatterKeyError,
  VolumeAlreadyExistsError,
  VolumeNotFoundError,
  VolumeParseError,
} from "@shadow/core";
import {
  ClaimSidecarNotFoundError,
  InvalidDigestError,
  InvalidIdError,
  LedgerCorruptError,
  SnapshotNotFoundError,
  SourceNotFoundError,
} from "@shadow/evidence";
import {
  ChapterIndexBuildError,
  InvalidRoutingFieldError,
  LintConfigError,
  NodeNotFoundError,
} from "@shadow/indexing";
import {
  AgenticSessionError,
  StructuredGenerationError,
  SubscriptionAuthError,
} from "@shadow/model";
import {
  FixtureCorpusError,
  FixtureMissError,
  LiveSearchUnavailableError,
  NoFindingsProducedError,
  PayloadTooLargeError,
  ResearchTurnFailedError,
  RetrievalNetworkError,
  RetrievalTimeoutError,
  SourceBudgetExceededError,
  UnboundCitationError,
  UnsuccessfulHttpStatusError,
  UnsupportedContentTypeError,
} from "@shadow/research";
import { ShadowApiError } from "./errors.ts";

export interface ErrorResponseBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details: Record<string, unknown>;
  };
}

export interface ErrorResponse {
  readonly status: number;
  readonly body: ErrorResponseBody;
}

// biome-ignore lint/suspicious/noExplicitAny: error constructors are inherently heterogeneous
type AnyErrorCtor = new (...args: any[]) => Error;

/** `[errorClass, httpStatus, stableCode]`. Order doesn't matter — lookup is by `instanceof`, checked most-specific-first only in the sense that no two entries here share a base/derived relationship. */
const PILLAR_ERROR_TABLE: ReadonlyArray<readonly [AnyErrorCtor, number, string]> = [
  // ---- @shadow/core: operator input, mostly ----
  [InvalidSlugError, 400, "invalid_slug"],
  [ReservedFrontmatterKeyError, 400, "reserved_frontmatter_key"],
  [VolumeNotFoundError, 404, "volume_not_found"],
  [VolumeAlreadyExistsError, 409, "volume_already_exists"],
  [ChapterNotFoundError, 404, "chapter_not_found"],
  [ChapterParseError, 500, "chapter_parse_error"],
  [VolumeParseError, 500, "volume_parse_error"],

  // ---- @shadow/evidence ----
  [InvalidIdError, 400, "invalid_id"],
  [InvalidDigestError, 400, "invalid_digest"],
  [SourceNotFoundError, 404, "source_not_found"],
  [SnapshotNotFoundError, 404, "snapshot_not_found"],
  [ClaimSidecarNotFoundError, 404, "claim_sidecar_not_found"],
  [LedgerCorruptError, 500, "ledger_corrupt"],

  // ---- @shadow/indexing ----
  [InvalidRoutingFieldError, 400, "invalid_routing_field"],
  [ChapterIndexBuildError, 500, "chapter_index_build_failed"],
  [NodeNotFoundError, 404, "node_not_found"],
  [LintConfigError, 500, "lint_config_error"],

  // ---- @shadow/agent ----
  // Chapter-draft/publish validation errors that can surface from the
  // direct `PUT .../chapters/:chapter` write path (chat's own auto-turn
  // loop catches these itself and folds them into the conversational
  // reply, so they only reach here from the REST endpoint).
  [ClaimMissingRequiredFieldError, 400, "claim_missing_required_field"],
  [UnknownSourceError, 400, "unknown_source"],
  [UnresolvedEvidenceQuoteError, 400, "unresolved_evidence_quote"],
  [ChapterHasNoClaimsError, 422, "chapter_has_no_claims"],
  [SkillInstallError, 500, "skill_install_failed"],
  [MalformedDirectiveError, 500, "shadow_malformed_directive"],
  [ShadowTurnFailedError, 500, "shadow_turn_failed"],
  [AutoTurnBudgetExceededError, 500, "auto_turn_budget_exceeded"],

  // ---- @shadow/model: D5's guardrail and transport faults, all genuine faults ----
  [SubscriptionAuthError, 500, "subscription_auth_error"],
  [StructuredGenerationError, 500, "structured_generation_failed"],
  [AgenticSessionError, 500, "agentic_session_failed"],

  // ---- @shadow/research: only reachable if research ever runs outside
  // the chat auto-turn loop's own try/catch (defensive; not currently
  // exercised by any @shadow/api endpoint directly) ----
  //
  // P3 review fix: `research_agent_busy` (`ResearchAgentBusyError`) is
  // retired from this table. PLAN.md's T0.1 entry always said this row
  // stays "until Tier 0 is proven live, then is retired" — Tier 0 removed
  // the shared research agent that could ever throw it on a real request
  // path (`PerBriefResearchAgent`'s own doc: a fresh `WebResearchToolAgent`
  // per brief means its `busy` guard can never actually fire from here),
  // and that's now proven, not just designed: T0.3's handler test and the
  // full sessions e2e both exercise concurrent research without it ever
  // surfacing (`handlers/research-concurrency.test.ts`'s own module doc).
  // `ResearchAgentBusyError` itself is NOT retired — `WebResearchToolAgent`
  // still throws it from its own instance-level guard (`web-research-tool-
  // agent.ts`) and `web-research-tool-agent.test.ts` still pins that — only
  // this API-level mapping row, unreachable in practice, is gone. A future
  // caller that DID somehow trigger it now falls through to the generic
  // `internal_error` 500 below, same as any other genuinely-unexpected
  // pillar error this table doesn't name.
  [RetrievalNetworkError, 502, "retrieval_network_error"],
  [RetrievalTimeoutError, 504, "retrieval_timeout"],
  [PayloadTooLargeError, 502, "retrieval_payload_too_large"],
  [UnsupportedContentTypeError, 502, "retrieval_unsupported_content_type"],
  [UnsuccessfulHttpStatusError, 502, "retrieval_http_error"],
  [FixtureMissError, 500, "fixture_miss"],
  [FixtureCorpusError, 500, "fixture_corpus_error"],
  [LiveSearchUnavailableError, 502, "live_search_unavailable"],
  [UnboundCitationError, 500, "unbound_citation"],
  [SourceBudgetExceededError, 400, "source_budget_exceeded"],
  [ResearchTurnFailedError, 500, "research_turn_failed"],
  [NoFindingsProducedError, 500, "no_findings_produced"],
];

function detailsOf(error: Error): Record<string, unknown> {
  if (error instanceof ShadowApiError && error instanceof Error) {
    const withDetails = error as Error & { details?: Record<string, unknown> };
    if (withDetails.details) return withDetails.details;
  }
  // Every pillar error's own constructor already folds its identifying
  // fields into `message` (see e.g. `VolumeNotFoundError`, `InvalidSlugError`).
  // Re-deriving `details` here from arbitrary public fields would mean
  // this module has to know each class's shape — exactly the coupling a
  // single mapping table exists to avoid. `message` already carries them.
  return {};
}

/** Map any thrown value to `docs/API.md`'s error envelope. Never throws itself. */
export function toErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof ShadowApiError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message, details: detailsOf(error) } },
    };
  }

  if (error instanceof SyntaxError) {
    // `await req.json()` on a malformed body.
    return {
      status: 400,
      body: { error: { code: "invalid_json", message: error.message, details: {} } },
    };
  }

  for (const [ctor, status, code] of PILLAR_ERROR_TABLE) {
    if (error instanceof ctor) {
      return { status, body: { error: { code, message: error.message, details: {} } } };
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    status: 500,
    body: { error: { code: "internal_error", message, details: {} } },
  };
}
