import { describe, expect, test } from "bun:test";
import {
  createClaudeAgentSdkSessionPort,
  type QueryFn,
} from "./adapters/claude-agent-sdk-session.ts";
import { AgenticSessionError } from "./errors.ts";
import {
  FakeAgenticSession,
  FakeAgenticSessionPort,
  type FakeAgenticTurnResponder,
  failNTimesThenSucceed,
} from "./fakes/fake-agentic-session.ts";
import type {
  AgenticSession,
  AgenticSessionOptions,
  AgenticStreamEvent,
  AgenticTurnResult,
} from "./ports/agentic-session.ts";
import { runToCompletion } from "./ports/agentic-session.ts";
import {
  conservativeRetryPolicy,
  noRetryPolicy,
  type RetryPolicy,
  type TurnFailure,
} from "./ports/retry-policy.ts";
import { RetryingAgenticSession, type SleepFn } from "./retrying-agentic-session.ts";
import { expectRejection } from "./test-helpers.ts";
import { ZERO_USAGE } from "./usage.ts";

/** Records every `delayBeforeRetry` call (failure + attempt) and returns whatever `decide` says. */
function spyPolicy(decide: (failure: TurnFailure, attempt: number) => number | null): {
  readonly policy: RetryPolicy;
  readonly calls: Array<{ failure: TurnFailure; attempt: number }>;
} {
  const calls: Array<{ failure: TurnFailure; attempt: number }> = [];
  return {
    policy: {
      delayBeforeRetry(failure, attempt) {
        calls.push({ failure, attempt });
        return decide(failure, attempt);
      },
    },
    calls,
  };
}

/** Records every delay it was asked to sleep for, and resolves immediately — no real ~1s/~4s waits in tests. */
function fakeSleep(): { readonly sleep: SleepFn; readonly delays: number[] } {
  const delays: number[] = [];
  return {
    sleep: async (ms) => {
      delays.push(ms);
    },
    delays,
  };
}

/** `FakeAgenticSessionPort.createSession()` is typed to return the port interface, `AgenticSession` — narrow it back to the concrete `FakeAgenticSession` so tests can read its inspectable `.prompts`/`.isClosed` fields, which are genuinely there at runtime but not part of the port's contract. */
function createFakeSession(
  responder?: FakeAgenticTurnResponder,
  options?: AgenticSessionOptions,
): FakeAgenticSession {
  return new FakeAgenticSessionPort(responder).createSession(options) as FakeAgenticSession;
}

/** Drains `session.stream(prompt)` into an array — the raw event sequence the caller actually saw, unlike `runToCompletion` which discards everything but the final result. */
async function collect(session: AgenticSession, prompt: string): Promise<AgenticStreamEvent[]> {
  const events: AgenticStreamEvent[] = [];
  for await (const event of session.stream(prompt)) {
    events.push(event);
  }
  return events;
}

/** A hand-rolled `AgenticSession` that yields one delta, then throws — the "failure after partial output" shape `FakeAgenticSession` deliberately can't script (see `FakeAgenticTurnScript.throws`'s doc). */
function sessionThatYieldsThenThrows(deltaText: string, error: unknown): AgenticSession {
  return {
    sessionId: undefined,
    usage: ZERO_USAGE,
    failedSessionIds: [],
    async *stream(): AsyncGenerator<AgenticStreamEvent, void, undefined> {
      yield { type: "text-delta", text: deltaText };
      throw error;
    },
  };
}

/** A hand-rolled `AgenticSession` that yields one delta, then an `isError` "done" event — same rationale as `sessionThatYieldsThenThrows`, for the other failure channel. */
function sessionThatYieldsThenErrors(deltaText: string): AgenticSession {
  return {
    sessionId: undefined,
    usage: ZERO_USAGE,
    failedSessionIds: [],
    async *stream(): AsyncGenerator<AgenticStreamEvent, void, undefined> {
      yield { type: "text-delta", text: deltaText };
      yield {
        type: "done",
        result: {
          text: "",
          usage: ZERO_USAGE,
          sessionId: "irrelevant",
          stopReason: "overloaded_error",
          isError: true,
          subagentsEnabled: false,
        },
      };
    },
  };
}

