import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createModel } from "./factory.ts";

/**
 * Opt-in live proof for the Bedrock structured-generation adapter,
 * mirroring `live-smoke.test.ts`'s pattern — skipped by default so `bun
 * test` stays fast, offline, and deterministic. Run explicitly:
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
});
