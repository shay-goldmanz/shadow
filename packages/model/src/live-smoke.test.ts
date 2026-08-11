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
 *
 * Known environment issue (pre-existing, not specific to any test below):
 * on at least one verified combination of Bun 1.3.14 and
 * `@anthropic-ai/claude-agent-sdk` 0.3.226, every test in this file throws
 * synchronously from inside the SDK — `setMaxListeners`: `The "eventTargets"
 * argument must be of type EventEmitter or EventTarget. Received an
 * instance of AbortSignal` — but only when run through `bun test`. The
 * identical call sequence (`createModel()` + `runToCompletion`, including a
 * second turn via `resume`) succeeds when run as a plain script via
 * `bun run` in the same environment, so this is a `bun test`-runner-specific
 * incompatibility (its global `AbortSignal` appears to fail the SDK's
 * `instanceof` check), not a bug in this package or in the Agent SDK
 * integration itself. If you hit this, verify the underlying behavior with
 * a standalone `bun run` script before assuming a regression.
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

  /**
   * The proof that matters for the bug this file's neighbor commit fixed:
   * Shadow's chat session (`@shadow/agent`'s `conversation.ts`) sets
   * `persistSession: false` (the default `AgenticSessionOptions` here
   * omit it, so the SDK's own default of `true` applies) while relying on
   * `resume` for every turn after the first — a Wave 3 review proved,
   * against this exact live adapter, that combination throws
   * `No conversation found with session ID: ...` on turn 2. This test
   * sends two turns on ONE session handle and asserts turn 2 both
   * succeeds and demonstrably resumed turn 1's transcript (the model
   * recalls a word only turn 1 told it), rather than merely not-throwing
   * — a silently *recreated* session would also not throw, but would not
   * remember anything either.
   */
  test("Port 2 (agentic session): a second turn on the SAME session handle resumes the first turn's context", async () => {
    const model = createModel();
    const session = model.agenticSession.createSession({ settingSources: [] });

    const first = await runToCompletion(
      session,
      "Remember the secret word 'pineapple-galaxy'. Reply with just the word 'ok' and nothing else.",
    );
    expect(first.isError).toBe(false);
    const sessionIdAfterFirstTurn = session.sessionId;
    expect(sessionIdAfterFirstTurn).toBeDefined();

    const second = await runToCompletion(
      session,
      "What secret word did I just ask you to remember? Reply with only that word, nothing else.",
    );
    expect(second.isError).toBe(false);
    expect(second.text.toLowerCase()).toContain("pineapple-galaxy");
    // Genuine reuse, not silent recreation: the CLI mints a fresh
    // session_id for every session it starts from scratch, so a stable id
    // across turns is only possible if turn 2 actually resumed turn 1's
    // persisted transcript rather than starting over.
    expect(session.sessionId).toBe(sessionIdAfterFirstTurn);

    await session.close?.();
  }, 90_000);
});