describe("RetryingAgenticSession — thrown failure, zero events yielded (T1.3)", () => {
  test("fail-then-succeed: one seamless turn from the caller's view; policy consulted with attempt 0", async () => {
    const boom = new AgenticSessionError("simulated transport failure");
    const inner = createFakeSession(failNTimesThenSucceed(1, boom, { text: "recovered" }));
    const { policy, calls } = spyPolicy(() => 0);
    const { sleep, delays } = fakeSleep();
    const session = new RetryingAgenticSession(inner, policy, sleep);

    const events = await collect(session, "hello");

    // Exactly one event reached the caller: the final, successful "done" —
    // the failed first attempt is invisible to it.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "done",
      result: { isError: false, text: "recovered" },
    });

    expect(calls).toEqual([
      { failure: { kind: "thrown", message: boom.message, error: boom }, attempt: 0 },
    ]);
    expect(delays).toEqual([0]);
    // The underlying handle really did see the turn twice, same prompt both times.
    expect(inner.prompts).toEqual(["hello", "hello"]);
  });
});

describe("RetryingAgenticSession — isError done-event failure, zero events yielded (T1.3)", () => {
  test("fail via isError then succeed: one seamless turn; the error done-event is never yielded to the caller", async () => {
    let calls = 0;
    const inner = createFakeSession(() => {
      calls += 1;
      return calls === 1
        ? { isError: true, text: "", stopReason: "overloaded_error" }
        : { text: "ok" };
    });
    const { policy, calls: policyCalls } = spyPolicy(() => 0);
    const { sleep } = fakeSleep();
    const session = new RetryingAgenticSession(inner, policy, sleep);

    const events = await collect(session, "hi");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "done", result: { isError: false, text: "ok" } });
    expect(policyCalls).toEqual([
      {
        failure: { kind: "error-result", message: "", stopReason: "overloaded_error" },
        attempt: 0,
      },
    ]);
  });
});

describe("RetryingAgenticSession — failure AFTER an event has been yielded (T1.3)", () => {
  test("a thrown failure after the first delta surfaces immediately: no retry, no duplicate events", async () => {
    const boom = new AgenticSessionError("529 overloaded after first delta");
    const inner = sessionThatYieldsThenThrows("partial output", boom);
    const { policy, calls } = spyPolicy(() => 1000); // would retry if ever consulted
    const { sleep, delays } = fakeSleep();
    const session = new RetryingAgenticSession(inner, policy, sleep);

    const events: AgenticStreamEvent[] = [];
    const rejection = await expectRejection(
      (async () => {
        for await (const event of session.stream("hi")) {
          events.push(event);
        }
      })(),
      AgenticSessionError,
    );

    expect(rejection).toBe(boom); // the exact same failure, untouched
    expect(events).toEqual([{ type: "text-delta", text: "partial output" }]);
    expect(calls).toHaveLength(0); // never consulted — the rule applies structurally, not by policy choice
    expect(delays).toHaveLength(0);
  });

  test("an isError done-event after the first delta is passed through untouched: no retry, no duplicate events", async () => {
    const inner = sessionThatYieldsThenErrors("partial output");
    const { policy, calls } = spyPolicy(() => 1000);
    const session = new RetryingAgenticSession(inner, policy, fakeSleep().sleep);

    const events = await collect(session, "hi");

    expect(events).toEqual([
      { type: "text-delta", text: "partial output" },
      {
        type: "done",
        result: {
          text: "",
          usage: ZERO_USAGE,
          sessionId: "irrelevant",
          stopReason: "overloaded_error",
          isError: true,
          subagentsEnabled: false,
        },
      },
    ]);
    expect(calls).toHaveLength(0);
  });
});

describe("RetryingAgenticSession — policy exhaustion (T1.3)", () => {
  test("thrown channel: the last failure surfaces once the policy declines to retry further", async () => {
    const boom = new AgenticSessionError("still failing");
    const inner = createFakeSession(failNTimesThenSucceed(2, boom));
    // Retries once (attempt 0), declines at attempt 1 — so the SECOND
    // failure (of the two scripted) is what surfaces.
    const { policy, calls } = spyPolicy((_failure, attempt) => (attempt === 0 ? 0 : null));
    const { sleep } = fakeSleep();
    const session = new RetryingAgenticSession(inner, policy, sleep);

    const rejection = await expectRejection(runToCompletion(session, "hi"), AgenticSessionError);
    expect(rejection).toBe(boom);
    expect(calls.map((c) => c.attempt)).toEqual([0, 1]);
    expect(inner.prompts).toEqual(["hi", "hi"]); // exactly two attempts, no third
  });

  test("isError channel: the last error result surfaces once the policy declines to retry further", async () => {
    let calls = 0;
    const inner = createFakeSession(() => {
      calls += 1;
      return { isError: true, text: "", stopReason: `attempt-${calls}` };
    });
    const { policy, calls: policyCalls } = spyPolicy((_failure, attempt) =>
      attempt === 0 ? 0 : null,
    );
    const { sleep } = fakeSleep();
    const session = new RetryingAgenticSession(inner, policy, sleep);

    const result = await runToCompletion(session, "hi");
    expect(result.isError).toBe(true);
    // The exhausted (second) attempt's own stopReason surfaced, not the first's.
    expect(result.stopReason).toBe("attempt-2");
    expect(policyCalls.map((c) => c.attempt)).toEqual([0, 1]);
  });
});

