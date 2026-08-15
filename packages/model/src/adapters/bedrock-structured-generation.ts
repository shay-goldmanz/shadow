/**
 * Port 1 adapter — Vercel AI SDK `generateObject` via `@ai-sdk/amazon-bedrock`
 * (D26's `"bedrock"` provider strategy).
 *
 * Mirrors `claude-code-structured-generation.ts`'s DI pattern (an injectable
 * deps object so tests fake the provider round trip offline) and its usage
 * translation / `StructuredGenerationError` wrapping. It carries none of
 * that adapter's guardrail machinery: D26's whole point is that `"bedrock"`
 * authenticates a different way than D5's subscription-only default, via
 * the standard AWS credential chain (or an operator-issued Bedrock bearer
 * token), so there is no `apiKeySource`/`onSdkMessage` signal to police
 * here, and no `assertSubscriptionAuth` call. Auth is entirely the AWS SDK's
 * problem — this adapter never reads AWS key material itself, only ever
 * forwards a region and an optional bearer token it was handed by its
 * caller (see `BedrockStructuredGenerationOptions`).
 */

import type { AmazonBedrockProviderSettings } from "@ai-sdk/amazon-bedrock";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import type { LanguageModelUsage } from "ai";
import { generateObject, NoObjectGeneratedError, TypeValidationError } from "ai";
import { type ZodType, ZodObject } from "zod";
import { StructuredGenerationError } from "../errors.ts";
import type {
  StructuredGenerationPort,
  StructuredGenerationRequest,
  StructuredGenerationResult,
} from "../ports/structured-generation.ts";
import { addUsage, type TokenUsage, ZERO_USAGE } from "../usage.ts";

/** The provider instance `createAmazonBedrock` returns — kept as a `ReturnType` so this file needs no separate type import for it. */
type AmazonBedrockProvider = ReturnType<typeof createAmazonBedrock>;

/**
 * Reasonable default for tool-less structured work, same rationale as Port
 * 1's claude-code adapter: balanced cost/quality. Resolved through
 * `MODEL_SHORT_NAMES` below like any other short name. Exported so
 * `bedrock-agentic-session.ts` shares the exact same default and short-name
 * map rather than maintaining a second one that could drift.
 */
export const BEDROCK_DEFAULT_MODEL = "sonnet";

/**
 * Short names accepted at every existing call site (`request.model`/
 * `options.model`, e.g. `"sonnet"`) resolve to current Bedrock cross-region
 * inference-profile ids for the corresponding Claude model, so switching
 * `SHADOW_MODEL_PROVIDER` to `"bedrock"` doesn't require every caller to
 * learn Bedrock's id format. A full profile id (unknown to this map) passes
 * through verbatim — see `resolveModelId`.
 *
 * Sourced from the installed `@ai-sdk/amazon-bedrock@5.0.57`'s own
 * `AmazonBedrockChatModelId` literal union (`dist/index.d.ts`), not
 * guessed: `sonnet`, `haiku`, and `fable` map to that union's newest
 * cross-region ids for each tier. `opus` maps to
 * `us.anthropic.claude-opus-4-8` — the highest-tier opus id present in that
 * same union at the time this was written; the SDK's type doesn't (yet)
 * enumerate a cross-region id for a newer opus release, and this map never
 * fabricates one it can't point to in the installed SDK. A caller that
 * needs a newer id can always pass the full profile id directly — unknown
 * names pass through unmodified.
 */
export const MODEL_SHORT_NAMES: Readonly<Record<string, string>> = {
  sonnet: "us.anthropic.claude-sonnet-5",
  haiku: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  opus: "us.anthropic.claude-opus-4-8",
  fable: "us.anthropic.claude-fable-5",
};

/** Exported for reuse by `bedrock-agentic-session.ts` — see `MODEL_SHORT_NAMES`'s doc. */
export function resolveModelId(modelId: string): string {
  return MODEL_SHORT_NAMES[modelId] ?? modelId;
}

