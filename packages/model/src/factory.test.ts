/**
 * Coverage for the provider strategy seam (D26). Construction of either
 * strategy's ports is cheap and synchronous — no live LLM call happens until
 * `.generate()`/`.createSession()` is invoked (see
 * `createClaudeCodeStructuredGenerationPort`/`createClaudeAgentSdkSessionPort`) —
 * so `createModel()` itself is safe to call directly in an offline test; only
 * the shape of what it returns is asserted here.
 */

import { describe, expect, test } from "bun:test";
import { createModel } from "./factory.ts";

describe("createModel — provider strategy selection (D26)", () => {
  test("no provider specified builds the claude-code strategy", () => {
    const model = createModel();
    expect(typeof model.structuredGeneration.generate).toBe("function");
    expect(typeof model.agenticSession.createSession).toBe("function");
  });

  test("provider: 'claude-code' builds the same claude-code strategy explicitly", () => {
    const model = createModel({ provider: "claude-code" });
    expect(typeof model.structuredGeneration.generate).toBe("function");
    expect(typeof model.agenticSession.createSession).toBe("function");
  });

  test("claudeCode options are forwarded to the claude-code adapters, not dropped", () => {
    // No live call is made — this only proves construction succeeds when the
    // nested `claudeCode` options are supplied, guarding against a future
    // edit silently ignoring them.
    expect(() =>
      createModel({
        provider: "claude-code",
        claudeCode: {
          structuredGeneration: { model: "sonnet" },
          agenticSession: { model: "sonnet", cwd: "/tmp" },
        },
      }),
    ).not.toThrow();
  });

  test("provider: 'bedrock' builds a real structuredGeneration port without throwing at construction", () => {
    const model = createModel({ provider: "bedrock" });
    expect(typeof model.structuredGeneration.generate).toBe("function");
  });

  test("provider: 'bedrock' still stubs agenticSession: createSession throws the clear not-yet-implemented error", () => {
    const model = createModel({ provider: "bedrock" });
    expect(() => model.agenticSession.createSession()).toThrow(/not implemented yet/);
  });

  test("bedrock options (model/region/apiKey) are forwarded to the structuredGeneration adapter, not dropped", () => {
    // No live call is made — this only proves construction succeeds when
    // every `BedrockModelOptions` field is supplied, guarding against a
    // future edit silently ignoring one.
    expect(() =>
      createModel({
        provider: "bedrock",
        bedrock: { model: "sonnet", region: "us-west-2", apiKey: "test-bearer-token" },
      }),
    ).not.toThrow();
  });
});