describe("RetryingAgenticSession — retried first turn preserves `resume` (composes with T1.1)", () => {
  test("both the failing attempt and its retry bootstrap from the caller's original `resume` target", async () => {
    const calls: Array<{ prompt: string; resume: string | undefined }> = [];
    let callIndex = 0;
    const queryFn: QueryFn = ({ prompt, options }) => {
      calls.push({ prompt, resume: options?.resume });
      const thisCall = callIndex++;
      return (async function* () {
        if (thisCall === 0) {
          throw new AgenticSessionError("simulated transport failure (e.g. 529 overloaded)");
        }
        yield {
          type: "system",
          subtype: "init",
          apiKeySource: "none",
          claude_code_version: "test",
          cwd: "/tmp",
          tools: ["Read"],
          mcp_servers: [],
          model: "claude-sonnet-5",
          permissionMode: "default",
          slash_commands: [],
          output_style: "default",
          skills: [],
          plugins: [],
          uuid: "00000000-0000-0000-0000-000000000000",
          session_id: "second-attempt-session",
          // biome-ignore lint/suspicious/noExplicitAny: minimal SDKMessage stub, only the fields the adapter reads matter here.
        } as any;
        yield {
          type: "result",
          subtype: "success",
          duration_ms: 1,
          duration_api_ms: 1,
          is_error: false,
          num_turns: 1,
          result: "ok",
          stop_reason: "end_turn",
          total_cost_usd: 0,
          usage: {},
          modelUsage: {},
          permission_denials: [],
          uuid: "00000000-0000-0000-0000-000000000001",
          session_id: "second-attempt-session",
          // biome-ignore lint/suspicious/noExplicitAny: minimal SDKMessage stub, only the fields the adapter reads matter here.
        } as any;
      })();
    };
    const port = createClaudeAgentSdkSessionPort({}, { query: queryFn });
    const inner = port.createSession({ resume: { sessionId: "original-resume-target" } });
    const { policy } = spyPolicy(() => 0);
    const { sleep } = fakeSleep();
    const session = new RetryingAgenticSession(inner, policy, sleep);

    const events = await collect(session, "continuing from disk");

    expect(events).toHaveLength(1); // the failed first attempt never reached the caller
    expect(calls).toHaveLength(2);
    expect(calls[0]?.resume).toBe("original-resume-target");
    expect(calls[1]?.resume).toBe("original-resume-target"); // NOT undefined, and not the (nonexistent) failed id
    expect(session.sessionId).toBe("second-attempt-session");
  });
});

describe("RetryingAgenticSession — noRetryPolicy is a true opt-out (T1.3)", () => {
  test("thrown failure: identical to an unwrapped session — single attempt, the exact same error straight through", async () => {
    const boom = new AgenticSessionError("boom");
    const inner = createFakeSession(failNTimesThenSucceed(5, boom));
    const { sleep, delays } = fakeSleep();
    const session = new RetryingAgenticSession(inner, noRetryPolicy, sleep);

    const rejection = await expectRejection(runToCompletion(session, "hi"), AgenticSessionError);
    expect(rejection).toBe(boom);
    expect(inner.prompts).toEqual(["hi"]); // exactly one attempt, no retry
    expect(delays).toHaveLength(0); // sleep never consulted
  });

  test("isError failure: identical to an unwrapped session — single attempt, the error done-event straight through", async () => {
    const inner = createFakeSession(() => ({
      isError: true,
      text: "",
      stopReason: "overloaded_error",
    }));
    const { sleep, delays } = fakeSleep();
    const session = new RetryingAgenticSession(inner, noRetryPolicy, sleep);

    const events = await collect(session, "hi");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "done", result: { isError: true } });
    expect(inner.prompts).toEqual(["hi"]);
    expect(delays).toHaveLength(0);
  });
});

