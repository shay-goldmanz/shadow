import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgenticSessionError, SubscriptionAuthError } from "../errors.ts";
import { runToCompletion } from "../ports/agentic-session.ts";
import { expectRejection } from "../test-helpers.ts";
import { createClaudeAgentSdkSessionPort, type QueryFn } from "./claude-agent-sdk-session.ts";

function initMessage(overrides: { apiKeySource?: string; sessionId: string }): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: overrides.apiKeySource ?? "none",
    claude_code_version: "test",
    cwd: "/tmp",
    tools: ["Read", "Agent"],
    mcp_servers: [],
    model: "claude-sonnet-5",
    permissionMode: "default",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: randomUUID(),
    session_id: overrides.sessionId,
  } as SDKMessage;
}

function resultMessage(sessionId: string): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: "ok",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0 },
      // biome-ignore lint/suspicious/noExplicitAny: NonNullableUsage requires every BetaUsage field non-nullable; only fields our adapter reads matter for this test.
    } as any,
    modelUsage: {
      "claude-sonnet-5": {
        inputTokens: 12,
        outputTokens: 34,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 7,
        webSearchRequests: 0,
        costUSD: 0,
        contextWindow: 200000,
        maxOutputTokens: 8192,
      },
    },
    permission_denials: [],
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

function errorResultMessage(sessionId: string): SDKMessage {
  return {
    type: "result",
    subtype: "error_during_execution",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0 },
      // biome-ignore lint/suspicious/noExplicitAny: NonNullableUsage requires every BetaUsage field non-nullable; only fields our adapter reads matter for this test.
    } as any,
    modelUsage: {},
    permission_denials: [],
    errors: ["overloaded_error"],
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

/** Records every call's options and yields a scripted init+result pair. Each call gets a fresh sessionId unless the test wants otherwise. */
function makeRecordingQueryFn(options: {
  readonly apiKeySource?: string;
  readonly sessionIdForCall?: (callIndex: number) => string;
}): { queryFn: QueryFn; calls: Array<{ prompt: string; options: Options | undefined }> } {
  const calls: Array<{ prompt: string; options: Options | undefined }> = [];
  const sessionIdForCall = options.sessionIdForCall ?? (() => randomUUID());

  const queryFn: QueryFn = ({ prompt, options: callOptions }) => {
    calls.push({ prompt, options: callOptions });
    const sessionId = sessionIdForCall(calls.length - 1);
    return (async function* () {
      yield initMessage({ apiKeySource: options.apiKeySource, sessionId });
      yield resultMessage(sessionId);
    })();
  };

  return { queryFn, calls };
}

describe("createClaudeAgentSdkSessionPort — session reuse (D6)", () => {
  test("the second turn on the same session passes `resume` with the sessionId the first turn returned", async () => {
    const fixedSessionId = randomUUID();
    const { queryFn, calls } = makeRecordingQueryFn({ sessionIdForCall: () => fixedSessionId });
    const port = createClaudeAgentSdkSessionPort({}, { query: queryFn });
    const session = port.createSession();

    expect(session.sessionId).toBeUndefined();

    const first = await runToCompletion(session, "first turn");
    expect(first.sessionId).toBe(fixedSessionId);
    expect(session.sessionId).toBe(fixedSessionId);
    expect(calls[0]?.options?.resume).toBeUndefined();

    await runToCompletion(session, "second turn");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.options?.resume).toBe(fixedSessionId);
  });

  test("two independent sessions from the same port never share a resume target", async () => {
    let counter = 0;
    const { queryFn, calls } = makeRecordingQueryFn({
      sessionIdForCall: () => `session-${++counter}`,
    });
    const port = createClaudeAgentSdkSessionPort({}, { query: queryFn });

    const sessionA = port.createSession();
    const sessionB = port.createSession();

    await runToCompletion(sessionA, "a1");
    const sessionAIdAfterFirstTurn = sessionA.sessionId;
    await runToCompletion(sessionB, "b1");
    await runToCompletion(sessionA, "a2");

    expect(calls[0]?.options?.resume).toBeUndefined(); // a1: fresh
    expect(calls[1]?.options?.resume).toBeUndefined(); // b1: fresh, independent of A
    // a2 resumes the id A's OWN first turn established — not B's, and not
    // whatever A's own id has become after a2 itself (which is why this
    // reads the id captured right after a1, not `sessionA.sessionId` now).
    expect(calls[2]?.options?.resume).toBe(sessionAIdAfterFirstTurn);
  });

  test("an explicit `resume` bootstraps only the first turn of a new session handle", async () => {
    const { queryFn, calls } = makeRecordingQueryFn({ sessionIdForCall: () => "resumed-session" });
    const port = createClaudeAgentSdkSessionPort({}, { query: queryFn });
    const session = port.createSession({ resume: { sessionId: "prior-process-session" } });

    await runToCompletion(session, "continuing from disk");
    expect(calls[0]?.options?.resume).toBe("prior-process-session");

    await runToCompletion(session, "next turn");
    // Second turn resumes the id THIS handle established, not the original bootstrap target.
    expect(calls[1]?.options?.resume).toBe("resumed-session");
  });

  test("`Options.env` is always a spread over process.env, never a bare replacement", async () => {
    const { queryFn, calls } = makeRecordingQueryFn({});
    const port = createClaudeAgentSdkSessionPort({}, { query: queryFn });
    const session = port.createSession({ env: { CUSTOM_VAR: "1" } });
    await runToCompletion(session, "hi");

    expect(calls[0]?.options?.env?.PATH).toBe(process.env.PATH);
    expect(calls[0]?.options?.env?.CUSTOM_VAR).toBe("1");
  });
});

