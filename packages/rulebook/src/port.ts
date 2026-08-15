/**
 * The public seam of `@shadow/rulebook`: the brief a caller (`RulebookToolAgent`,
 * or the `shadow:rulebook` chat directive above it) hands in, the progress
 * events the pipeline streams back, and the terminal result. This is the
 * only file in the package with no logic at all — every other module is
 * either pure transform (chunker/validate/merge/labels) or a schema for a
 * structured call `extraction.ts`/`rulebook-tool-agent.ts` wires up.
 * `RuleBookPort` itself has no implementation here; `extraction.ts` and
 * `rulebook-tool-agent.ts` build the one real implementation over
 * ingestion, LLM calls, and `RulebookStore`.
 */

import type { TokenUsage } from "@shadow/model";

/** What the caller names, before the pipeline runs. */
export interface RulebookBrief {
  readonly slug: string;
  readonly title: string;
  /** Absolute path to the source document (Markdown/plain text only — see `ingest.ts`) — `ingest.ts` reads this. */
  readonly docPath: string;
  /** Free-text steer for the taxonomy call — e.g. "focus on borrower obligations, not lender remedies". */
  readonly scope?: string;
  /** Extra constraints folded into every structured call's prompt (e.g. "keep group titles under 6 words"). */
  readonly constraints?: readonly string[];
  /** Caps the number of taxonomy groups the LLM may propose. Default 16. */
  readonly maxGroups?: number;
  /** Caps in-flight chunk extractions (see `rulebook-tool-agent.ts`'s `streamWithConcurrency`). Default 6. */
  readonly concurrency?: number;
}

/** Progress streamed out of `RuleBookPort.create`, one event per pipeline milestone. */
export type RulebookEvent =
  | { readonly type: "started"; readonly slug: string; readonly docPath: string }
  | {
      readonly type: "planned";
      readonly chunkCount: number;
      readonly groups: readonly string[];
    }
  | {
      readonly type: "chunk-extracted";
      readonly completed: number;
      readonly total: number;
      readonly rulesSoFar: number;
      /** `true` if this chunk's extraction was served from the extraction cache rather than a fresh LLM call. */
      readonly cached: boolean;
      /** `true` if this chunk's extraction failed outright (both attempts) — contributes to `RulebookResult.failedChunks` and blocks the rule book from ever reading as `"stable"` (see `RulebookResult.failedChunks`). */
      readonly failed: boolean;
    }
  | {
      readonly type: "merged";
      readonly ruleCount: number;
      readonly droppedQuotes: number;
      readonly consolidated: number;
    }
  | {
      readonly type: "group-audited";
      readonly group: string;
      readonly passed: boolean;
      readonly repairs: number;
      readonly issues: readonly string[];
    }
  | { readonly type: "completed"; readonly result: RulebookResult }
  | { readonly type: "failed"; readonly error: string };

/** The terminal shape of a completed rule-book run. */
export interface RulebookResult {
  readonly slug: string;
  readonly sourceId: string;
  /** Post-consolidation rule count (`consolidateRules`'s output length) — the honest count of distinct rules in the book, not the pre-dedup total. */
  readonly ruleCount: number;
  readonly groupCount: number;
  readonly publishedGroups: readonly string[];
  readonly rejectedGroups: readonly string[];
  /** Chunks whose extraction failed outright (both attempts) — a book with any of these must not read as `"stable"` even if every assembled group passed its audit. */
  readonly failedChunks: number;
  /** Individual quotes dropped at assembly time because they failed to bind to the pinned snapshot, summed across every group (`assembleGroup`'s `droppedQuotes`). Expected to be rare — `validate.ts` already checked the same predicate earlier in the pipeline. */
  readonly assemblyDroppedQuotes: number;
  /** Rules dropped entirely at assembly time because every one of their quotes failed to bind, summed across every group (`assembleGroup`'s `droppedRules`). */
  readonly assemblyDroppedRules: number;
  readonly usage: TokenUsage;
  /**
   * The single source of truth for whether this run reads as fully
   * verified — computed once in `RulebookToolAgent.create` from the exact
   * same expression that drives `RulebookStore.updateRulebook`'s own
   * `status`, and carried here so no caller re-derives it. `"stable"` iff
   * at least one group was finalized, no group was rejected by its audit,
   * and no chunk failed extraction outright; `"draft"` otherwise —
   * including the degenerate zero-groups case (a document that yields no
   * rules is not "stable," it just has nothing to be unstable about).
   * Every caller (`@shadow/agent`'s follow-up text, the web transcript's
   * badge) must read this field rather than recomputing the predicate.
   */
  readonly status: "stable" | "draft";
}

/** The one entry point: hand in a brief, get a stream of progress events ending in `completed`/`failed`. */
export interface RuleBookPort {
  create(brief: RulebookBrief): AsyncIterable<RulebookEvent>;
}
