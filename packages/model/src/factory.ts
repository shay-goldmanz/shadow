/**
 * Construction entry point (SOLID: adapters are built here, behind a
 * factory — callers depend on `StructuredGenerationPort`/`AgenticSessionPort`,
 * never on `ClaudeCodeStructuredGenerationPort`/`ClaudeAgentSdkSessionPort`
 * by name). `createModel` is the convenience for a caller that wants both
 * ports from one place (e.g. `@shadow/agent`); a caller that only needs one
 * (e.g. `@shadow/indexing` only ever calls structured generation) can use
 * the individual `create*Port` functions directly — both are exported by
 * `../index.ts` typed as the port interface, not the concrete class.
 */

import {
  type ClaudeAgentSdkSessionDefaults,
  createClaudeAgentSdkSessionPort,
} from "./adapters/claude-agent-sdk-session.ts";
import {
  type ClaudeCodeStructuredGenerationOptions,
  createClaudeCodeStructuredGenerationPort,
} from "./adapters/claude-code-structured-generation.ts";
import type {
  AgenticSession,
  AgenticSessionOptions,
  AgenticSessionPort,
} from "./ports/agentic-session.ts";
import { conservativeRetryPolicy, type RetryPolicy } from "./ports/retry-policy.ts";
import type { StructuredGenerationPort } from "./ports/structured-generation.ts";
import { RetryingAgenticSession } from "./retrying-agentic-session.ts";

export interface Model {
  /**
   * Every session this port hands out (`createSession()`) is already
   * wrapped in T1.3's `RetryingAgenticSession`, governed by `retryPolicy`
   * below — Shadow chat's session, each per-brief research agent's, the
   * search provider's, all get retry behavior without knowing, since they
   * only ever depend on `AgenticSessionPort`/`AgenticSession`, never on the
   * concrete class. `noRetryPolicy` makes the wrapping a true no-op (see
   * `CreateModelOptions.retryPolicy`'s doc).
   */
  readonly structuredGeneration: StructuredGenerationPort;
  readonly agenticSession: AgenticSessionPort;
  /**
   * The resolved retry policy for this model's `agenticSession` (T1.2's
   * `conservativeRetryPolicy` unless overridden — see
   * `CreateModelOptions.retryPolicy`). Exposed here too so a caller can
   * inspect/log which policy is active without reaching into
   * `agenticSession`'s wrapping.
   */
  readonly retryPolicy: RetryPolicy;
}

export interface CreateModelOptions {
  readonly structuredGeneration?: ClaudeCodeStructuredGenerationOptions;
  readonly agenticSession?: ClaudeAgentSdkSessionDefaults;
  /**
   * Retry policy for agentic session turns (`../ports/retry-policy.ts`).
   * Wired into a `RetryingAgenticSession` decorator wrapping every session
   * the `agenticSession` port built below hands out (T1.3) — the swap
   * point for a caller that wants different retry behavior (or none — pass
   * `noRetryPolicy`, which makes the wrapping a true no-op): one option
   * here, threaded from `packages/api/src/composition.ts`'s
   * `BuildRealApiDepsOptions.retryPolicy`.
   * @default conservativeRetryPolicy
   */
  readonly retryPolicy?: RetryPolicy;
}

/**
 * Wraps `port` so every session it creates is a `RetryingAgenticSession`
 * governed by `policy` — the seam that covers every caller of
 * `Model.agenticSession` (Shadow chat, each per-brief research agent, the
 * search provider) without any of them knowing, since they depend only on
 * the `AgenticSessionPort`/`AgenticSession` interfaces (`./ports/agentic-session.ts`),
 * never on `ClaudeAgentSdkSessionPort` by name.
 */
function withRetrying(port: AgenticSessionPort, policy: RetryPolicy): AgenticSessionPort {
  return {
    createSession(options?: AgenticSessionOptions): AgenticSession {
      return new RetryingAgenticSession(port.createSession(options), policy);
    },
  };
}

/** Build both ports at once, each backed by its real (subscription-auth-enforced) adapter. */
export function createModel(options: CreateModelOptions = {}): Model {
  const retryPolicy = options.retryPolicy ?? conservativeRetryPolicy;
  return {
    structuredGeneration: createClaudeCodeStructuredGenerationPort(options.structuredGeneration),
    agenticSession: withRetrying(
      createClaudeAgentSdkSessionPort(options.agenticSession),
      retryPolicy,
    ),
    retryPolicy,
  };
}