describe("createClaudeAgentSdkSessionPort — first turn derived from a successful session id (T1.1)", () => {
  test("first turn fails via a THROWN error → second stream() still passes the original `resume` options, not `resume: undefined`", async () => {
    const calls: Array<{ prompt: string; options: Options | undefined }> = [];
    let callIndex = 0;
    const queryFn: QueryFn = ({ prompt, options }) => {
      calls.push({ prompt, options });
      const thisCall = callIndex++;
      return (async function* () {
        if (thisCall === 0) {
          throw new Error("simulated transport failure (e.g. 529 overloaded)");
        }
        const sessionId = "second-attempt-session";
        yield initMessage({ sessionId });
        yield resultMessage(sessionId);
      })();
    };
    const port = createClaudeAgentSdkSessionPort({}, { query: queryFn });
    const session = port.createSession({ resume: { sessionId: "original-resume-target" } });

    await expectRejection(runToCompletion(session, "first turn"), Error);
    expect(session.sessionId).toBeUndefined();

    await runToCompletion(session, "retry");
    expect(calls).toHaveLength(2);
    // Both calls bootstrap from the caller's ORIGINAL resume target — the
    // failed attempt never got a chance to become this handle's "own"
    // session, so there is nothing else for the retry to resume.
    expect(calls[0]?.options?.resume).toBe("original-resume-target");
    expect(calls[1]?.options?.resume).toBe("original-resume-target");
    expect(session.sessionId).toBe("second-attempt-session");
  });

  test("first turn fails via an `isError` RESULT (not a throw) → second stream() still passes the original `resume` options; the error result's session_id is never latched", async () => {
    const failedSessionId = "failed-session-id";
    let callIndex = 0;
    const calls: Array<{ prompt: string; options: Options | undefined }> = [];
    const queryFn: QueryFn = ({ prompt, options }) => {
      calls.push({ prompt, options });
      const thisCall = callIndex++;
      return (async function* () {
        if (thisCall === 0) {
          yield initMessage({ sessionId: failedSessionId });
          yield errorResultMessage(failedSessionId);
          return;
        }
        const sessionId = "second-attempt-session";
        yield initMessage({ sessionId });
        yield resultMessage(sessionId);
      })();
    };
    const port = createClaudeAgentSdkSessionPort({}, { query: queryFn });
    const session = port.createSession({ resume: { sessionId: "original-resume-target" } });

    const first = await runToCompletion(session, "first turn");
    expect(first.isError).toBe(true);
    expect(first.sessionId).toBe(failedSessionId); // reported to the caller...
    expect(session.sessionId).toBeUndefined(); // ...but NOT latched as this handle's own session

    await runToCompletion(session, "retry");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.options?.resume).toBe("original-resume-target");
    // The retry is still treated as a first turn: it bootstraps from the
    // caller's original resume target, not from the failed result's id.
    expect(calls[1]?.options?.resume).toBe("original-resume-target");
    expect(session.sessionId).toBe("second-attempt-session");
  });

  test("success → the second call resumes this handle's own (successful) session id", async () => {
    const fixedSessionId = randomUUID();
    const { queryFn, calls } = makeRecordingQueryFn({ sessionIdForCall: () => fixedSessionId });
    const port = createClaudeAgentSdkSessionPort({}, { query: queryFn });
    const session = port.createSession();

    const first = await runToCompletion(session, "first turn");
    expect(first.isError).toBe(false);
    expect(session.sessionId).toBe(fixedSessionId);

    await runToCompletion(session, "second turn");
    expect(calls[1]?.options?.resume).toBe(fixedSessionId);
  });

  test("`persistSession: false` guard still fires on a genuine (successful) second turn, keyed off ownSessionId rather than a turn count", async () => {
    const { queryFn, calls } = makeRecordingQueryFn({});
    const port = createClaudeAgentSdkSessionPort({}, { query: queryFn });
    const session = port.createSession({ persistSession: false });

    await runToCompletion(session, "first turn");
    expect(session.sessionId).toBeDefined();
    expect(calls).toHaveLength(1);

    await expectRejection(runToCompletion(session, "second turn"), AgenticSessionError);
    expect(calls).toHaveLength(1);
  });
});

