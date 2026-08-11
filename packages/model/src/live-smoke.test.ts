import { describe, expect, test } from "bun:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createModel } from "./factory.ts";
import { runToCompletion } from "./ports/agentic-session.ts";

/**
 * Opt-in live proof, skipped by default so `bun test` stays fast, offline,
 * and deterministic (per the testing posture in PLAN.md). Run explicitly:
 *
 *   SHADOW_LIVE_TEST=1 bun test packages/model/src/live-smoke.test.ts
 *
 * Requires the `claude` CLI authenticated via subscription OAuth on this
 * machine (`claude login`), with `ANTHROPIC_API_KEY` unset — exactly the
 * setup this package's guardrail exists to verify.
 */
const RUN_LIVE = process.env.SHADOW_LIVE_TEST === "1";

describe.skipIf(!RUN_LIVE)("live smoke test (SHADOW_LIVE_TEST=1)", () => {
  test("apiKeySource resolves to 'none' (subscription auth) — a direct query() call, independent of our own adapters", async () => {
    let apiKeySource: string | undefined;
    const messages = query({
      prompt: "Say 'ok' and nothing else.",
      options: { maxTurns: 1, settingSources: [], persistSession: false },
    });
    for await (const message of messages) {
      if (message.type === "system" && message.subtype === "init") {
        apiKeySource = message.apiKeySource;
        break;
      }
    }
    await messages.return();
    expect(apiKeySource).toBe("none");
  }, 60_000);

  test("Port 1 (structured generation) completes a trivial round trip through the real adapter", async () => {
    const model = createModel();
    const schema = z.object({ greeting: z.string() });
    const result = await model.structuredGeneration.generate({
      schema,
      prompt:
        "Respond with a JSON object with a single field 'greeting' set to the string 'hello'.",
    });
    expect(result.object.greeting.toLowerCase()).toContain("hello");
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  }, 60_000);

  test("Port 2 (agentic session) completes a trivial round trip through the real adapter", async () => {
    const model = createModel();
    const session = model.agenticSession.createSession({
      settingSources: [],
      persistSession: false,
    });
    const result = await runToCompletion(session, "Say 'ok' and nothing else.");
    // If apiKeySource had resolved to anything but "none", the adapter's
    // guardrail check would have thrown SubscriptionAuthError before this
    // line — reaching it at all is itself proof the assertion held for
    // this port too, exercised through our own wiring rather than a raw
    // query() call.
    expect(result.isError).toBe(false);
    expect(session.sessionId).toBeDefined();
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  }, 60_000);
});
