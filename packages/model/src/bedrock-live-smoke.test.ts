import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createModel } from "./factory.ts";
import { runToCompletion } from "./ports/agentic-session.ts";
import { createToolServer, defineTool } from "./tools.ts";

/**
 * Opt-in live proof for the Bedrock adapters (structured generation and
 * agentic session), mirroring `live-smoke.test.ts`'s pattern — skipped by
 * default so `bun test` stays fast, offline, and deterministic. Run
 * explicitly:
 *
 *   SHADOW_LIVE_BEDROCK=1 bun test packages/model/src/bedrock-live-smoke.test.ts
 *
 * Requires AWS credentials resolvable by the standard credential chain (or
 * `AWS_BEARER_TOKEN_BEDROCK` set for Bedrock's bearer-token auth) and access
 * to the resolved model in the target region — see `SHADOW_BEDROCK_MODEL`/
 * `SHADOW_BEDROCK_REGION` in `@shadow/api`'s composition root, or the
 * `region`/`apiKey`/`model` fields on `createModel`'s `bedrock` option
 * directly.
 */
const RUN_LIVE_BEDROCK = process.env.SHADOW_LIVE_BEDROCK === "1";

describe.skipIf(!RUN_LIVE_BEDROCK)("bedrock live smoke test (SHADOW_LIVE_BEDROCK=1)", () => {
  // Runs first in this file's live sequence: proves the real tool round trip
  // (the model calling an actual in-process tool over the real Bedrock
  // stream, not a faked one) before the plainer Port 1/Port 2 checks below.
  test("Port 2 session with a tool completes a real tool round trip: tool-use -> tool-result -> done reflecting the tool's answer", async () => {
    const model = createModel({ provider: "bedrock" });
    const toolServer = createToolServer("calculator", [
      defineTool({
        name: "add",
        description: "Add two integers and return their sum.",
        inputSchema: { a: z.number(), b: z.number() },
        handler: async ({ a, b }) => ({ content: String(a + b) }),
      }),
    ]);
    const session = model.agenticSession.createSession({
      systemPrompt:
        "You must call the add tool to compute any sum rather than doing the arithmetic " +
        "yourself. Reply with only the final numeric answer and nothing else.",
      toolServers: [toolServer],
      allowedTools: ["mcp__calculator__add"],
    });

    const events = [];
    for await (const event of session.stream(
      "Use the add tool to compute 37 plus 5, then reply with only the resulting number.",
    )) {
      events.push(event);
    }

    const toolUse = events.find((e) => e.type === "tool-use");
    const toolResult = events.find((e) => e.type === "tool-result");
    const done = events[events.length - 1];
    if (done?.type !== "done") throw new Error("expected done");

    expect(toolUse).toBeDefined();
    if (toolUse?.type === "tool-use") expect(toolUse.toolName).toBe("add");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool-result") {
      expect(toolResult.toolName).toBe("add");
      expect(toolResult.isError).toBe(false);
    }
    expect(done.result.isError).toBe(false);
    expect(done.result.text).toContain("42");
  }, 60_000);

  test("Port 1 (structured generation) completes a trivial round trip through the real Bedrock adapter", async () => {
    const model = createModel({ provider: "bedrock" });
    const schema = z.object({ greeting: z.string() });

    const result = await model.structuredGeneration.generate({
      schema,
      prompt:
        "Respond with a JSON object with a single field 'greeting' set to the string 'hello'.",
    });

    expect(result.object.greeting.toLowerCase()).toContain("hello");
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  }, 60_000);

  test("Port 2 (agentic session) completes a trivial, tool-less turn through the real Bedrock adapter", async () => {
    const model = createModel({ provider: "bedrock" });
    const session = model.agenticSession.createSession({
      systemPrompt: "Reply with exactly one word and nothing else.",
    });

    const result = await runToCompletion(
      session,
      "Reply with the single word 'hello' and nothing else.",
    );

    expect(result.isError).toBe(false);
    expect(result.text.toLowerCase()).toContain("hello");
    expect(result.sessionId).toBeTruthy();
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  }, 60_000);
});