/**
 * Extra attempts after a schema miss (`NoObjectGeneratedError`), beyond the
 * initial call — defends against a live finding: Bedrock's Claude
 * reproducibly returned a well-formed answer for a taxonomy-shaped schema
 * wrapped in one accidental extra layer of `JSON.stringify` (a top-level
 * field holding its own JSON-encoded value as a string instead of natively).
 * Two extra attempts is enough to recover from a one-off generation hiccup
 * without turning a genuine, persistent schema mismatch into a slow,
 * expensive retry storm.
 */
export const DEFAULT_SCHEMA_RETRIES = 2;

export interface BedrockStructuredGenerationOptions {
  readonly model?: string;
  /** AWS region for the Bedrock provider. Omit to let `@ai-sdk/amazon-bedrock` fall back to its own default (the `AWS_REGION` environment variable) — see `../factory.ts` for where this package resolves a further `"us-east-1"` default on top of that. */
  readonly region?: string;
  /**
   * Bearer-token API key for Bedrock's token auth, forwarded verbatim —
   * never read from the environment by this file. Omit entirely to let
   * `@ai-sdk/amazon-bedrock` read `AWS_BEARER_TOKEN_BEDROCK` itself (its own
   * documented default), or to fall back further to the AWS SDK's standard
   * credential chain if that variable isn't set either.
   */
  readonly apiKey?: string;
  /** @default {@link DEFAULT_SCHEMA_RETRIES} */
  readonly schemaRetries?: number;
}

export interface BedrockStructuredGenerationPortDeps {
  /** Injectable for tests: build the Bedrock provider from its settings. Defaults to `createAmazonBedrock` from `@ai-sdk/amazon-bedrock`. */
  readonly createProvider?: (settings: AmazonBedrockProviderSettings) => AmazonBedrockProvider;
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

/** Bounded excerpt so a pathological giant completion never blows up an error message. */
const TEXT_EXCERPT_CHARS = 500;

/** Cap on how many zod/standard-schema issues get folded into the error message — enough to diagnose, not a full dump. */
const MAX_ISSUES = 5;

interface ValidationIssueSummary {
  readonly path: string;
  readonly message: string;
}

/**
 * `NoObjectGeneratedError.cause` is a `TypeValidationError` (sometimes
 * nested — `TypeValidationError.wrap` re-wraps unless the inner error
 * already matches the same value/context) whose own `.cause` eventually
 * bottoms out at the standard-schema issues array zod's adapter attaches
 * (`{ message, path }[]`). Walk a bounded number of `.cause` hops looking
 * for that array; anything else (unrecognized shape) yields `undefined`
 * rather than guessing.
 */
function extractValidationIssues(cause: unknown): ValidationIssueSummary[] | undefined {
  let current: unknown = cause;
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    if (Array.isArray(current)) {
      const issues = current.map(summarizeIssue).filter((issue): issue is ValidationIssueSummary => issue !== undefined);
      return issues.length > 0 ? issues.slice(0, MAX_ISSUES) : undefined;
    }
    if (TypeValidationError.isInstance(current)) {
      current = current.cause;
      continue;
    }
    break;
  }
  return undefined;
}

function summarizeIssue(issue: unknown): ValidationIssueSummary | undefined {
  if (typeof issue !== "object" || issue === null) return undefined;
  const record = issue as Record<string, unknown>;
  if (typeof record.message !== "string") return undefined;
  const path = Array.isArray(record.path)
    ? record.path
        .map((segment) =>
          typeof segment === "object" && segment !== null && "key" in segment
            ? String((segment as { key: unknown }).key)
            : String(segment),
        )
        .join(".")
    : "";
  return { path, message: record.message };
}

function formatIssues(issues: ValidationIssueSummary[] | undefined): string {
  if (!issues || issues.length === 0) return "";
  const lines = issues.map((issue) => `  - ${issue.path || "(root)"}: ${issue.message}`);
  return ` Validation issues (first ${lines.length}):\n${lines.join("\n")}`;
}

function formatTextExcerpt(text: string | undefined): string {
  if (text === undefined) return "";
  const excerpt = text.slice(0, TEXT_EXCERPT_CHARS);
  const suffix = text.length > TEXT_EXCERPT_CHARS ? ", truncated" : "";
  return ` Raw output excerpt (${excerpt.length} of ${text.length} chars${suffix}):\n${excerpt}`;
}

