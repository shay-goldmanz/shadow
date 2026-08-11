/**
 * Typed error hierarchy for @shadow/model.
 *
 * Every failure mode a caller needs to branch on has its own class with
 * structured fields (never just a string). `instanceof` checks against
 * these — not string-matching `error.message` — is the supported way to
 * handle them. Mirrors the convention established in `@shadow/core`.
 */

/** Base class for every error this package throws. */
export abstract class ShadowModelError extends Error {
  abstract override readonly name: string;
}

/**
 * The stack resolved LLM credentials from an API key rather than the
 * operator's subscription. This is the guardrail failure from D5 — the
 * single place in the whole system this can be detected, and the acceptance
 * criterion it protects is named explicitly in the message so a developer
 * reading a stack trace understands *why* this is fatal, not just *that* it
 * is.
 *
 * Thrown by `assertSubscriptionAuth` and never caught internally: every
 * adapter lets this propagate rather than falling back to any other
 * transport.
 */
export class SubscriptionAuthError extends ShadowModelError {
  override readonly name = "SubscriptionAuthError";

  constructor(public readonly apiKeySource: string) {
    super(
      `@shadow/model resolved LLM credentials from an API key (apiKeySource: ${JSON.stringify(
        apiKeySource,
      )}) instead of the operator's subscription. This violates the ` +
        `acceptance criterion "The entire stack runs on the operator's AI subscriptions, ` +
        `NOT on api keys." Unset ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN and authenticate ` +
        `via subscription OAuth (\`claude login\`) instead — see DECISIONS.md D5.`,
    );
  }
}

/**
 * A structured-generation call (Port 1, `generateObject` via
 * `ai-sdk-provider-claude-code`) failed — schema validation, a CLI/API
 * error, or the underlying process exiting unexpectedly. Wraps whatever the
 * adapter caught so callers get one error type to catch regardless of which
 * layer (Vercel AI SDK, the provider, or the CLI subprocess) raised it.
 */
export class StructuredGenerationError extends ShadowModelError {
  override readonly name = "StructuredGenerationError";

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}

/**
 * An agentic session call (Port 2, `query()` via
 * `@anthropic-ai/claude-agent-sdk`) failed — a non-success `result` message,
 * a stream that ended without one, or the underlying process erroring.
 */
export class AgenticSessionError extends ShadowModelError {
  override readonly name = "AgenticSessionError";

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}