describe("RetryingAgenticSession — delay honored via injected fake sleep (T1.3, conservativeRetryPolicy)", () => {
  test("the ~1s then ~4s sequence is asked for, in order, before the turn recovers", async () => {
    const boom = new AgenticSessionError("API Error: 529 Overloaded");
    const inner = createFakeSession(failNTimesThenSucceed(2, boom, { text: "recovered" }));
    const { sleep, delays } = fakeSleep();
    const session = new RetryingAgenticSession(inner, conservativeRetryPolicy, sleep);

    const result = await runToCompletion(session, "hi");

    expect(result.text).toBe("recovered");
    expect(delays).toEqual([1000, 4000]);
    expect(inner.prompts).toEqual(["hi", "hi", "hi"]);
  });
});

/**
 * Builds an `AgenticSession` whose `stream()` mints a fresh, independently
 * trackable async generator per call ("attempt") — each with its own
 * `finally` that records into a shared `log`, in order, both when the
 * attempt STARTS (`start-N`) and when its iterator is actually CLOSED
 * (`close-N`, whether by running to completion, throwing, or an external
 * `.return()`/`.throw()`). Real async generator semantics, deliberately:
 * yielding suspends execution at that `yield` — the `finally` does NOT run
 * just because a value was produced, only once the generator is resumed
 * past its last yield (via a further pull) or explicitly closed. This is
 * exactly what F1's leak depended on: `RetryingAgenticSession` used to
 * abandon a still-suspended inner iterator on every exit path, and this
 * helper is the only way to observe that from outside (a plain event array
 * can't distinguish "closed" from "produced its last event and never
 * touched again").
 */
function trackedInnerSession(
  attempts: ReadonlyArray<{
    readonly events?: readonly AgenticStreamEvent[];
    readonly result?: AgenticTurnResult;
    readonly throws?: unknown;
  }>,
): { readonly session: AgenticSession; readonly log: string[] } {
  const log: string[] = [];
  let attemptIndex = 0;
  const session: AgenticSession = {
    sessionId: undefined,
    usage: ZERO_USAGE,
    failedSessionIds: [],
    stream(): AsyncGenerator<AgenticStreamEvent, void, undefined> {
      const thisAttempt = attemptIndex++;
      log.push(`start-${thisAttempt}`);
      const script = attempts[thisAttempt];
      return (async function* (): AsyncGenerator<AgenticStreamEvent, void, undefined> {
        try {
          if (!script) throw new Error(`trackedInnerSession: no script for attempt ${thisAttempt}`);
          for (const event of script.events ?? []) {
            yield event;
          }
          if (script.throws !== undefined) {
            throw script.throws;
          }
          if (script.result) {
            yield { type: "done", result: script.result };
          }
        } finally {
          log.push(`close-${thisAttempt}`);
        }
      })();
    },
  };
  return { session, log };
}

function doneResult(overrides: Partial<AgenticTurnResult> = {}): AgenticTurnResult {
  return {
    text: "",
    usage: ZERO_USAGE,
    sessionId: "session-x",
    stopReason: "end_turn",
    isError: false,
    subagentsEnabled: false,
    ...overrides,
  };
}

