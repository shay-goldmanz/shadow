import { describe, expect, test } from "bun:test";
import { createModel } from "./factory.ts";
import { conservativeRetryPolicy, noRetryPolicy } from "./ports/retry-policy.ts";
import { RetryingAgenticSession } from "./retrying-agentic-session.ts";

/**
 * Cheap-minors review fix: `createModel` wraps every session its
 * `agenticSession` port hands out in `RetryingAgenticSession` (T1.3,
 * `./factory.ts`'s `withRetrying`) — entirely a construction-time seam, so
 * this is testable offline without a live subprocess/credential (no
 * `.stream()` call here, just `createSession()`, which only builds objects).
 * Pins the wrap itself: deleting `withRetrying` from `createModel` would
 * make every session it returns a bare `ClaudeAgentSdkSession` again,
 * silently losing T1.3's retry behavior for the whole stack, and this is
 * the one test that would catch that regression in CI (nothing else in
 * this package's suite constructs `createModel()` directly — everything
 * else goes through the fakes).
 */
describe("createModel — offline construction (cheap-minors review fix)", () => {
  test("agenticSession.createSession() returns a RetryingAgenticSession, by default", () => {
    const model = createModel();
    const session = model.agenticSession.createSession();
    expect(session).toBeInstanceOf(RetryingAgenticSession);
    expect(model.retryPolicy).toBe(conservativeRetryPolicy);
  });

  test("an explicit retryPolicy is threaded through to the same wrap, and reported back on Model.retryPolicy", () => {
    const model = createModel({ retryPolicy: noRetryPolicy });
    const session = model.agenticSession.createSession();
    expect(session).toBeInstanceOf(RetryingAgenticSession);
    expect(model.retryPolicy).toBe(noRetryPolicy);
  });
});
