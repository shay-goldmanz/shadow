import { describe, expect, test } from "bun:test";
import { AgenticSessionError, SubscriptionAuthError } from "../errors.ts";
import type { AgenticTurnResult } from "./agentic-session.ts";
import {
  conservativeRetryPolicy,
  isNoConversationFoundError,
  noRetryPolicy,
  type TurnFailure,
  turnFailureFromErrorResult,
  turnFailureFromThrown,
} from "./retry-policy.ts";

function errorResult(overrides: Partial<AgenticTurnResult> = {}): AgenticTurnResult {
  return {
    text: "",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    sessionId: "session-1",
    stopReason: null,
    isError: true,
    subagentsEnabled: false,
    ...overrides,
  };
}

describe("turnFailureFromThrown", () => {
  test("kind 'thrown', message from an Error's .message, error preserved", () => {
    const cause = new AgenticSessionError("Overloaded (please retry)");
    const failure = turnFailureFromThrown(cause);
    expect(failure).toEqual({
      kind: "thrown",
      message: "Overloaded (please retry)",
      error: cause,
    });
  });

  test("a non-Error thrown value is stringified into message, still preserved as error", () => {
    const failure = turnFailureFromThrown("529 overloaded");
    expect(failure.kind).toBe("thrown");
    expect(failure.message).toBe("529 overloaded");
    expect(failure.error).toBe("529 overloaded");
  });
});

describe("turnFailureFromErrorResult", () => {
  test("kind 'error-result', message from result.text, stopReason carried, no .error", () => {
    const result = errorResult({ text: "Overloaded", stopReason: null });
    const failure = turnFailureFromErrorResult(result);
    expect(failure).toEqual({ kind: "error-result", message: "Overloaded", stopReason: null });
  });

  test("carries whatever stopReason the result had, even a non-null one", () => {
    const failure = turnFailureFromErrorResult(errorResult({ text: "", stopReason: "refusal" }));
    expect(failure.stopReason).toBe("refusal");
  });
});

describe("noRetryPolicy", () => {
  test("never retries, regardless of failure or attempt", () => {
    const failure = turnFailureFromErrorResult(errorResult({ text: "Overloaded" }));
    expect(noRetryPolicy.delayBeforeRetry(failure, 0)).toBeNull();
    expect(noRetryPolicy.delayBeforeRetry(failure, 1)).toBeNull();
  });
});