/**
 * On a schema miss, the AI SDK's `NoObjectGeneratedError` carries exactly
 * what a developer needs to diagnose *why* — the raw completion (`.text`)
 * and the validation failure (`.cause`) — but both were being discarded by
 * reading only `.message` (this left the pipeline blind to what the model
 * actually produced on a reproducible live failure). This surfaces a
 * bounded excerpt of both in the thrown error's
 * message, and logs the *full* raw text server-side via `console.warn` —
 * deliberately never the request's `system`/`prompt`, only what the model
 * output, so this can't leak whatever sensitive document content was being
 * processed into logs any more than the model's own (failed) response
 * already does.
 */
function describeError(error: unknown): string {
  if (NoObjectGeneratedError.isInstance(error)) {
    console.warn(
      `[bedrock-structured-generation] NoObjectGeneratedError — full raw model output:\n${error.text ?? "(no text captured)"}`,
    );
    const issues = extractValidationIssues(error.cause);
    return `${error.message}${formatIssues(issues)}${formatTextExcerpt(error.text)}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function usageOrZero(usage: LanguageModelUsage | undefined): TokenUsage {
  return usage ? translateUsage(usage) : ZERO_USAGE;
}

/** A single leading/trailing ```` ```json ... ``` ```` (or bare ``` ``` ```) fence, as the AI SDK's own `injectJsonInstructionIntoMessages` warns models against. A no-op when the text isn't fenced. */
const CODE_FENCE_PATTERN = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;

function stripCodeFences(text: string): string {
  const match = CODE_FENCE_PATTERN.exec(text.trim());
  return match?.[1] ?? text;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(stripCodeFences(text));
  } catch {
    return undefined;
  }
}

/** Bounded recursion depth for {@link unwrapDoubleEncodedStrings} — real schemas here nest at most a few levels; this is a backstop against a pathological input, not a real limit. */
const MAX_UNWRAP_DEPTH = 5;

/**
 * Live evidence: calling a taxonomy-planning structured-generation request
 * against live Bedrock reproducibly returned an otherwise-correct answer
 * with one accidental extra layer of `JSON.stringify` around it — the expected
 * `{"groups": [...]}` arrived as `{"groups": "{\"groups\":[...]}"}`: the
 * array value replaced by a string holding a JSON encoding of the *whole
 * top-level object it's itself a field of*, self-nested one level deeper
 * under the same key. This walks any parsed JSON value (object or array,
 * bounded depth) and un-stringifies any string property that is itself
 * valid JSON decoding to an object or array — deliberately not to a
 * primitive, since plenty of legitimate string fields (a quote, a title)
 * could coincidentally parse as a bare number/boolean/string and must not
 * be touched. When the decoded value turns out to contain that same key
 * (the self-nesting shape seen live), one more level is collapsed — using
 * the inner value at that key rather than the whole decoded wrapper —
 * otherwise the decoded value is used as-is (a plain "this string was
 * really an object/array" encoding, no self-nesting involved). Keyed on the
 * *shape* of the bug, not on any particular schema or field name, so it
 * benefits every caller of this adapter, not just the taxonomy call that
 * surfaced it.
 */
function unwrapDoubleEncodedStrings(value: unknown, depth = 0): unknown {
  if (depth >= MAX_UNWRAP_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((item) => unwrapDoubleEncodedStrings(item, depth + 1));
  }
  if (typeof value !== "object" || value === null) return value;

  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string") {
      result[key] = unwrapDoubleEncodedStrings(raw, depth + 1);
      continue;
    }
    const nested = tryParseJson(raw);
    if (nested === undefined || typeof nested !== "object" || nested === null) {
      result[key] = raw;
      continue;
    }
    const unwrapped = unwrapDoubleEncodedStrings(nested, depth + 1);
    result[key] =
      !Array.isArray(unwrapped) && typeof unwrapped === "object" && unwrapped !== null && key in unwrapped
        ? (unwrapped as Record<string, unknown>)[key]
        : unwrapped;
  }
  return result;
}

/**
 * Zero-cost, zero-latency recovery attempted before ever spending a retry:
 * parse the raw text, apply {@link unwrapDoubleEncodedStrings}, and check
 * whether the result now actually satisfies the request's own schema. Only
 * used when it does — an unwrap that doesn't fully validate is discarded,
 * never partially applied.
 */
