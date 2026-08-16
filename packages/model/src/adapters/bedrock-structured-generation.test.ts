import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { AmazonBedrockProviderSettings } from "@ai-sdk/amazon-bedrock";
import { NoObjectGeneratedError, TypeValidationError } from "ai";
import { z } from "zod";
import { StructuredGenerationError } from "../errors.ts";
import { expectRejection } from "../test-helpers.ts";
import {
  type BedrockStructuredGenerationPortDeps,
  createBedrockStructuredGenerationPort,
} from "./bedrock-structured-generation.ts";

/**
 * Offline coverage for the Bedrock structured-generation adapter,
 * mirroring `claude-code-structured-generation.test.ts`'s DI-faked-provider
 * pattern. The adapter never calls `generateObject` or `createAmazonBedrock`
 * directly — both are injectable via `BedrockStructuredGenerationPortDeps`
 * precisely so this file can fake the provider round trip without a live
 * AWS call.
 */

interface FakeProvider {
  readonly languageModel: (modelId: string) => unknown;
}

function makeFakeProvider(scenario?: {
  readonly generateObject?: BedrockStructuredGenerationPortDeps["generateObject"];
}): {
  readonly deps: BedrockStructuredGenerationPortDeps;
  readonly modelIds: string[];
  readonly capturedSettings: () => AmazonBedrockProviderSettings | undefined;
} {
  const modelIds: string[] = [];
  let capturedSettings: AmazonBedrockProviderSettings | undefined;

  const createProvider = (settings: AmazonBedrockProviderSettings): FakeProvider => {
    capturedSettings = settings;
    return {
      languageModel: (modelId: string) => {
        modelIds.push(modelId);
        // Never actually handed to a real `generateObject` in these tests —
        // the faked `generateObject` below ignores the model it's given and
        // only needs this to satisfy the type at the call site.
        return {} as never;
      },
    };
  };

  const defaultGenerateObject = async () => ({
    object: { greeting: "hello" },
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      inputTokenDetails: { noCacheTokens: 9, cacheReadTokens: 1, cacheWriteTokens: 2 },
    },
  });

  return {
    deps: {
      createProvider:
        createProvider as unknown as BedrockStructuredGenerationPortDeps["createProvider"],
      generateObject: (scenario?.generateObject ??
        defaultGenerateObject) as unknown as BedrockStructuredGenerationPortDeps["generateObject"],
    },
    modelIds,
    capturedSettings: () => capturedSettings,
  };
}

const schema = z.object({ greeting: z.string() });

