/**
 * Port 1 adapter — Vercel AI SDK `generateObject` via `ai-sdk-provider-claude-code`.
 *
 * The provider spawns the same `claude` CLI subprocess Port 2 talks to
 * directly, but through the Vercel AI SDK's `LanguageModelV4` interface, so
 * `generateObject` gets typed, schema-validated output for free (D5's
 * whole reason to route structured work through this transport instead of
 * the Agent SDK).
 *
 * Guardrail: the provider's `onSdkMessage` callback surfaces every raw
 * Agent SDK message the subprocess emits, including the `system`/`init`
 * message that carries `apiKeySource`. This is the same signal Port 2
 * checks directly. The moment it resolves to anything but the operator's
 * subscription, we abort the in-flight call via `generateObject`'s own
 * `abortSignal` option — verified the *only* way to do this: `sdkOptions`
 * (the settings-level Agent SDK escape hatch) silently ignores an
 * `abortController` passed through it ("provider-managed fields ...
 * ignored"), so the cancellation has to go through the AI SDK's own
 * request-level `abortSignal` instead. Best-effort regardless — the
 * subprocess may have already produced output by the time the signal is
 * observed — so, regardless of how `generateObject` itself settles, we
 * raise `SubscriptionAuthError` rather than ever return that result to the
 * caller.
 */

import type { LanguageModelUsage } from "ai";
import { generateObject } from "ai";
import {
  type ClaudeCodeModelId,
  type ClaudeCodeSettings,
  claudeCode,
} from "ai-sdk-provider-claude-code";
import { StructuredGenerationError, SubscriptionAuthError } from "../errors.ts";
import { assertSubscriptionAuth } from "../guardrail.ts";
import type { SettingsSource } from "../ports/agentic-session.ts";
import type {
  StructuredGenerationPort,
  StructuredGenerationRequest,
  StructuredGenerationResult,
} from "../ports/structured-generation.ts";
import type { TokenUsage } from "../usage.ts";

/** Reasonable default for tool-less structured work: balanced cost/quality. Override per adapter instance or per request. */
const DEFAULT_MODEL: ClaudeCodeModelId = "sonnet";

export interface ClaudeCodeStructuredGenerationOptions {
  readonly model?: string;
  readonly cwd?: string;
  /** See `AgenticSessionOptions.settingSources` (`../ports/agentic-session.ts`) for the isolation-vs-CLI-parity tradeoff. Omit to accept the provider's own default (isolation — no filesystem settings loaded), which suits the batch/offline nature of this port's workloads. */
  readonly settingSources?: readonly SettingsSource[];
}

function translateUsage(usage: LanguageModelUsage): TokenUsage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createClaudeCodeStructuredGenerationPort(
  defaults: ClaudeCodeStructuredGenerationOptions = {},
): StructuredGenerationPort {
  return {
    async generate<Output>(
      request: StructuredGenerationRequest<Output>,
    ): Promise<StructuredGenerationResult<Output>> {
      const abortController = new AbortController();
      let authViolation: SubscriptionAuthError | undefined;
      let initSeen = false;

      const settings: ClaudeCodeSettings = {
        cwd: defaults.cwd,
        settingSources: defaults.settingSources as ClaudeCodeSettings["settingSources"],
        onSdkMessage: (message) => {
          if (initSeen || message.type !== "system" || message.subtype !== "init") {
            return;
          }
          initSeen = true;
          try {
            assertSubscriptionAuth({ apiKeySource: message.apiKeySource });
          } catch (error) {
            if (error instanceof SubscriptionAuthError) {
              authViolation = error;
              abortController.abort();
              return;
            }
            throw error;
          }
        },
      };

      const modelId = request.model ?? defaults.model ?? DEFAULT_MODEL;
      const model = claudeCode(modelId, settings);

      let result: Awaited<ReturnType<typeof generateObject<typeof request.schema>>>;
      try {
        result = await generateObject({
          model,
          schema: request.schema,
          prompt: request.prompt,
          system: request.system,
          schemaName: request.schemaName,
          schemaDescription: request.schemaDescription,
          abortSignal: abortController.signal,
        });
      } catch (error) {
        if (authViolation) {
          throw authViolation;
        }
        throw new StructuredGenerationError(
          `structured generation failed: ${describeError(error)}`,
          error,
        );
      }

      // Guardrail integrity outranks convenience: never hand back a result
      // that might have been produced on the wrong credentials, even if
      // the abort didn't manage to stop generateObject from resolving.
      if (authViolation) {
        throw authViolation;
      }

      return {
        object: result.object,
        usage: translateUsage(result.usage),
      };
    },
  };
}