describe("createClaudeAgentSdkSessionPort — persistSession: false cannot be resumed", () => {
  test("a second turn on a handle created with persistSession: false throws AgenticSessionError WITHOUT calling query() again — the contradiction this port now refuses to reach the subprocess for", async () => {
    const { queryFn, calls } = makeRecordingQueryFn({});
    const port = createClaudeAgentSdkSessionPort({}, { query: queryFn });
    const session = port.createSession({ persistSession: false });

    await runToCompletion(session, "first turn");
    expect(calls).toHaveLength(1);

    await expectRejection(runToCompletion(session, "second turn"), AgenticSessionError);
    // The guard fires before `queryFn` is invoked a second time — no
    // subprocess spawned for a call we already know cannot succeed.
    expect(calls).toHaveLength(1);
  });

  test("a second turn on a handle created without persistSession: false (the default) resumes normally", async () => {
    const fixedSessionId = randomUUID();
    const { queryFn, calls } = makeRecordingQueryFn({ sessionIdForCall: () => fixedSessionId });
    const port = createClaudeAgentSdkSessionPort({}, { query: queryFn });
    const session = port.createSession();

    await runToCompletion(session, "first turn");
    await runToCompletion(session, "second turn");

    expect(calls).toHaveLength(2);
    expect(calls[1]?.options?.resume).toBe(fixedSessionId);
  });
});

