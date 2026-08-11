/**
 * Port 1 — structured generation (D5).
 *
 * Tool-less, Zod-typed generation for the workloads that need typed output
 * and nothing else: index node summaries, tree synthesis, retrieval node
 * selection, eval judging. Backed by Vercel AI SDK `generateObject` via
 * `ai-sdk-provider-claude-code` — see
 * `../adapters/claude-code-structured-generation.ts`.
 *
 * Deliberately narrow: one method, no session state, no tool wiring. That
 * is what makes `FakeStructuredGenerationPort` (`../fakes/`) a complete,
 * honest stand-in for tests — there is no adapter-only behavior for a fake
 * to fail to reproduce.
 */

import type { ZodType } from "zod";
import type { TokenUsage } from "../usage.ts";

export interface StructuredGenerationRequest<Output> {
  /** The shape the model must produce. Validated by the adapter before it returns — a schema mismatch surfaces as `StructuredGenerationError`, never a silently-wrong object. */
  readonly schema: ZodType<Output>;
  readonly prompt: string;
  readonly system?: string;
  /** Optional name/description surfaced to the model for extra guidance (tool/schema name in providers that use one). Cosmetic — never affects validation. */
  readonly schemaName?: string;
  readonly schemaDescription?: string;
  /** Override the adapter's default model for this call — e.g. a stronger model for eval judging, a cheaper one for routine summarization. */
  readonly model?: string;
}

export interface StructuredGenerationResult<Output> {
  readonly object: Output;
  readonly usage: TokenUsage;
}

export interface StructuredGenerationPort {
  /**
   * @throws {StructuredGenerationError} on a schema-validation failure or a
   *   transport/CLI error.
   * @throws {SubscriptionAuthError} per D5's guardrail — resolved
   *   credentials that are not the operator's subscription, or (fail
   *   closed) no confirmation of the operator's subscription was ever
   *   observed at all. Mirrors Port 2's `AgenticSession.stream` contract
   *   (`../ports/agentic-session.ts`).
   */
  generate<Output>(
    request: StructuredGenerationRequest<Output>,
  ): Promise<StructuredGenerationResult<Output>>;
}
