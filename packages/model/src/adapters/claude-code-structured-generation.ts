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
 *
 * Fail-closed, not just fail-loud: this whole guardrail depends on the
 * provider actually forwarding the `system`/`init` message through
 * `onSdkMessage`. Unlike Port 2 — which reads `init` directly off the
 * Agent SDK stream it owns, so no init means nothing is ever yielded — Port
 * 1 depends on a *second* package (`ai-sdk-provider-claude-code`) choosing
 * to forward that message. If a provider version ever stops doing so, the
 * naive version of this guardrail would leave `initSeen` false and
 * `authViolation` unset, and hand back whatever `generateObject` resolved
 * with no auth verification at all — silently trusting a signal that never
 * arrived. So after `generateObject` settles, `initSeen` is checked
 * explicitly: no init observed means no result is ever returned, full stop.
 * Absence of evidence of subscription auth must not be treated as evidence
 * of it.
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

/**
 * `apiKeySource` used for the fail-closed `SubscriptionAuthError` thrown
 * when `generateObject` settles without the provider ever having forwarded
 * a `system`/`init` message — i.e. the guardrail's evidence never arrived,
 * as opposed to arriving and reporting something other than `"none"`. Not a
 * real `apiKeySource` value the SDK ever reports; a sentinel this adapter
 * controls so the one `SubscriptionAuthError` type still covers both "auth
 * confirmed to be an API key" and "auth was never confirmed at all" — a
 * caller only ever needs to catch one error type for every way D5 can fail.
 */
const AUTH_NEVER_VERIFIED = "unverified: no system/init message observed";

/** The slice of `LanguageModelV4` this adapter passes to `generateObject`, kept as `ReturnType<typeof claudeCode>` so this file needs no direct dependency on `@ai-sdk/provider`'s types. */
type ClaudeCodeLanguageModel = ReturnType<typeof claudeCode>;

export interface ClaudeCodeStructuredGenerationOptions {
  readonly model?: string;
  readonly cwd?: string;
  /** See `AgenticSessionOptions.settingSources` (`../ports/agentic-session.ts`) for the isolation-vs-CLI-parity tradeoff. Omit to accept the provider's own default (isolation — no filesystem settings loaded), which suits the batch/offline nature of this port's workloads. */
  readonly settingSources?: readonly SettingsSource[];
}

export interface ClaudeCodeStructuredGenerationPortDeps {
  /** Injectable for tests: build the `LanguageModelV4` from a model id + settings. Defaults to `ai-sdk-provider-claude-code`'s `claudeCode`. */
  readonly createLanguageModel?: (
    modelId: ClaudeCodeModelId,
    settings: ClaudeCodeSettings,
  ) => ClaudeCodeLanguageModel;
  /** Injectable for tests: run Vercel AI SDK `generateObject`. Defaults to the real export from `ai`. Typed as the real function so the fake stays honest to the actual call shape. */
  readonly generateObject?: typeof generateObject;
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
  deps: ClaudeCodeStructuredGenerationPortDeps = {},
): StructuredGenerationPort {
  const createLanguageModel = deps.createLanguageModel ?? claudeCode;
  const runGenerateObject = deps.generateObject ?? generateObject;

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
      const model = createLanguageModel(modelId, settings);

      let result: Awaited<ReturnType<typeof generateObject<typeof request.schema>>>;
      try {
        result = await runGenerateObject({
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

      // Fail closed (see the module doc above): `generateObject` settled
      // without the provider ever forwarding a system/init message, so
      // there is no positive evidence this call ran on the operator's
      // subscription. Returning `result` here would be exactly the bug
      // this check exists to close — the guardrail failing open the moment
      // its one signal stops arriving.
      if (!initSeen) {
        throw new SubscriptionAuthError(AUTH_NEVER_VERIFIED);
      }

      return {
        object: result.object,
        usage: translateUsage(result.usage),
      };
    },
  };
}