describe("createBedrockStructuredGenerationPort", () => {
  describe("request shape passthrough", () => {
    test("schema/prompt/system/schemaName/schemaDescription all reach the injected generateObject", async () => {
      let captured: Record<string, unknown> | undefined;
      const { deps } = makeFakeProvider({
        generateObject: (async (params: Record<string, unknown>) => {
          captured = params;
          return {
            object: { greeting: "hi" },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }) as never,
      });
      const port = createBedrockStructuredGenerationPort({}, deps);

      await port.generate({
        schema,
        prompt: "hello there",
        system: "be terse",
        schemaName: "Greeting",
        schemaDescription: "a friendly greeting",
      });

      expect(captured?.prompt).toBe("hello there");
      expect(captured?.system).toBe("be terse");
      expect(captured?.schemaName).toBe("Greeting");
      expect(captured?.schemaDescription).toBe("a friendly greeting");
      expect(captured?.schema).toBe(schema);
      expect(captured?.model).toBeDefined();
    });
  });

  describe("model resolution", () => {
    test("no model anywhere: falls back to the adapter's default short name, resolved to a full profile id", async () => {
      const { deps, modelIds } = makeFakeProvider();
      const port = createBedrockStructuredGenerationPort({}, deps);

      await port.generate({ schema, prompt: "hi" });

      expect(modelIds).toEqual(["us.anthropic.claude-sonnet-5"]);
    });

    test("options.model wins over the default", async () => {
      const { deps, modelIds } = makeFakeProvider();
      const port = createBedrockStructuredGenerationPort({ model: "haiku" }, deps);

      await port.generate({ schema, prompt: "hi" });

      expect(modelIds).toEqual(["us.anthropic.claude-haiku-4-5-20251001-v1:0"]);
    });

    test("per-call request.model wins over options.model", async () => {
      const { deps, modelIds } = makeFakeProvider();
      const port = createBedrockStructuredGenerationPort({ model: "haiku" }, deps);

      await port.generate({ schema, prompt: "hi", model: "opus" });

      expect(modelIds).toEqual(["us.anthropic.claude-opus-4-8"]);
    });

    test("short-name map covers sonnet/haiku/opus/fable", async () => {
      const { deps, modelIds } = makeFakeProvider();
      const port = createBedrockStructuredGenerationPort({}, deps);

      for (const shortName of ["sonnet", "haiku", "opus", "fable"]) {
        await port.generate({ schema, prompt: "hi", model: shortName });
      }

      expect(modelIds).toEqual([
        "us.anthropic.claude-sonnet-5",
        "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        "us.anthropic.claude-opus-4-8",
        "us.anthropic.claude-fable-5",
      ]);
    });

    test("an unknown name (a full Bedrock inference-profile id) passes through verbatim", async () => {
      const { deps, modelIds } = makeFakeProvider();
      const port = createBedrockStructuredGenerationPort({}, deps);
      const fullId = "us.anthropic.claude-opus-4-1-20250805-v1:0";

      await port.generate({ schema, prompt: "hi", model: fullId });

      expect(modelIds).toEqual([fullId]);
    });
  });

  describe("usage translation", () => {
    test("translates LanguageModelUsage (incl. cache read/write details) into TokenUsage", async () => {
      const { deps } = makeFakeProvider();
      const port = createBedrockStructuredGenerationPort({}, deps);

      const result = await port.generate({ schema, prompt: "hi" });

      expect(result.object).toEqual({ greeting: "hello" });
      expect(result.usage).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 1,
        cacheWriteTokens: 2,
      });
    });

    test("missing usage fields default to 0", async () => {
      const { deps } = makeFakeProvider({
        generateObject: (async () => ({
          object: { greeting: "hi" },
          usage: {},
        })) as never,
      });
      const port = createBedrockStructuredGenerationPort({}, deps);

      const result = await port.generate({ schema, prompt: "hi" });

      expect(result.usage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });
  });

  describe("error wrapping", () => {
    test("a generateObject rejection is wrapped in StructuredGenerationError", async () => {
      const { deps } = makeFakeProvider({
        generateObject: (async () => {
          throw new Error("schema validation failed");
        }) as never,
      });
      const port = createBedrockStructuredGenerationPort({}, deps);

      const error = await expectRejection(
        port.generate({ schema, prompt: "hi" }),
        StructuredGenerationError,
      );
      expect(error.message).toContain("schema validation failed");
    });

    test("a non-Error throw is still wrapped, stringified into the message", async () => {
      const { deps } = makeFakeProvider({
        generateObject: (async () => {
          // biome-ignore lint/style/useThrowOnlyError: exercising the adapter's non-Error branch deliberately.
          throw "a plain string failure";
        }) as never,
      });
      const port = createBedrockStructuredGenerationPort({}, deps);

      const error = await expectRejection(
        port.generate({ schema, prompt: "hi" }),
        StructuredGenerationError,
      );
      expect(error.message).toContain("a plain string failure");
    });
  });

  describe("NoObjectGeneratedError enrichment", () => {
    let warnSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    function makeSchemaMissError(rawText: string): NoObjectGeneratedError {
      // Mirrors the real shape the AI SDK throws (see
      // `parse-and-validate-object-result.ts`): a `TypeValidationError` whose
      // `.cause` is the standard-schema issues array zod's adapter attaches.
      const issues = [
        {
          message: "Invalid string: must match pattern /^[a-z0-9]+(?:-[a-z0-9]+)*$/",
          path: ["groups", 0, "slug"],
        },
        { message: "Required", path: ["groups", 1, "keywords"] },
      ];
      const validationError = new TypeValidationError({ value: { groups: [] }, cause: issues });
      return new NoObjectGeneratedError({
        message: "No object generated: response did not match schema.",
        cause: validationError,
        text: rawText,
        response: { id: "resp-1", timestamp: new Date(0), modelId: "test-model" },
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokenDetails: { textTokens: 20, reasoningTokens: 0 },
        },
        finishReason: "stop",
      });
    }

    test("mapped error carries validation issues and a text excerpt", async () => {
      // schemaRetries: 0 — this test is about the enrichment on a single
      // failed attempt, not the retry/repair logic (covered separately
      // below), and the fixture's rawText/schema don't line up (schema
      // here is the trivial `{greeting}` fixture) so local repair can never
      // succeed on it anyway.
      const rawText = '```json\n{"groups": [{"slug": "Credit Risk"}]}\n```';
      const { deps } = makeFakeProvider({
        generateObject: (async () => {
          throw makeSchemaMissError(rawText);
        }) as never,
      });
      const port = createBedrockStructuredGenerationPort({ schemaRetries: 0 }, deps);

      const error = await expectRejection(
        port.generate({ schema, prompt: "hi" }),
        StructuredGenerationError,
      );

      expect(error.message).toContain("groups.0.slug");
      expect(error.message).toContain("must match pattern");
      expect(error.message).toContain("groups.1.keywords");
      expect(error.message).toContain(rawText);
      expect(error.cause).toBeInstanceOf(NoObjectGeneratedError);
    });

    test("a text excerpt longer than the bound is truncated and annotated with the full length", async () => {
      const rawText = "x".repeat(2000);
      const { deps } = makeFakeProvider({
        generateObject: (async () => {
          throw makeSchemaMissError(rawText);
        }) as never,
      });
      const port = createBedrockStructuredGenerationPort({ schemaRetries: 0 }, deps);

      const error = await expectRejection(
        port.generate({ schema, prompt: "hi" }),
        StructuredGenerationError,
      );

      expect(error.message).toContain("500 of 2000 chars, truncated");
      expect(error.message).not.toContain("x".repeat(501));
    });

    test("logs the full raw text server-side via console.warn, never the prompt/system", async () => {
      const rawText = "the model's raw (invalid) completion";
      const { deps } = makeFakeProvider({
        generateObject: (async () => {
          throw makeSchemaMissError(rawText);
        }) as never,
      });
      const port = createBedrockStructuredGenerationPort({ schemaRetries: 0 }, deps);

      await expectRejection(
        port.generate({ schema, prompt: "a secret prompt that must never be logged" }),
        StructuredGenerationError,
      );

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const loggedText = warnSpy.mock.calls[0]?.[0] as string;
      expect(loggedText).toContain(rawText);
      expect(loggedText).not.toContain("secret prompt");
    });

    test("a NoObjectGeneratedError with no captured text still maps cleanly", async () => {
      const { deps } = makeFakeProvider({
        generateObject: (async () => {
          throw new NoObjectGeneratedError({
            message: "No object generated: could not parse the response.",
            cause: new TypeValidationError({ value: undefined, cause: [] }),
            text: undefined,
            response: { id: "resp-2", timestamp: new Date(0), modelId: "test-model" },
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
              inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
              outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
            },
            finishReason: "stop",
          });
        }) as never,
      });
      const port = createBedrockStructuredGenerationPort({ schemaRetries: 0 }, deps);

      const error = await expectRejection(
        port.generate({ schema, prompt: "hi" }),
        StructuredGenerationError,
      );

      expect(error.message).toContain("No object generated: could not parse the response.");
    });
  });

  describe("schema-repair retry", () => {
    // A taxonomy-shaped schema — deliberately mirroring a real production
    // schema shape observed to trigger the double-encoding failure mode, so
    // the "double-encoded field" fixtures below are a direct regression test
    // for the live finding, not a synthetic unrelated shape.
    const taxonomyLikeSchema = z.object({
      groups: z.array(z.object({ slug: z.string(), title: z.string() })),
    });

    function makeSchemaMissError(
      text: string,
      usage: { inputTokens: number; outputTokens: number } = { inputTokens: 10, outputTokens: 20 },
    ): NoObjectGeneratedError {
      return new NoObjectGeneratedError({
        message: "No object generated: response did not match schema.",
        cause: new TypeValidationError({
          value: undefined,
          cause: [{ message: "Invalid input", path: ["groups"] }],
        }),
        text,
        response: { id: "resp-1", timestamp: new Date(0), modelId: "test-model" },
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.inputTokens + usage.outputTokens,
          inputTokenDetails: {
            noCacheTokens: usage.inputTokens,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          outputTokenDetails: { textTokens: usage.outputTokens, reasoningTokens: 0 },
        },
        finishReason: "stop",
      });
    }

    test("a double-JSON-encoded field (a live finding) is repaired locally — zero retries, zero extra usage", async () => {
      const correct = { groups: [{ slug: "credit-risk", title: "Credit Risk" }] };
      // Exactly the live shape: the top-level `groups` key holds a STRING
      // that is itself the JSON encoding of the whole correct answer.
      const rawText = JSON.stringify({ groups: JSON.stringify(correct) });
      let callCount = 0;
      const { deps } = makeFakeProvider({
        generateObject: (async () => {
          callCount += 1;
          throw makeSchemaMissError(rawText);
        }) as never,
      });
      const port = createBedrockStructuredGenerationPort({}, deps);

      const result = await port.generate({ schema: taxonomyLikeSchema, prompt: "hi" });

      expect(callCount).toBe(1);
      expect(result.object).toEqual(correct);
      expect(result.usage).toEqual({
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });

    test("an unwrap that parses as JSON but doesn't satisfy the request schema is discarded, not accepted (pins the safeParse validation gate)", async () => {
      // The double-encoded `groups` string decodes to a perfectly valid JSON
      // *object* — `{"wrong": 1}` — so `unwrapDoubleEncodedStrings` succeeds
      // and produces `{ groups: { wrong: 1 } }`. But `groups` must be an
      // array per `taxonomyLikeSchema`, so this must fail `schema.safeParse`
      // and never be handed back as a "repaired" result — the load-bearing
      // guarantee that local repair only ever returns an object that
      // actually matches the caller's schema, never merely "valid JSON".
      const rawText = JSON.stringify({ groups: JSON.stringify({ wrong: 1 }) });
      let callCount = 0;
      const { deps } = makeFakeProvider({
        generateObject: (async () => {
          callCount += 1;
          throw makeSchemaMissError(rawText);
        }) as never,
      });
      const port = createBedrockStructuredGenerationPort({ schemaRetries: 0 }, deps);

      const error = await expectRejection(
        port.generate({ schema: taxonomyLikeSchema, prompt: "hi" }),
        StructuredGenerationError,
      );

      // The retry/exhaust path ran to completion rather than short-circuiting
      // on a wrongly "repaired" object: exactly one attempt (schemaRetries: 0
      // permits none), and the surfaced error is the original schema miss.
      expect(callCount).toBe(1);
      expect(error.message).toContain("No object generated");
    });

    test("a markdown-fenced double-encoded field is also repaired locally", async () => {
      const correct = { groups: [{ slug: "ok", title: "OK" }] };
      const rawText = `\`\`\`json\n${JSON.stringify({ groups: JSON.stringify(correct) })}\n\`\`\``;
      const { deps } = makeFakeProvider({
        generateObject: (async () => {
          throw makeSchemaMissError(rawText);
        }) as never,
      });
      const port = createBedrockStructuredGenerationPort({}, deps);

      const result = await port.generate({ schema: taxonomyLikeSchema, prompt: "hi" });

      expect(result.object).toEqual(correct);
    });

    test("an unrepairable schema miss retries with a corrective hint, then succeeds", async () => {
      let callCount = 0;
      const capturedSystems: (string | undefined)[] = [];
      const { deps } = makeFakeProvider({
        generateObject: (async (params: Record<string, unknown>) => {
          callCount += 1;
          capturedSystems.push(params.system as string | undefined);
          if (callCount < 2) {
            throw makeSchemaMissError("not valid json at all {{{");
          }
          return {
            object: { groups: [{ slug: "ok", title: "OK" }] },
            usage: { inputTokens: 5, outputTokens: 7 },
          };
        }) as never,
      });
      const port = createBedrockStructuredGenerationPort({}, deps);

      const result = await port.generate({
        schema: taxonomyLikeSchema,
        prompt: "hi",
        system: "base system prompt",
      });

      expect(callCount).toBe(2);
      expect(result.object).toEqual({ groups: [{ slug: "ok", title: "OK" }] });
      // Usage summed across the failed attempt (10/20) and the succeeding one (5/7).
      expect(result.usage).toEqual({
        inputTokens: 15,
        outputTokens: 27,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      expect(capturedSystems[0]).toBe("base system prompt");
      expect(capturedSystems[1]).toContain("base system prompt");
      expect(capturedSystems[1]).toContain("Respond again with ONLY a single valid JSON object");
      expect(capturedSystems[1]).toContain("groups: Invalid input");
    });

    test("the corrective hint is rebuilt fresh each retry, not compounded across attempts", async () => {
      const capturedSystems: (string | undefined)[] = [];
      const { deps } = makeFakeProvider({
        generateObject: (async (params: Record<string, unknown>) => {
          capturedSystems.push(params.system as string | undefined);
          throw makeSchemaMissError("not valid json {{{");
        }) as never,
      });
      const port = createBedrockStructuredGenerationPort({ schemaRetries: 2 }, deps);

      await expectRejection(
        port.generate({ schema: taxonomyLikeSchema, prompt: "hi", system: "base" }),
        StructuredGenerationError,
      );

      expect(capturedSystems).toHaveLength(3);
      // Every retry's system is "base" + exactly one hint block, never two stacked hints.
      for (const system of capturedSystems.slice(1)) {
        expect(system?.match(/Respond again with ONLY/g)?.length).toBe(1);
      }
    });

    test("retry cap respected: gives up after schemaRetries extra attempts", async () => {
      let callCount = 0;
      const { deps } = makeFakeProvider({
        generateObject: (async () => {
          callCount += 1;
          throw makeSchemaMissError("not valid json {{{");
        }) as never,
      });
      const port = createBedrockStructuredGenerationPort({ schemaRetries: 1 }, deps);

      const error = await expectRejection(
        port.generate({ schema: taxonomyLikeSchema, prompt: "hi" }),
        StructuredGenerationError,
      );

      expect(callCount).toBe(2); // 1 initial + 1 retry
      expect(error.message).toContain("No object generated");
    });

    test("schemaRetries: 0 disables retries entirely (local repair still attempted)", async () => {
      let callCount = 0;
      const { deps } = makeFakeProvider({
        generateObject: (async () => {
          callCount += 1;
          throw makeSchemaMissError("not valid json {{{");
        }) as never,
      });
      const port = createBedrockStructuredGenerationPort({ schemaRetries: 0 }, deps);

      await expectRejection(
        port.generate({ schema: taxonomyLikeSchema, prompt: "hi" }),
        StructuredGenerationError,
      );

      expect(callCount).toBe(1);
    });

    test("a negative schemaRetries is clamped to 0 — one real attempt, error propagates normally (not the unreachable 'exhausted retries' throw)", async () => {
      let callCount = 0;
      const { deps } = makeFakeProvider({
        generateObject: (async () => {
          callCount += 1;
          throw makeSchemaMissError("not valid json {{{");
        }) as never,
      });
      const port = createBedrockStructuredGenerationPort({ schemaRetries: -1 }, deps);

      const error = await expectRejection(
        port.generate({ schema: taxonomyLikeSchema, prompt: "hi" }),
        StructuredGenerationError,
      );

      expect(callCount).toBe(1);
      expect(error.message).toContain("No object generated");
      expect(error.message).not.toContain("exhausted schema retries");
    });

    test("a fractional schemaRetries is floored to an integer — the enriched last-attempt error still surfaces (not the unreachable 'exhausted retries' throw)", async () => {
      let callCount = 0;
      const { deps } = makeFakeProvider({
        generateObject: (async () => {
          callCount += 1;
          throw makeSchemaMissError("not valid json {{{");
        }) as never,
      });
      const port = createBedrockStructuredGenerationPort({ schemaRetries: 1.5 }, deps);

      const error = await expectRejection(
        port.generate({ schema: taxonomyLikeSchema, prompt: "hi" }),
        StructuredGenerationError,
      );

      expect(callCount).toBe(2); // floored to 1: 1 initial + 1 retry
      expect(error.message).toContain("No object generated");
      expect(error.message).not.toContain("exhausted schema retries");
    });
  });

  describe("empty-object schema miss (a live finding: the model answered with a literal {})", () => {
    // Two required top-level fields so the targeted hint's "name every
    // required field" behavior actually has more than one field to name.
    const multiFieldSchema = z.object({
      groups: z.array(z.string()),
      count: z.number(),
    });

    function makeEmptyObjectMissError(): NoObjectGeneratedError {
      return new NoObjectGeneratedError({
        message: "No object generated: response did not match schema.",
        cause: new TypeValidationError({
          value: {},
          cause: [
            { message: "Required", path: ["groups"] },
            { message: "Required", path: ["count"] },
          ],
        }),
        text: "{}",
        response: { id: "resp-1", timestamp: new Date(0), modelId: "test-model" },
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokenDetails: { textTokens: 2, reasoningTokens: 0 },
        },
        finishReason: "stop",
      });
    }

    test("a literal {} response gets a targeted hint naming the schema's required fields, then succeeds on retry", async () => {
      let callCount = 0;
      const capturedSystems: (string | undefined)[] = [];
      const { deps } = makeFakeProvider({
        generateObject: (async (params: Record<string, unknown>) => {
          callCount += 1;
          capturedSystems.push(params.system as string | undefined);
          if (callCount < 2) {
            throw makeEmptyObjectMissError();
          }
          return {
            object: { groups: ["ok"], count: 1 },
            usage: { inputTokens: 5, outputTokens: 7 },
          };
        }) as never,
      });
      const port = createBedrockStructuredGenerationPort({}, deps);

      const result = await port.generate({
        schema: multiFieldSchema,
        prompt: "hi",
        system: "base system prompt",
      });

      expect(callCount).toBe(2);
      expect(result.object).toEqual({ groups: ["ok"], count: 1 });
      expect(capturedSystems[1]).toContain("base system prompt");
      expect(capturedSystems[1]).toContain("empty JSON object");
      expect(capturedSystems[1]).toContain("groups");
      expect(capturedSystems[1]).toContain("count");
      // The targeted hint replaces the generic "failed schema validation" framing for this shape.
      expect(capturedSystems[1]).not.toContain("Your previous response failed schema validation");
    });

    test("two consecutive {} misses exhaust retries and surface the enriched NoObjectGeneratedError", async () => {
      let callCount = 0;
      const { deps } = makeFakeProvider({
        generateObject: (async () => {
          callCount += 1;
          throw makeEmptyObjectMissError();
        }) as never,
      });
      const port = createBedrockStructuredGenerationPort({ schemaRetries: 1 }, deps);

      const error = await expectRejection(
        port.generate({ schema: multiFieldSchema, prompt: "hi" }),
        StructuredGenerationError,
      );

      expect(callCount).toBe(2); // 1 initial + 1 retry, both {}
      expect(error.message).toContain("No object generated");
      expect(error.cause).toBeInstanceOf(NoObjectGeneratedError);
    });

    test("an object with some (but not all) required fields present is not treated as an empty-object miss — gets the generic hint", async () => {
      const partialMissError = new NoObjectGeneratedError({
        message: "No object generated: response did not match schema.",
        cause: new TypeValidationError({
          value: { groups: ["ok"] },
          cause: [{ message: "Required", path: ["count"] }],
        }),
        text: JSON.stringify({ groups: ["ok"] }),
        response: { id: "resp-2", timestamp: new Date(0), modelId: "test-model" },
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokenDetails: { textTokens: 2, reasoningTokens: 0 },
        },
        finishReason: "stop",
      });
      const capturedSystems: (string | undefined)[] = [];
      const { deps } = makeFakeProvider({
        generateObject: (async (params: Record<string, unknown>) => {
          capturedSystems.push(params.system as string | undefined);
          throw partialMissError;
        }) as never,
      });
      const port = createBedrockStructuredGenerationPort({ schemaRetries: 1 }, deps);

      await expectRejection(
        port.generate({ schema: multiFieldSchema, prompt: "hi" }),
        StructuredGenerationError,
      );

      expect(capturedSystems[1]).toContain("Your previous response failed schema validation");
      expect(capturedSystems[1]).not.toContain("empty JSON object");
    });

    test("a schema with no required top-level fields can never trigger the empty-object hint (an all-optional {} would have validated, never reaching retry)", async () => {
      const allOptionalSchema = z.object({ note: z.string().optional() });
      const capturedSystems: (string | undefined)[] = [];
      const { deps } = makeFakeProvider({
        generateObject: (async (params: Record<string, unknown>) => {
          capturedSystems.push(params.system as string | undefined);
          // Not actually {} — {} would have passed safeParse for this schema
          // and never produced a miss at all. Exercising an unrelated miss
          // (unparseable text) just to confirm the generic hint still runs.
          throw new NoObjectGeneratedError({
            message: "No object generated: could not parse the response.",
            cause: new TypeValidationError({ value: undefined, cause: [] }),
            text: "not json {{{",
            response: { id: "resp-3", timestamp: new Date(0), modelId: "test-model" },
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
              inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
              outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
            },
            finishReason: "stop",
          });
        }) as never,
      });
      const port = createBedrockStructuredGenerationPort({ schemaRetries: 1 }, deps);

      await expectRejection(
        port.generate({ schema: allOptionalSchema, prompt: "hi" }),
        StructuredGenerationError,
      );

      expect(capturedSystems[1]).not.toContain("empty JSON object");
    });
  });

  describe("auth posture (D26): never reads ANTHROPIC_API_KEY, no subscription guardrail", () => {
    test("construct + generate via injected deps: the provider factory's config never carries ANTHROPIC_API_KEY", async () => {
      // Deliberately mismatched with the environment, mirroring
      // `guardrail.test.ts`'s posture test: even with a real-looking
      // Anthropic API key exported, this adapter must never look at it —
      // Bedrock auth is entirely AWS's (region + optional Bedrock bearer
      // token), never a Claude API key.
      const original = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = "sk-ant-definitely-not-a-real-key";
      try {
        const { deps, capturedSettings } = makeFakeProvider();
        const port = createBedrockStructuredGenerationPort(
          { region: "us-west-2", apiKey: "bedrock-bearer-token" },
          deps,
        );

        await port.generate({ schema, prompt: "hi" });

        const settings = capturedSettings();
        expect(settings).toEqual({ region: "us-west-2", apiKey: "bedrock-bearer-token" });
        expect(settings?.apiKey).not.toBe(process.env.ANTHROPIC_API_KEY);
        expect(JSON.stringify(settings)).not.toContain("ANTHROPIC");
        expect(JSON.stringify(settings)).not.toContain(process.env.ANTHROPIC_API_KEY as string);
      } finally {
        if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = original;
      }
    });

    // Static-scan coverage (this file itself never reads
    // `process.env.ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` off an `env`
    // object, so the adapter is already covered by
    // `../no-api-key-read.test.ts`'s glob over `src/**/*.ts`) — no separate
    // scan needed here.
  });
});
