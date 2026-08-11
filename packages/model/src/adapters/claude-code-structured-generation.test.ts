import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import { z } from "zod";
import { SubscriptionAuthError } from "../errors.ts";
import { expectRejection } from "../test-helpers.ts";
import {
  type ClaudeCodeStructuredGenerationPortDeps,
  createClaudeCodeStructuredGenerationPort,
} from "./claude-code-structured-generation.ts";

/**
 * Offline coverage for Port 1's guardrail (D5). Until this file, the only
 * thing exercising it was `live-smoke.test.ts`, which is skipped by
 * default — meaning the single acceptance criterion this package exists to
 * enforce had zero offline coverage on this transport. Port 2's equivalent
 * (`claude-agent-sdk-session.test.ts`) already has it; this mirrors that.
 *
 * The adapter never calls `generateObject` or `claudeCode` directly — both
 * are injectable via `ClaudeCodeStructuredGenerationPortDeps` precisely so
 * this file can fake the provider round trip without a live subprocess.
 */

function initMessage(apiKeySource: string): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource,
    claude_code_version: "test",
    cwd: "/tmp",
    tools: [],
    mcp_servers: [],
    model: "claude-sonnet-5",
    permissionMode: "default",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: randomUUID(),
    session_id: randomUUID(),
  } as SDKMessage;
}

/**
 * A faked provider round trip. `createLanguageModel` captures the
 * `ClaudeCodeSettings` the adapter builds — in particular `onSdkMessage`,
 * the guardrail's only signal — and the faked `generateObject` invokes it
 * (or doesn't, simulating a provider version that stops forwarding
 * `system`/`init` entirely) before resolving, the same way the real
 * provider eventually would.
 */
function makeFakeProvider(scenario: {
  /** Omit to simulate a provider that never forwards system/init at all — the fail-closed scenario. */
  readonly apiKeySource?: string;
}): { readonly deps: ClaudeCodeStructuredGenerationPortDeps; readonly modelIds: string[] } {
  let capturedSettings: ClaudeCodeSettings | undefined;
  const modelIds: string[] = [];

  const createLanguageModel: ClaudeCodeStructuredGenerationPortDeps["createLanguageModel"] = (
    modelId,
    settings,
  ) => {
    modelIds.push(modelId);
    capturedSettings = settings;
    // Never actually handed to a real `generateObject` in these tests —
    // the faked `generateObject` below ignores the model it's given and
    // only needs this to satisfy the type at the call site.
    return {} as never;
  };

  const generateObjectFn = async (params: { abortSignal?: AbortSignal }) => {
    if (scenario.apiKeySource !== undefined) {
      await capturedSettings?.onSdkMessage?.(initMessage(scenario.apiKeySource));
    }
    if (params.abortSignal?.aborted) {
      // Mirrors the real provider: an auth violation aborts the in-flight
      // call, and `generateObject` can reject as a result. The adapter's
      // guardrail must win regardless of whether this throws or resolves.
      throw new Error("generateObject aborted");
    }
    return {
      object: { greeting: "hello" },
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        inputTokenDetails: { noCacheTokens: 9, cacheReadTokens: 1, cacheWriteTokens: 2 },
      },
    };
  };

  return {
    deps: {
      createLanguageModel,
      generateObject:
        generateObjectFn as unknown as ClaudeCodeStructuredGenerationPortDeps["generateObject"],
    },
    modelIds,
  };
}

const schema = z.object({ greeting: z.string() });

describe("createClaudeCodeStructuredGenerationPort — guardrail (D5)", () => {
  test("init reports an API-key source: throws SubscriptionAuthError, and no result is ever returned", async () => {
    const { deps } = makeFakeProvider({ apiKeySource: "user" });
    const port = createClaudeCodeStructuredGenerationPort({}, deps);

    const error = await expectRejection(
      port.generate({ schema, prompt: "hi" }),
      SubscriptionAuthError,
    );
    expect(error.apiKeySource).toBe("user");
  });

  test("init never arrives: fails closed with SubscriptionAuthError instead of returning the result", async () => {
    // The exact regression this fix closes: a provider that stops
    // forwarding system/init (e.g. a provider-version regression) used to
    // leave `initSeen` false and hand back whatever `generateObject`
    // resolved with — no auth verification at all. `apiKeySource` omitted
    // here means `onSdkMessage` is never invoked, simulating exactly that.
    const { deps } = makeFakeProvider({});
    const port = createClaudeCodeStructuredGenerationPort({}, deps);

    await expectRejection(port.generate({ schema, prompt: "hi" }), SubscriptionAuthError);
  });

  test("init reports apiKeySource: 'none' (subscription auth): succeeds normally", async () => {
    const { deps, modelIds } = makeFakeProvider({ apiKeySource: "none" });
    const port = createClaudeCodeStructuredGenerationPort({}, deps);

    const result = await port.generate({ schema, prompt: "hi" });

    expect(result.object).toEqual({ greeting: "hello" });
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 1,
      cacheWriteTokens: 2,
    });
    expect(modelIds).toEqual(["sonnet"]); // DEFAULT_MODEL, confirming the real call path ran
  });
});
