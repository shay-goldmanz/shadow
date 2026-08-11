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
import type { StructuredGenerationPort } from "./ports/structured-generation.ts";

export interface Model {
  readonly structuredGeneration: StructuredGenerationPort;
  readonly agenticSession: AgenticSessionPort;
}

export interface CreateModelOptions {
  readonly structuredGeneration?: ClaudeCodeStructuredGenerationOptions;
  readonly agenticSession?: ClaudeAgentSdkSessionDefaults;
}

/** Build both ports at once, each backed by its real (subscription-auth-enforced) adapter. */
export function createModel(options: CreateModelOptions = {}): Model {
  return {
    structuredGeneration: createClaudeCodeStructuredGenerationPort(options.structuredGeneration),
    agenticSession: createClaudeAgentSdkSessionPort(options.agenticSession),
  };
}
