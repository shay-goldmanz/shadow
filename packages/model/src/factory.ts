/**
 * Construction entry point (SOLID: adapters are built here, behind a
 * factory — callers depend on `StructuredGenerationPort`/`AgenticSessionPort`,
 * never on a concrete adapter class by name). `createModel` is the
 * convenience for a caller that wants both ports from one place (e.g.
 * `@shadow/agent`); a caller that only needs one (e.g. `@shadow/indexing`
 * only ever calls structured generation) can use the individual
 * `create*Port` functions directly — both are exported by `../index.ts`
 * typed as the port interface, not the concrete class.
 *
 * `CreateModelOptions` is a **provider strategy** seam (DECISIONS.md D26):
 * `provider` selects which strategy builds the two ports, defaulting to
 * `"claude-code"` (D5's original, subscription-only adapters, guardrail
 * untouched) when omitted. `"bedrock"` is a second strategy that
 * authenticates via the AWS SDK's own credential chain instead — see D26 for
 * why that's a deliberate amendment, not a silent bypass, of D5's
 * acceptance criterion. Until Bedrock's real adapters land,
 * `provider: "bedrock"` builds a stub that throws immediately rather than
 * silently returning something that behaves like a real port.
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

/** Which provider strategy builds the two ports (D26). */
export type ModelProvider = "claude-code" | "bedrock";

/** Per-adapter options for the `"claude-code"` strategy — D5's original two transports. */
export interface ClaudeCodeModelOptions {
  readonly structuredGeneration?: ClaudeCodeStructuredGenerationOptions;
  readonly agenticSession?: ClaudeAgentSdkSessionDefaults;
}

/**
 * Options for the `"bedrock"` strategy. Deliberately minimal here — the real
 * adapters will extend this shape as needed (region, inference profile,
 * etc.); `model` is the one option every caller of this factory already
 * knows how to supply.
 */
export interface BedrockModelOptions {
  readonly model?: string;
}

export interface CreateModelOptions {
  /** Provider strategy to build. @default "claude-code" — an unset or unrecognized value never falls through to bedrock. */
  readonly provider?: ModelProvider;
  readonly claudeCode?: ClaudeCodeModelOptions;
  readonly bedrock?: BedrockModelOptions;
}

/**
 * Build both ports at once, via whichever provider strategy `options.provider`
 * selects (defaulting to `"claude-code"`). Each strategy is responsible for
 * its own auth model; the `"claude-code"` strategy's is D5's subscription
 * guardrail, enforced inside its adapters exactly as before this seam existed.
 */
export function createModel(options: CreateModelOptions = {}): Model {
  const provider = options.provider ?? "claude-code";

  switch (provider) {
    case "bedrock":
      return createBedrockModel(options.bedrock);
    case "claude-code":
      return createClaudeCodeModel(options.claudeCode);
    default: {
      // Exhaustiveness guard: a new `ModelProvider` member must be handled
      // above, not silently fall through to a default strategy.
      const unreachable: never = provider;
      throw new Error(`@shadow/model: unhandled provider strategy ${String(unreachable)}`);
    }
  }
}

function createClaudeCodeModel(options: ClaudeCodeModelOptions = {}): Model {
  return {
    structuredGeneration: createClaudeCodeStructuredGenerationPort(options.structuredGeneration),
    agenticSession: createClaudeAgentSdkSessionPort(options.agenticSession),
  };
}

/**
 * Stub for the `"bedrock"` strategy (D26). Real adapters over
 * `@ai-sdk/amazon-bedrock` replace this; until then, selecting this provider
 * fails loudly and immediately rather than handing back a port that would
 * fail confusingly on first use.
 */
function createBedrockModel(_options?: BedrockModelOptions): Model {
  throw new Error(
    "@shadow/model: provider \"bedrock\" is not implemented yet (see docs/DECISIONS.md D26).",
  );
}