function attemptLocalRepair<Output>(schema: ZodType<Output>, text: string | undefined): Output | undefined {
  if (text === undefined) return undefined;
  const parsed = tryParseJson(text);
  if (parsed === undefined) return undefined;
  const candidate = unwrapDoubleEncodedStrings(parsed);
  const result = schema.safeParse(candidate);
  return result.success ? result.data : undefined;
}

/**
 * Top-level required field names of the request's own schema, when it's a
 * `z.object(...)` (including a `.refine(...)`-ed one — on zod 4.4.3 that
 * still returns the same `ZodObject`, so a refined schema takes this same
 * targeted path, not the generic one) — `undefined` for anything else (a
 * union, an array, etc.), matching `extractValidationIssues`'s house style
 * of yielding `undefined` on an unrecognized shape rather than guessing. A
 * field counts as required when it doesn't accept `undefined`
 * (`.isOptional()` is also `true` for a field with `.default(...)`, so those
 * are correctly excluded too — the model never has to supply them).
 */
function requiredTopLevelKeys<Output>(schema: ZodType<Output>): string[] | undefined {
  if (!(schema instanceof ZodObject)) return undefined;
  return Object.entries(schema.shape)
    .filter(([, fieldSchema]) => !fieldSchema.isOptional())
    .map(([key]) => key);
}

/**
 * Live evidence: a large multi-call run on Bedrock had the model answer a
 * schema'd request with a literal `{}` — no fields at all. The
 * double-encoding repair above can't touch it (there's no string value to
 * un-stringify), and the generic hint below didn't recover it live, likely
 * because "failed schema validation" reads as a data-shape problem rather
 * than "you produced nothing." True only when the parsed response is a
 * plain object missing every one of the schema's required top-level keys —
 * exactly the `{}` shape, and its close cousin of some optional-only
 * fields present but nothing required. Schemas with zero required top-level
 * keys can never reach this: an all-optional-fields object would have
 * satisfied `safeParse` and never produced a schema miss to retry in the
 * first place, so this can't misfire on a legitimately-optional-everything
 * schema.
 */
