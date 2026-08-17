/**
 * T1.3 — retrying decorator around any `AgenticSession`.
 *
 * `stream()` tracks whether *any* event has reached the caller for the
 * current turn. On a failure — either channel `AgenticSession.stream()` can
 * fail through, see `./ports/retry-policy.ts`'s module doc — with **zero**
 * events yielded so far, this decorator builds a `TurnFailure`, consults the
 * injected `RetryPolicy` with the current attempt number, sleeps the
 * returned delay, and re-issues the *same* turn (same `prompt`, same
 * underlying session handle) rather than surfacing the failure. Once a
 * single delta/tool/any event has been yielded, a failure on that same turn
 * passes straight through — no retry, no swallowing. This is the design's
 * no-silent-duplicate-output rule, and it is enforced structurally here
 * rather than by convention: `stream()` is the only place that actually
 * knows what has and hasn't reached the caller, so it is the only place that
 * can safely make this call.
 *
 * Re-issuing "the same turn" means calling `inner.stream(prompt)` again on
 * the *same* wrapped session handle, not constructing a new one. That is
 * also what makes this compose with T1.1 for free: a first turn that fails
 * (thrown or `isError`) never latches a session id on the underlying
 * handle (`ClaudeAgentSdkSession`/`FakeAgenticSession`, both T1.1), so the
 * retried call still looks like a first turn to it and still bootstraps
 * from whatever `resume`/`continueMostRecent` the caller originally passed
 * — this decorator does not need to know or re-supply that itself.
 *
 * An `isError` `"done"` event is the trickiest of the two failure channels:
 * `AgenticSession.stream()`'s contract says the final event is *always*
 * `{ type: "done", result }`, including an error turn (see that method's
 * doc, `./ports/agentic-session.ts`) — so the failure does not throw, it
 * arrives as an ordinary event in the stream. When zero events have been
 * yielded and this decorator decides to retry, that `"done"` event is
 * therefore consumed and never forwarded to the caller: the caller only
 * ever sees a `"done"` event for the attempt that actually finished the
 * turn (success, or the final exhausted failure), never for an
 * intermediate attempt the policy chose to retry past.
 *
 * Applied inside `createModel()` (`./factory.ts`), wrapping the
 * `AgenticSessionPort`'s `createSession` itself — every `AgenticSession`
 * handle it hands out (Shadow chat's, each per-brief research agent's, the
 * search provider's) is retrying without its caller knowing. `noRetryPolicy`
 * (`./ports/retry-policy.ts`) makes that wrapping a true no-op: attempt 0
 * always gets `null` back, so the first failure of either channel surfaces
 * immediately — identical to an unwrapped session.
 */

import type { AgenticSession, AgenticStreamEvent } from "./ports/agentic-session.ts";
import {
  type RetryPolicy,
  turnFailureFromErrorResult,
  turnFailureFromThrown,
} from "./ports/retry-policy.ts";

/** Delays a retry by `ms` milliseconds. Injectable so tests use fake/instant time instead of real ~1s/~4s sleeps. */
export type SleepFn = (ms: number) => Promise<void>;

/** The default `SleepFn`: a real `setTimeout`-backed delay. */
export const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wraps any `AgenticSession` with `RetryPolicy`-governed retry — see this module's doc. */
export class RetryingAgenticSession implements AgenticSession {
  constructor(
    private readonly inner: AgenticSession,
    private readonly policy: RetryPolicy,
    private readonly sleep: SleepFn = realSleep,
  ) {}

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  get usage(): AgenticSession["usage"] {
    return this.inner.usage;
  }

  async *stream(prompt: string): AsyncGenerator<AgenticStreamEvent, void, undefined> {
    let attempt = 0;
    // Labeled so a retry decision made deep inside the inner read loop
    // (either branch below) can restart the whole turn cleanly, without
    // threading a "please retry" flag back out through the loop's control
    // flow.
    attemptLoop: for (;;) {
      // Reset per attempt: this is the "has anything reached the caller
      // *for this attempt's turn*" flag the whole decorator exists to
      // track (see module doc). A fresh iterator per attempt is what
      // actually re-issues the turn.
      let yielded = false;
      const iterator = this.inner.stream(prompt)[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done) {
            // The port's contract guarantees a "done" event before
            // completion; tolerate a well-behaved-but-early-ending
            // generator the same way `runToCompletion` does, rather than
            // asserting here.
            return;
          }
          const event = next.value;

          if (event.type === "done" && event.result.isError && !yielded) {
            const failure = turnFailureFromErrorResult(event.result);
            const delay = this.policy.delayBeforeRetry(failure, attempt);
            if (delay !== null) {
              await this.sleep(delay);
              attempt += 1;
              // The error "done" event is intentionally never yielded here
              // — see module doc on why a retried attempt's terminal event
              // must not reach the caller.
              continue attemptLoop;
            }
            // Policy exhausted (or declined): fall through and yield this
            // "done" event as the turn's real outcome.
          }

          if (event.type !== "done") {
            yielded = true;
          }
          yield event;
          if (event.type === "done") {
            return;
          }
        }
      } catch (error) {
        if (!yielded) {
          const failure = turnFailureFromThrown(error);
          const delay = this.policy.delayBeforeRetry(failure, attempt);
          if (delay !== null) {
            await this.sleep(delay);
            attempt += 1;
            continue attemptLoop;
          }
        }
        // Either something was already yielded (no-silent-duplicate rule —
        // pass through untouched) or the policy declined: rethrow as-is,
        // the same failure the caller would have seen unwrapped.
        throw error;
      }
    }
  }

  async close(): Promise<void> {
    await this.inner.close?.();
  }
}