describe("createClaudeAgentSdkSessionPort — close()", () => {
  test("delegates to the SDK's deleteSession with this session's own id", async () => {
    const fixedSessionId = randomUUID();
    const { queryFn } = makeRecordingQueryFn({ sessionIdForCall: () => fixedSessionId });
    const deleteCalls: string[] = [];
    const port = createClaudeAgentSdkSessionPort(
      {},
      {
        query: queryFn,
        // biome-ignore lint/suspicious/noExplicitAny: test double, only the sessionId argument matters
        deleteSession: (async (sessionId: string) => {
          deleteCalls.push(sessionId);
        }) as any,
      },
    );
    const session = port.createSession();
    await runToCompletion(session, "hi");

    await session.close?.();
    expect(deleteCalls).toEqual([fixedSessionId]);
  });

  test("is a no-op when no turn has completed yet (no sessionId to delete)", async () => {
    const { queryFn } = makeRecordingQueryFn({});
    const deleteCalls: string[] = [];
    const port = createClaudeAgentSdkSessionPort(
      {},
      {
        query: queryFn,
        // biome-ignore lint/suspicious/noExplicitAny: test double, only call-count matters
        deleteSession: (async (sessionId: string) => {
          deleteCalls.push(sessionId);
        }) as any,
      },
    );
    const session = port.createSession();

    await session.close?.();
    expect(deleteCalls).toEqual([]);
  });

  test("after an errored (but persisted) first turn, close() deletes the failed transcript even though it was never latched as this handle's own session (T1.1)", async () => {
    const failedSessionId = "failed-session-id";
    let callIndex = 0;
    const queryFn: QueryFn = () => {
      const thisCall = callIndex++;
      return (async function* () {
        yield initMessage({ sessionId: failedSessionId });
        if (thisCall === 0) {
          yield errorResultMessage(failedSessionId);
        } else {
          yield resultMessage(failedSessionId);
        }
      })();
    };
    const deleteCalls: string[] = [];
    const port = createClaudeAgentSdkSessionPort(
      {},
      {
        query: queryFn,
        // biome-ignore lint/suspicious/noExplicitAny: test double, only the sessionId argument matters
        deleteSession: (async (sessionId: string) => {
          deleteCalls.push(sessionId);
        }) as any,
      },
    );
    const session = port.createSession();

    const first = await runToCompletion(session, "first turn");
    expect(first.isError).toBe(true);
    expect(session.sessionId).toBeUndefined(); // not latched — nothing for `close()` to find via `sessionId` alone

    await session.close?.();
    // ...yet the transcript the errored turn wrote is still deleted: the
    // failed result's session_id was tracked separately for exactly this.
    expect(deleteCalls).toEqual([failedSessionId]);
  });

  test("F3 review fix: a resumed first turn that errors does NOT track the resume target for deletion — close() only deletes the operator's real transcript if it independently belongs there", async () => {
    const resumeTarget = "operators-preexisting-transcript";
    let callIndex = 0;
    const queryFn: QueryFn = () => {
      const thisCall = callIndex++;
      return (async function* () {
        // The CLI's error result echoes back the SAME id it was asked to
        // resume — no new session was ever actually created.
        yield initMessage({ sessionId: resumeTarget });
        if (thisCall === 0) {
          yield errorResultMessage(resumeTarget);
        } else {
          yield resultMessage(resumeTarget);
        }
      })();
    };
    const deleteCalls: string[] = [];
    const port = createClaudeAgentSdkSessionPort(
      {},
      {
        query: queryFn,
        // biome-ignore lint/suspicious/noExplicitAny: test double, only the sessionId argument matters
        deleteSession: (async (sessionId: string) => {
          deleteCalls.push(sessionId);
        }) as any,
      },
    );
    const session = port.createSession({ resume: { sessionId: resumeTarget } });

    const first = await runToCompletion(session, "first turn");
    expect(first.isError).toBe(true);
    expect(first.sessionId).toBe(resumeTarget); // still reported to the caller...

    await session.close?.();
    // ...but NOT deleted: it's the operator's pre-existing transcript, not
    // one this handle orphaned. Before the fix, `close()` would have
    // deleted the operator's real history here.
    expect(deleteCalls).toEqual([]);

    // A genuinely NEW id from a later failed turn is still tracked and
    // deleted normally — the exclusion is narrow, not a blanket "never
    // delete after a resumed handle" rule.
    await runToCompletion(session, "second turn");
    expect(session.sessionId).toBe(resumeTarget);
  });

  test("F3 review fix: close() is idempotent — a second call does not re-issue deleteSession for ids already gone", async () => {
    const fixedSessionId = randomUUID();
    const { queryFn } = makeRecordingQueryFn({ sessionIdForCall: () => fixedSessionId });
    const deleteCalls: string[] = [];
    const port = createClaudeAgentSdkSessionPort(
      {},
      {
        query: queryFn,
        // biome-ignore lint/suspicious/noExplicitAny: test double, only the sessionId argument matters
        deleteSession: (async (sessionId: string) => {
          deleteCalls.push(sessionId);
        }) as any,
      },
    );
    const session = port.createSession();
    await runToCompletion(session, "hi");

    await session.close?.();
    await session.close?.();

    expect(deleteCalls).toEqual([fixedSessionId]); // deleted exactly once, not twice
  });

  test("is a no-op for a session created with persistSession: false — nothing was ever written to delete", async () => {
    const { queryFn } = makeRecordingQueryFn({});
    const deleteCalls: string[] = [];
    const port = createClaudeAgentSdkSessionPort(
      {},
      {
        query: queryFn,
        // biome-ignore lint/suspicious/noExplicitAny: test double, only call-count matters
        deleteSession: (async (sessionId: string) => {
          deleteCalls.push(sessionId);
        }) as any,
      },
    );
    const session = port.createSession({ persistSession: false });
    await runToCompletion(session, "hi");

    await session.close?.();
    expect(deleteCalls).toEqual([]);
  });
});

describe("createClaudeAgentSdkSessionPort — guardrail", () => {
  test("throws SubscriptionAuthError when apiKeySource is not 'none', before yielding any content", async () => {
    const { queryFn } = makeRecordingQueryFn({ apiKeySource: "user" });
    const port = createClaudeAgentSdkSessionPort({}, { query: queryFn });
    const session = port.createSession();

    const events: string[] = [];
    let thrown: unknown;
    try {
      for await (const event of session.stream("hello")) {
        events.push(event.type);
      }
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SubscriptionAuthError);
    expect((thrown as SubscriptionAuthError).apiKeySource).toBe("user");
    expect(events).toEqual([]);
  });

  test("via runToCompletion (buffered helper), the same guardrail rejection propagates", async () => {
    const { queryFn } = makeRecordingQueryFn({ apiKeySource: "org" });
    const port = createClaudeAgentSdkSessionPort({}, { query: queryFn });
    const session = port.createSession();
    await expectRejection(runToCompletion(session, "hello"), SubscriptionAuthError);
  });

  test("passes cleanly on apiKeySource: 'none' and reports subagentsEnabled from the init message's tool list", async () => {
    const { queryFn } = makeRecordingQueryFn({ apiKeySource: "none" });
    const port = createClaudeAgentSdkSessionPort({}, { query: queryFn });
    const session = port.createSession();
    const result = await runToCompletion(session, "hello");
    expect(result.subagentsEnabled).toBe(true); // fixture's tools list includes "Agent"
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 34,
      cacheReadTokens: 5,
      cacheWriteTokens: 7,
    });
  });
});