function isEmptyObjectMiss(requiredKeys: string[], text: string | undefined): boolean {
  if (requiredKeys.length === 0 || text === undefined) return false;
  const parsed = tryParseJson(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  return requiredKeys.every((key) => !(key in (parsed as Record<string, unknown>)));
}

/** Targeted corrective hint for {@link isEmptyObjectMiss} — names the exact fields the model omitted instead of the generic "failed validation" framing. */
function emptyObjectHint(requiredKeys: string[]): string {
  return [
    "Your previous response was an empty JSON object with no fields at all.",
    `The schema requires these top-level fields: ${requiredKeys.join(", ")}.`,
    "Respond again with a single valid JSON object that includes every one of those fields, each holding its correct native JSON type — never omit a required field and never answer with {}.",
    "Do not wrap the JSON in markdown code fences or add any other text.",
  ].join("\n");
}

/**
 * Generic corrective system hint appended for a retry after a schema miss —
 * built from the failed attempt's own validation issues plus the two
 * concrete failure modes evidence has actually shown or flagged as
 * plausible (the double-encoding finding above; fenced-markdown/truncation
 * speculation): never taxonomy-specific, since every caller of this adapter
 * shares the same retry path.
 */
function genericHint(error: NoObjectGeneratedError): string {
  const issues = extractValidationIssues(error.cause);
  const issueLines =
    issues && issues.length > 0
      ? issues.map((issue) => `- ${issue.path || "(root)"}: ${issue.message}`).join("\n")
      : "(no structured validation detail available for the last attempt)";
  return [
    "Your previous response failed schema validation:",
    issueLines,
    "",
    "Respond again with ONLY a single valid JSON object matching the schema exactly.",
    "Every field must be its native JSON type — never JSON-encode a nested array or object as a " +
      'string (e.g. a field expecting an array must contain the array literally, not a string like "[...]").',
    "Do not wrap the JSON in markdown code fences or add any other text.",
  ].join("\n");
}

/** Picks the catalogue entry matching the failed attempt's shape — the empty-object hint when it applies, the generic one otherwise. */
function correctiveHint<Output>(error: NoObjectGeneratedError, schema: ZodType<Output>): string {
  const requiredKeys = requiredTopLevelKeys(schema);
  if (requiredKeys && isEmptyObjectMiss(requiredKeys, error.text)) {
    return emptyObjectHint(requiredKeys);
  }
  return genericHint(error);
}

export function createBedrockStructuredGenerationPort(
  defaults: BedrockStructuredGenerationOptions = {},
  deps: BedrockStructuredGenerationPortDeps = {},
): StructuredGenerationPort {
  const createProvider = deps.createProvider ?? createAmazonBedrock;
  const runGenerateObject = deps.generateObject ?? generateObject;

  // Built once per port, not per call: unlike the claude-code adapter's
  // per-call `ClaudeCodeSettings` (which carry a call-scoped `onSdkMessage`
  // guardrail hook), nothing about this provider's config varies call to
  // call — only the model id does, resolved fresh on each `generate` below.
  const provider = createProvider({
    region: defaults.region,
    apiKey: defaults.apiKey,
  });

  return {
    async generate<Output>(
      request: StructuredGenerationRequest<Output>,
    ): Promise<StructuredGenerationResult<Output>> {
      const modelId = resolveModelId(request.model ?? defaults.model ?? BEDROCK_DEFAULT_MODEL);
      const model = provider.languageModel(modelId);
      // Clamped: a negative `schemaRetries` must not produce zero attempts —
      // that would skip the initial call entirely and fall straight through
      // to the "exhausted schema retries" throw below, misreporting a
      // config mistake as a retry exhaustion that never actually retried.
      // Floored (and non-finite input replaced by the default) so a
      // fractional value can't leave `maxAttempts` fractional too — that
      // would make `attempt === maxAttempts` never hold for any integer
      // `attempt`, silently losing the enriched "last attempt" error path.
      const requestedSchemaRetries = defaults.schemaRetries ?? DEFAULT_SCHEMA_RETRIES;
      const schemaRetries = Math.max(
        0,
        Math.floor(Number.isFinite(requestedSchemaRetries) ? requestedSchemaRetries : DEFAULT_SCHEMA_RETRIES),
      );
      const maxAttempts = 1 + schemaRetries;

      let usage: TokenUsage = ZERO_USAGE;
      // Rebuilt fresh from `request.system` each retry (never appended to
      // itself) so a corrective hint reflects only the *latest* attempt's
      // issues rather than compounding across retries.
      let system = request.system;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const isLastAttempt = attempt === maxAttempts;

        try {
          const result = await runGenerateObject({
            model,
            schema: request.schema,
            prompt: request.prompt,
            system,
            schemaName: request.schemaName,
            schemaDescription: request.schemaDescription,
          });
          return { object: result.object, usage: addUsage(usage, translateUsage(result.usage)) };
        } catch (error) {
          if (!NoObjectGeneratedError.isInstance(error)) {
            throw new StructuredGenerationError(
              `structured generation failed: ${describeError(error)}`,
              error,
            );
          }
          usage = addUsage(usage, usageOrZero(error.usage));

          const repaired = attemptLocalRepair(request.schema, error.text);
          if (repaired !== undefined) {
            console.warn(
              `[bedrock-structured-generation] recovered a schema miss via local repair (attempt ${attempt}/${maxAttempts}).`,
            );
            return { object: repaired, usage };
          }

          if (isLastAttempt) {
            throw new StructuredGenerationError(
              `structured generation failed: ${describeError(error)}`,
              error,
            );
          }

          console.warn(
            `[bedrock-structured-generation] schema miss on attempt ${attempt}/${maxAttempts} — retrying with a corrective hint.`,
          );
          system = `${request.system ? `${request.system}\n\n` : ""}${correctiveHint(error, request.schema)}`;
        }
      }

      // Unreachable: `maxAttempts` is always >= 1, so the loop above always
      // either returns or throws on its last iteration.
      throw new StructuredGenerationError("structured generation failed: exhausted schema retries");
    },
  };
}
