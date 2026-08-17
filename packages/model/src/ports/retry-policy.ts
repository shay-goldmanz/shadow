/**
 * Port 2 add-on — retry policy for agentic session turns (T1.2).
 *
 * `RetryPolicy` is the pure decision function a retrying decorator (T1.3's
 * `RetryingAgenticSession`, not built here — see that task) consults after
 * a turn fails with nothing yet yielded to the caller: "should this turn be
 * re-issued, and after how long?" Kept as its own tiny port, separate from
 * `AgenticSessionPort`, so the decision is unit-testable without a session,
 * a subprocess, or even a decorator — and so a caller can swap it for
 * `noRetryPolicy` (tests, or an operator who wants zero retry behavior) or
 * a custom policy without touching anything else in the stack. The swap
 * point is `createModel()`'s `CreateModelOptions.retryPolicy`
 * (`../factory.ts`), threaded from `packages/api/src/composition.ts` — one
 * option to change or disable.
 *
 * ## What a `TurnFailure` actually is
 *
 * `AgenticSession.stream()` (`./agentic-session.ts`) fails in exactly two
 * ways, and `TurnFailure` exists to normalize both into one shape a policy
 * can classify without knowing which channel it came from:
 *
 * 1. **Thrown** — the method's own `@throws` contract: `SubscriptionAuthError`
 *    (D5's guardrail — resolved credentials were not the operator's
 *    subscription) or `AgenticSessionError` (a transport/process failure
 *    that prevented the turn from running at all). The concrete adapter,
 *    `ClaudeAgentSdkSession` (`../adapters/claude-agent-sdk-session.ts`),
 *    throws the latter for two documented reasons: reusing a
 *    `persistSession: false` handle for a second turn (an eager guard, so
 *    this exact message never reaches the CLI), and — the shape that
 *    matters for retrying — the underlying `query()` call itself erroring,
 *    which is where a resume naming a session id the CLI has no transcript
 *    for surfaces as a thrown `"No conversation found with session ID: ..."`
 *    (verified live; see that adapter's `persistSession: false` guard
 *    comment, and `FakeAgenticSession`'s mirror of it below).
 * 2. **`isError` result** — a turn that *ran* but whose final `result`
 *    message carried `is_error: true`, surfaced as `AgenticTurnResult`
 *    (never thrown — see `AgenticStreamEvent`'s `"done"` doc: "the final
 *    event is always `{ type: "done", result }` ... including an error
 *    turn"). T1.1's own investigation of `ClaudeAgentSdkSession`'s
 *    `case "result"` branch found this is the *common* shape for
 *    529/overloaded and similar transient API failures — the CLI reports
 *    them as a completed-but-failed turn, not a thrown exception. The only
 *    fields `AgenticTurnResult` exposes for classification are `text`
 *    (the CLI's `result.result` string when the CLI used the `"success"`
 *    subtype — which, confusingly, can still carry `is_error: true` for an
 *    API-level failure — and `""` for every other `result` subtype) and
 *    `stopReason`. Both get folded into `TurnFailure.message` /
 *    `.stopReason` below; there is currently no richer structured field to
 *    read (the Agent SDK's own `SDKAssistantMessageError` literal union —
 *    `'rate_limit' | 'overloaded' | 'server_error' | 'authentication_failed'
 *    | ...`, `@anthropic-ai/claude-agent-sdk`'s `sdk.d.ts` — is real and is
 *    exactly what these signatures are named after, but it lives on
 *    `SDKAssistantMessage.error` / `SDKAPIRetryMessage.error`, neither of
 *    which `ClaudeAgentSdkSession` currently reads into `AgenticTurnResult`).
 *    Widening `AgenticTurnResult` to carry that field is future work, not
 *    this task's — see the module doc's "adjust to reality" instruction.
 *
 * Because both channels reduce to the same `{ message, stopReason }` pair,
 * `conservativeRetryPolicy` below matches signatures against whichever text
 * is available, uniformly, regardless of `kind` — a 529 that happens to
 * surface as a thrown error (e.g. a raw transport-level failure before the
 * CLI could even form a `result`) is classified exactly like one that
 * surfaces as an `isError` result.
 */

import { SubscriptionAuthError } from "../errors.ts";
import type { AgenticTurnResult } from "./agentic-session.ts";

/**
 * A normalized turn failure, built from either of `AgenticSession.stream()`'s
 * two failure channels (see this module's doc) — the input `RetryPolicy`
 * classifies.
 */
export interface TurnFailure {
  /**
   * `"thrown"` — an error propagated out of `stream()` before/without a
   * `"done"` event (see `turnFailureFromThrown`). `"error-result"` — the
   * turn completed but `result.isError` was `true` (see
   * `turnFailureFromErrorResult`).
   */
  readonly kind: "thrown" | "error-result";
  /**
   * The raw text to classify against. For `"thrown"`, the thrown value's
   * `message` (or `String(error)` if it wasn't an `Error`). For
   * `"error-result"`, `AgenticTurnResult.text` — which is the empty string
   * for every `result` subtype except the CLI's own `"success"` (see this
   * module's doc on why a `"success"`-subtype result can still be an
   * error) — so `stopReason` is often the only real signal on this channel.
   */
  readonly message: string;
  /** `AgenticTurnResult.stopReason`, when this failure came from an `isError` result. `undefined` for a thrown failure — there was no result to read one from. */
  readonly stopReason?: string | null;
  /** The raw thrown value, when this failure came from the `"thrown"` channel — preserved so a policy (or a caller logging the decision) can `instanceof`-check it directly rather than re-parsing `message`. `undefined` for `"error-result"`. */
  readonly error?: unknown;
}