describe("RetryingAgenticSession — F1 review fix: the inner iterator is closed on every exit path", () => {
  test("normal completion: closed once the successful turn's 'done' has been forwarded", async () => {
    const { session: inner, log } = trackedInnerSession([{ result: doneResult({ text: "ok" }) }]);
    const session = new RetryingAgenticSession(inner, noRetryPolicy, fakeSleep().sleep);

    const events = await collect(session, "hi");

    expect(events).toHaveLength(1);
    // Before the fix: only "start-0" — the inner generator was left
    // suspended at its final yield, `finally` never ran, forever.
    expect(log).toEqual(["start-0", "close-0"]);
  });

  test("exhausted isError: closed once the non-retried failure's 'done' has been forwarded", async () => {
    const { session: inner, log } = trackedInnerSession([
      { result: doneResult({ isError: true, stopReason: "max_turns" }) },
    ]);
    const session = new RetryingAgenticSession(inner, noRetryPolicy, fakeSleep().sleep);

    const result = await runToCompletion(session, "hi");

    expect(result.isError).toBe(true);
    expect(log).toEqual(["start-0", "close-0"]);
  });

  test("consumer abandons the outer generator mid-turn (for-await break): the in-flight attempt is closed", async () => {
    const { session: inner, log } = trackedInnerSession([
      {
        events: [
          { type: "text-delta", text: "a" },
          { type: "text-delta", text: "b" },
        ],
      },
    ]);
    const session = new RetryingAgenticSession(inner, noRetryPolicy, fakeSleep().sleep);

    const seen: AgenticStreamEvent[] = [];
    for await (const event of session.stream("hi")) {
      seen.push(event);
      break; // for-await-of's break calls .return() on the outer generator
    }

    expect(seen).toEqual([{ type: "text-delta", text: "a" }]);
    expect(log).toEqual(["start-0", "close-0"]);
  });

  test("retry (isError channel): the abandoned attempt is closed strictly before the next attempt starts", async () => {
    const { session: inner, log } = trackedInnerSession([
      { result: doneResult({ isError: true, stopReason: "overloaded_error" }) },
      { result: doneResult({ text: "recovered" }) },
    ]);
    const { policy } = spyPolicy(() => 0);
    const session = new RetryingAgenticSession(inner, policy, fakeSleep().sleep);

    const result = await runToCompletion(session, "hi");

    expect(result.text).toBe("recovered");
    // Before the fix: "start-0", "start-1", "close-1" — attempt 0's
    // iterator was abandoned still suspended at its own final yield.
    expect(log).toEqual(["start-0", "close-0", "start-1", "close-1"]);
  });

  test("retry (thrown channel): the abandoned attempt is closed strictly before the next attempt starts", async () => {
    const boom = new AgenticSessionError("simulated transport failure");
    const { session: inner, log } = trackedInnerSession([
      { throws: boom },
      { result: doneResult({ text: "recovered" }) },
    ]);
    const { policy } = spyPolicy(() => 0);
    const session = new RetryingAgenticSession(inner, policy, fakeSleep().sleep);

    const result = await runToCompletion(session, "hi");

    expect(result.text).toBe("recovered");
    expect(log).toEqual(["start-0", "close-0", "start-1", "close-1"]);
  });

  test("rethrow after exhaustion: the final attempt's iterator is closed even though the failure propagates", async () => {
    const boom = new AgenticSessionError("still failing");
    const { session: inner, log } = trackedInnerSession([{ throws: boom }]);
    const session = new RetryingAgenticSession(inner, noRetryPolicy, fakeSleep().sleep);

    const rejection = await expectRejection(runToCompletion(session, "hi"), AgenticSessionError);

    expect(rejection).toBe(boom);
    expect(log).toEqual(["start-0", "close-0"]);
  });
});

describe("RetryingAgenticSession — F2 review fix: 'yielded' covers done events too", () => {
  test("after a successful done, the consumer's it.throw() propagates instead of silently retrying the whole turn", async () => {
    const inner = createFakeSession(() => ({ text: "ok" }));
    // Would retry if ever consulted — proves the catch block never treats
    // this as retryable.
    const { policy, calls } = spyPolicy(() => 0);
    const session = new RetryingAgenticSession(inner, policy, fakeSleep().sleep);

    const it = session.stream("hi")[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ type: "done", result: { isError: false, text: "ok" } });

    const boom = new Error("consumer decided to abort after seeing the result");
    const rejection = await expectRejection(it.throw(boom), Error);

    expect(rejection).toBe(boom);
    // Exactly one prompt reached the inner session — the turn was NEVER
    // silently re-run (the bug: `yielded` was false for a "done" event, so
    // the injected throw looked like a fresh, retryable failure).
    expect(inner.prompts).toEqual(["hi"]);
    expect(calls).toHaveLength(0);
  });
});

describe("RetryingAgenticSession — passthrough (T1.3)", () => {
  test("sessionId and usage delegate to the underlying session as it evolves across a retry", async () => {
    const boom = new AgenticSessionError("boom");
    const inner = createFakeSession(
      failNTimesThenSucceed(1, boom, {
        text: "ok",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    );
    const { policy } = spyPolicy(() => 0);
    const session = new RetryingAgenticSession(inner, policy, fakeSleep().sleep);

    expect(session.sessionId).toBeUndefined();
    await runToCompletion(session, "hi");
    expect(session.sessionId).toBe(inner.sessionId);
    expect(session.usage).toEqual(inner.usage);
    expect(session.usage.inputTokens).toBe(10);
  });

  test("close() delegates to the underlying session's close()", async () => {
    const inner = createFakeSession();
    const session = new RetryingAgenticSession(inner, noRetryPolicy, fakeSleep().sleep);

    await session.close();
    expect(inner.isClosed).toBe(true);
  });
});
