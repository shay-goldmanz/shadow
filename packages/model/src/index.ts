/**
 * @shadow/model — the single LLM seam (see `ARCHITECTURE.md`).
 *
 * The only package permitted to import an AI SDK. Exposes two narrow ports
 * — `StructuredGenerationPort` (Zod-typed, tool-less) and
 * `AgenticSessionPort` (tools, skills, subagents, streaming) — over the two
 * transports decided in `DECISIONS.md` D5, and owns session reuse (D6).
 *
 * Invariant this package exists to enforce: the entire stack runs on the
 * operator's subscription. `assertSubscriptionAuth` fails loudly rather
 * than let a call silently fall back to an API key — see `guardrail.ts`.
 *
 * Callers depend on the port interfaces exported here, never on a concrete
 * adapter (`ClaudeCodeStructuredGenerationPort` /
 * `ClaudeAgentSdkSessionPort` are implementation detail, constructed only
 * through the factory functions below). Tests depend on the fakes.
 */

export type {
  BedrockStructuredGenerationOptions,
  BedrockStructuredGenerationPortDeps,
} from "./adapters/bedrock-structured-generation.ts";
export { createBedrockStructuredGenerationPort } from "./adapters/bedrock-structured-generation.ts";
export type {
  ClaudeAgentSdkSessionDefaults,
  ClaudeAgentSdkSessionPortDeps,
} from "./adapters/claude-agent-sdk-session.ts";
export { createClaudeAgentSdkSessionPort } from "./adapters/claude-agent-sdk-session.ts";
export type { ClaudeCodeStructuredGenerationOptions } from "./adapters/claude-code-structured-generation.ts";
export { createClaudeCodeStructuredGenerationPort } from "./adapters/claude-code-structured-generation.ts";
export {
  AgenticSessionError,
  ShadowModelError,
  StructuredGenerationError,
  SubscriptionAuthError,
} from "./errors.ts";
export type {
  BedrockModelOptions,
  ClaudeCodeModelOptions,
  CreateModelOptions,
  Model,
  ModelProvider,
} from "./factory.ts";
export { createModel } from "./factory.ts";
export type {
  FakeAgenticTurnResponder,
  FakeAgenticTurnScript,
} from "./fakes/fake-agentic-session.ts";
export { FakeAgenticSession, FakeAgenticSessionPort } from "./fakes/fake-agentic-session.ts";
export type { FakeStructuredGenerationResponder } from "./fakes/fake-structured-generation.ts";
export { FakeStructuredGenerationPort } from "./fakes/fake-structured-generation.ts";
export type { AuthResolution } from "./guardrail.ts";
export { assertSubscriptionAuth, SUBSCRIPTION_AUTH_SOURCE } from "./guardrail.ts";
export type {
  AgenticSession,
  AgenticSessionOptions,
  AgenticSessionPort,
  AgenticStreamEvent,
  AgenticTurnResult,
  PermissionMode,
  SettingsSource,
  SubagentDefinition,
  SystemPromptOption,
} from "./ports/agentic-session.ts";
export { runToCompletion } from "./ports/agentic-session.ts";
export type {
  StructuredGenerationPort,
  StructuredGenerationRequest,
  StructuredGenerationResult,
} from "./ports/structured-generation.ts";
export type { ToolDefinition, ToolResult, ToolServerHandle } from "./tools.ts";
export { createToolServer, defineTool } from "./tools.ts";
export type { TokenUsage } from "./usage.ts";
export { addUsage, ZERO_USAGE } from "./usage.ts";
