import { describe, expect, test } from "bun:test";
import { FakeStructuredGenerationPort } from "@shadow/model";
import { z } from "zod";
import { MeasuringStructuredGenerationPort, ZERO_TOKEN_COST } from "./token-tracking.ts";

const schema = z.object({ ok: z.boolean() });

describe("MeasuringStructuredGenerationPort", () => {
  test("starts at ZERO_TOKEN_COST", () => {
    const measuring = new MeasuringStructuredGenerationPort(
      new FakeStructuredGenerationPort([{ ok: true }]),
    );
    expect(measuring.cost).toEqual(ZERO_TOKEN_COST);
  });

  test("accumulates estimatedPromptTokens and llmCalls across calls, and forwards the real result", async () => {
    const fake = new FakeStructuredGenerationPort([{ ok: true }, { ok: false }]);
    const measuring = new MeasuringStructuredGenerationPort(fake);

    const first = await measuring.generate({ schema, prompt: "a short prompt" });
    expect(first.object).toEqual({ ok: true });
    expect(measuring.cost.llmCalls).toBe(1);
    expect(measuring.cost.estimatedPromptTokens).toBeGreaterThan(0);

    const afterFirst = measuring.cost.estimatedPromptTokens;
    const second = await measuring.generate({
      schema,
      prompt: "a much, much longer prompt than the first one, by a wide margin",
    });
    expect(second.object).toEqual({ ok: false });
    expect(measuring.cost.llmCalls).toBe(2);
    expect(measuring.cost.estimatedPromptTokens).toBeGreaterThan(afterFirst);
  });

  test("reset() clears accumulated cost back to zero", async () => {
    const fake = new FakeStructuredGenerationPort([{ ok: true }]);
    const measuring = new MeasuringStructuredGenerationPort(fake);
    await measuring.generate({ schema, prompt: "hello" });
    expect(measuring.cost.llmCalls).toBe(1);

    measuring.reset();
    expect(measuring.cost).toEqual(ZERO_TOKEN_COST);
  });

  test("system text is included in the token estimate, not just the prompt", async () => {
    const fake = new FakeStructuredGenerationPort(() => ({ ok: true }));
    const withSystem = new MeasuringStructuredGenerationPort(fake);
    const withoutSystem = new MeasuringStructuredGenerationPort(fake);

    await withSystem.generate({ schema, prompt: "p", system: "a".repeat(400) });
    await withoutSystem.generate({ schema, prompt: "p" });

    expect(withSystem.cost.estimatedPromptTokens).toBeGreaterThan(
      withoutSystem.cost.estimatedPromptTokens,
    );
  });

  test("real usage passes through unchanged (ZERO_USAGE for a fake port)", async () => {
    const fake = new FakeStructuredGenerationPort([{ ok: true }]);
    const measuring = new MeasuringStructuredGenerationPort(fake);
    await measuring.generate({ schema, prompt: "hello" });
    expect(measuring.cost.usage.inputTokens).toBe(0);
    expect(measuring.cost.usage.outputTokens).toBe(0);
  });
});