describe("conservativeRetryPolicy", () => {
  describe("retryable signatures — both failure channels", () => {
    const cases: ReadonlyArray<{ readonly label: string; readonly failure: TurnFailure }> = [
      {
        label: "529/overloaded as an isError result (the common shape T1.1 documented)",
        failure: turnFailureFromErrorResult(errorResult({ text: "Overloaded", stopReason: null })),
      },
      {
        label: "529/overloaded as a thrown error",
        failure: turnFailureFromThrown(new AgenticSessionError("API Error: 529 Overloaded")),
      },
      {
        label: "overloaded signaled only via stopReason, empty text",
        failure: turnFailureFromErrorResult(
          errorResult({ text: "", stopReason: "overloaded_error" }),
        ),
      },
      {
        label: "rate-limit as an isError result",
        failure: turnFailureFromErrorResult(
          errorResult({ text: "rate_limit_error: too many requests", stopReason: null }),
        ),
      },
      {
        label: "rate-limit as a thrown error (429)",
        failure: turnFailureFromThrown(new AgenticSessionError("HTTP 429 Too Many Requests")),
      },
      {
        label: "transient 5xx as an isError result (502)",
        failure: turnFailureFromErrorResult(
          errorResult({ text: "API Error: 502 Bad Gateway", stopReason: null }),
        ),
      },
      {
        label: "transient 5xx as a thrown error (server_error)",
        failure: turnFailureFromThrown(new AgenticSessionError("server_error: internal")),
      },
    ];

    for (const { label, failure } of cases) {
      test(`retries at attempt 0 (~1s) and attempt 1 (~4s), exhausts at attempt 2 — ${label}`, () => {
        expect(conservativeRetryPolicy.delayBeforeRetry(failure, 0)).toBe(1000);
        expect(conservativeRetryPolicy.delayBeforeRetry(failure, 1)).toBe(4000);
        expect(conservativeRetryPolicy.delayBeforeRetry(failure, 2)).toBeNull();
        expect(conservativeRetryPolicy.delayBeforeRetry(failure, 3)).toBeNull();
      });
    }
  });

  describe("never retried", () => {
    test("'No conversation found' thrown — falls through immediately, even at attempt 0", () => {
      const failure = turnFailureFromThrown(
        new AgenticSessionError("No conversation found with session ID: abc-123"),
      );
      expect(conservativeRetryPolicy.delayBeforeRetry(failure, 0)).toBeNull();
    });

    test("'No conversation found' is matched case-insensitively", () => {
      const failure = turnFailureFromThrown(
        new AgenticSessionError("no CONVERSATION found with session ID: abc-123"),
      );
      expect(conservativeRetryPolicy.delayBeforeRetry(failure, 0)).toBeNull();
    });

    test("SubscriptionAuthError (D5's guardrail/auth failure) — never retried, even at attempt 0", () => {
      const failure = turnFailureFromThrown(new SubscriptionAuthError("user"));
      expect(conservativeRetryPolicy.delayBeforeRetry(failure, 0)).toBeNull();
    });

    test("SubscriptionAuthError wins even if its text happened to contain a retryable keyword", () => {
      const auth = new SubscriptionAuthError("user");
      // Sanity: SubscriptionAuthError's own message never contains these
      // signatures for real, but this proves the instanceof check is
      // checked ahead of (and independent from) the keyword match — not
      // relying on the message text to stay keyword-free forever.
      const failure: TurnFailure = { kind: "thrown", message: "overloaded", error: auth };
      expect(conservativeRetryPolicy.delayBeforeRetry(failure, 0)).toBeNull();
    });

    test("an unrecognized error result (no retryable signature) is not retried", () => {
      const failure = turnFailureFromErrorResult(
        errorResult({ text: "", stopReason: "max_turns" }),
      );
      expect(conservativeRetryPolicy.delayBeforeRetry(failure, 0)).toBeNull();
    });

    test("an unrecognized thrown error (no retryable signature) is not retried", () => {
      const failure = turnFailureFromThrown(new AgenticSessionError("something else broke"));
      expect(conservativeRetryPolicy.delayBeforeRetry(failure, 0)).toBeNull();
    });

    // Cheap-minors review fix: issue #10's live-verified expired-OAuth
    // shape — an `isError` result, not a thrown `SubscriptionAuthError`
    // (that class is D5's own guardrail, checked separately above and
    // never what the CLI itself reports for an expired credential). Its
    // `stopReason` is `stop_sequence`, which is not itself a retryable
    // signature, and its message contains none of
    // `RETRYABLE_KEYWORD_PATTERN`/`RETRYABLE_STATUS_CODE_PATTERN`'s
    // signatures either — so this already falls through to "no retryable
    // signature" by construction. Pinned as its own regression case
    // (rather than folded into the generic "unrecognized" tests above)
    // because retrying an expired credential is actively harmful — it
    // burns the ~1s/~4s backoff, then the exhausted turn surfaces the
    // exact same "please re-authenticate" failure, for no reason.
    test("issue #10: an expired-OAuth error-result is not retried", () => {
      const failure = turnFailureFromErrorResult(
        errorResult({
          text: "Failed to authenticate: OAuth session expired. Please run `claude login` again.",
          stopReason: "stop_sequence",
        }),
      );
      expect(conservativeRetryPolicy.delayBeforeRetry(failure, 0)).toBeNull();
    });
  });

  test("attempt exhaustion applies even to a retryable signature — 2 retries is the hard cap", () => {
    const failure = turnFailureFromErrorResult(errorResult({ text: "Overloaded" }));
    expect(conservativeRetryPolicy.delayBeforeRetry(failure, 2)).toBeNull();
  });

  test("delay values are exactly ~1s then ~4s, not e.g. exponential from a different base", () => {
    const failure = turnFailureFromErrorResult(errorResult({ text: "Overloaded" }));
    expect(conservativeRetryPolicy.delayBeforeRetry(failure, 0)).toBe(1000);
    expect(conservativeRetryPolicy.delayBeforeRetry(failure, 1)).toBe(4000);
  });
});

describe("isNoConversationFoundError", () => {
  test("matches an Error whose message is the SDK's no-conversation-found text", () => {
    expect(
      isNoConversationFoundError(new Error("No conversation found with session ID: abc-123")),
    ).toBe(true);
  });

  test("matches case-insensitively, mirroring conservativeRetryPolicy's own match", () => {
    expect(isNoConversationFoundError(new Error("NO CONVERSATION FOUND with session ID: x"))).toBe(
      true,
    );
  });

  test("matches a non-Error thrown value stringified the same way turnFailureFromThrown does", () => {
    expect(isNoConversationFoundError("No conversation found with session ID: x")).toBe(true);
  });

  test("does not match an unrelated thrown error", () => {
    expect(isNoConversationFoundError(new Error("Overloaded"))).toBe(false);
  });
});
