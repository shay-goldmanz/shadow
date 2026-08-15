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
 * acceptance criterion. Both ports have real adapters: `structuredGeneration`
 * over `@ai-sdk/amazon-bedrock`, and `agenticSession` over Vercel AI SDK
 * `streamText`, whose tool-loop design is documented in
 * `adapters/bedrock-agentic-session.ts` — see `createBedrockModel`.
 */

import { createBedrockAgenticSessionPort } from "./adapters/bedrock-agentic-session.ts";
import { createBedrockStructuredGenerationPort } from "./adapters/bedrock-structured-generation.ts";
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
 * Options for the `"bedrock"` strategy, shared by both of its adapters
 * (structured generation and agentic session). `model` is the one option
 * every caller of this factory already knows how to supply (a short name like
 * `"sonnet"` or a full Bedrock inference-profile id — see
 * `bedrock-structured-generation.ts`'s `MODEL_SHORT_NAMES`). `region` and
 * `apiKey` are optional overrides for the same adapter's settings — both
 * left `undefined` here fall through to `createBedrockModel`'s own
 * `AWS_REGION`/`"us-east-1"` resolution and the Bedrock SDK's own
 * `AWS_BEARER_TOKEN_BEDROCK`/AWS-credential-chain resolution, respectively.
 */
export interface BedrockModelOptions {
  readonly model?: string;
  readonly region?: string;
  readonly apiKey?: string;
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

/** Fallback region when neither `BedrockModelOptions.region` nor `AWS_REGION` is set. Documented default, not a silent guess — see `BedrockModelOptions`'s doc. */
const BEDROCK_DEFAULT_REGION = "us-east-1";

/**
 * The `"bedrock"` strategy (D26). Both ports are real: structured generation
 * over `generateObject`, agentic sessions over `streamText`'s own multi-step
 * tool loop (see `adapters/bedrock-agentic-session.ts` for the loop design).
 * `region`/`apiKey` are shared by both adapters, same as `model` defaulting
 * per port via the one shared `BEDROCK_DEFAULT_MODEL`.
 */
function createBedrockModel(options: BedrockModelOptions = {}): Model {
  const region = options.region ?? process.env.AWS_REGION ?? BEDROCK_DEFAULT_REGION;

  return {
    structuredGeneration: createBedrockStructuredGenerationPort({
      model: options.model,
      region,
      apiKey: options.apiKey,
    }),
    agenticSession: createBedrockAgenticSessionPort({
      model: options.model,
      region,
      apiKey: options.apiKey,
    }),
  };
}