/** Build a `TurnFailure` from a value thrown out of `AgenticSession.stream()` — see `AgenticSession.stream`'s `@throws` doc for the two documented shapes (`SubscriptionAuthError`, `AgenticSessionError`). */
export function turnFailureFromThrown(error: unknown): TurnFailure {
  return {
    kind: "thrown",
    message: error instanceof Error ? error.message : String(error),
    error,
  };
}

/**
 * Build a `TurnFailure` from a completed turn's result. Call this only when
 * `result.isError` is `true` — this function does not itself check the
 * flag, since a caller (T1.3's decorator) already branches on it to decide
 * whether to consult a `RetryPolicy` at all.
 */
export function turnFailureFromErrorResult(result: AgenticTurnResult): TurnFailure {
  return {
    kind: "error-result",
    message: result.text,
    stopReason: result.stopReason,
  };
}

/**
 * Decides whether a failed turn should be retried, and after how long.
 * Consulted only when zero events have been yielded to the caller for the
 * failing turn (T1.3's structural safety rule — never applies to a turn
 * that already produced partial output, to avoid silent duplicate content).
 */
export interface RetryPolicy {
  /** null = don't retry; number = delay ms before attempt `attempt + 1`. */
  delayBeforeRetry(failure: TurnFailure, attempt: number): number | null;
}

/**
 * A policy that never retries — the explicit opt-out for tests that want
 * deterministic single-attempt behavior, or an operator who wants zero
 * retry behavior. Also useful as the "control" arm in a test that wants to
 * prove a failure *would* have been retried under the default policy.
 */
export const noRetryPolicy: RetryPolicy = {
  delayBeforeRetry: () => null,
};

/**
 * `"No conversation found with session ID: ..."` — verified live (see this
 * module's doc, and `FakeAgenticSession`'s mirror of the same text in
 * `../fakes/fake-agentic-session.ts`). **Never** retried, checked first and
 * unconditionally: Tier 2's persisted-session resume fallback (a later
 * task) depends on seeing this failure on the very first attempt, so it can
 * fall back to starting a fresh session — a policy that swallowed a few
 * retries first would just delay that fallback by seconds for a failure
 * retrying can never fix (the session id genuinely does not exist on this
 * machine; trying again with the same id fails the same way every time).
 */
const NO_CONVERSATION_FOUND_PATTERN = /no conversation found/i;

/**
 * Case-insensitive keyword/status-code signatures for the transient
 * failures `conservativeRetryPolicy` retries: 529/"overloaded", rate
 * limiting, and transient 5xx. Named after the Agent SDK's own
 * `SDKAssistantMessageError` literal union (`'overloaded' | 'rate_limit' |
 * 'server_error' | ...`, `@anthropic-ai/claude-agent-sdk`'s `sdk.d.ts`) —
 * the CLI's structured classification for exactly this family of failures
 * — plus the HTTP status codes the underlying Anthropic API uses for the
 * same conditions (529 overloaded, 429 rate-limited, 500/502/503/504
 * transient server errors). `AgenticTurnResult` does not currently surface
 * that structured field to us (see this module's doc), so matching is
 * deliberately broad substring/regex matching against whatever raw text
 * `TurnFailure.message`/`.stopReason` does carry, on either failure
 * channel — not an `instanceof`/exact-enum check, because there is no
 * typed enum available at this port's boundary to check against.
 */
const RETRYABLE_KEYWORD_PATTERN = /overloaded|rate[_ ]limit|server[_ ]error/i;
const RETRYABLE_STATUS_CODE_PATTERN = /\b(429|500|502|503|504|529)\b/;

/** `conservativeRetryPolicy`'s fixed backoff: ~1s before the first retry, ~4s before the second. Two retries max — a third failure of any kind (even a retryable signature) exhausts the budget. */
const RETRY_DELAYS_MS: readonly number[] = [1000, 4000];

function isRetryableSignature(failure: TurnFailure): boolean {
  const haystack = `${failure.message} ${failure.stopReason ?? ""}`;
  return RETRYABLE_KEYWORD_PATTERN.test(haystack) || RETRYABLE_STATUS_CODE_PATTERN.test(haystack);
}

/**
 * The default `RetryPolicy` (`createModel`'s default — see `../factory.ts`).
 * Retries 529/"overloaded", rate-limit, and transient 5xx signatures, up to
 * twice, at ~1s then ~4s. Two things it **never** retries, checked before
 * the retryable-signature match so they win even in the (implausible) case
 * their text also happened to contain a retryable keyword:
 *
 * - **`SubscriptionAuthError`** (D5's guardrail/auth failure, the only
 *   error class in this package that guards the no-API-keys invariant —
 *   see `../guardrail.ts`). Retrying cannot fix bad credentials; every
 *   retry would fail exactly the same way, so this must propagate on the
 *   first attempt.
 * - **`"No conversation found"`** (see `NO_CONVERSATION_FOUND_PATTERN`'s
 *   doc above) — Tier 2's resume fallback depends on seeing it immediately.
 */
export const conservativeRetryPolicy: RetryPolicy = {
  delayBeforeRetry(failure, attempt) {
    if (failure.error instanceof SubscriptionAuthError) return null;
    if (NO_CONVERSATION_FOUND_PATTERN.test(failure.message)) return null;
    if (attempt >= RETRY_DELAYS_MS.length) return null;
    if (!isRetryableSignature(failure)) return null;
    // `attempt < RETRY_DELAYS_MS.length` is already guaranteed by the
    // exhaustion check above; the `?? null` only satisfies
    // `noUncheckedIndexedAccess`, it can't actually be reached.
    return RETRY_DELAYS_MS[attempt] ?? null;
  },
};
