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
import type { AgenticSessionPort } from "./ports/agentic-session.ts";
import { conservativeRetryPolicy, type RetryPolicy } from "./ports/retry-policy.ts";
import type { StructuredGenerationPort } from "./ports/structured-generation.ts";

export interface Model {
  readonly structuredGeneration: StructuredGenerationPort;
  readonly agenticSession: AgenticSessionPort;
  /**
   * The resolved retry policy for this model's `agenticSession` (T1.2's
   * `conservativeRetryPolicy` unless overridden — see
   * `CreateModelOptions.retryPolicy`). Not yet applied to `agenticSession`
   * itself: T1.3's `RetryingAgenticSession` decorator is what will wrap
   * `agenticSession` with this policy, inside this function, so every
   * caller (Shadow chat, research tool-agents) gets retry behavior without
   * knowing. Exposed here in the meantime so that wiring is a change to
   * this function's `return`, not a new option to plumb through every
   * caller of `createModel`.
   */
  readonly retryPolicy: RetryPolicy;
}

export interface CreateModelOptions {
  readonly structuredGeneration?: ClaudeCodeStructuredGenerationOptions;
  readonly agenticSession?: ClaudeAgentSdkSessionDefaults;
  /**
   * Retry policy for agentic session turns (`../ports/retry-policy.ts`).
   * T1.3 wires this into a `RetryingAgenticSession` decorator around the
   * `agenticSession` port built below; until that lands, this option is
   * accepted and resolved (`Model.retryPolicy`) but not yet consumed — no
   * turn actually gets retried yet. The swap point for a caller that wants
   * different retry behavior (or none — pass `noRetryPolicy`) either way:
   * one option here, threaded from `packages/api/src/composition.ts`'s
   * `BuildRealApiDepsOptions.retryPolicy`.
   * @default conservativeRetryPolicy
   */
  readonly retryPolicy?: RetryPolicy;
}

/** Build both ports at once, each backed by its real (subscription-auth-enforced) adapter. */
export function createModel(options: CreateModelOptions = {}): Model {
  return {
    structuredGeneration: createClaudeCodeStructuredGenerationPort(options.structuredGeneration),
    agenticSession: createClaudeAgentSdkSessionPort(options.agenticSession),
    retryPolicy: options.retryPolicy ?? conservativeRetryPolicy,
  };
}
