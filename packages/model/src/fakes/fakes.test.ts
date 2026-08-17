import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { AgenticSessionError, StructuredGenerationError } from "../errors.ts";
import type { AgenticStreamEvent } from "../ports/agentic-session.ts";
import { runToCompletion } from "../ports/agentic-session.ts";
import { turnFailureFromThrown } from "../ports/retry-policy.ts";
import { expectRejection } from "../test-helpers.ts";
import {
  FakeAgenticSession,
  FakeAgenticSessionPort,
  failNTimesThenSucceed,
  noConversationFoundError,
} from "./fake-agentic-session.ts";
import { FakeStructuredGenerationPort } from "./fake-structured-generation.ts";

describe("FakeStructuredGenerationPort", () => {
  const schema = z.object({ title: z.string(), tags: z.array(z.string()) });

  test("returns fixtures in order, validated against the request schema", async () => {
    const port = new FakeStructuredGenerationPort([
      { title: "Component Density", tags: ["ui"] },
      { title: "Keyboard Navigation", tags: ["ui", "a11y"] },
    ]);

    const first = await port.generate({ schema, prompt: "summarize chapter 1" });
    const second = await port.generate({ schema, prompt: "summarize chapter 2" });

    expect(first.object).toEqual({ title: "Component Density", tags: ["ui"] });
    expect(second.object).toEqual({ title: "Keyboard Navigation", tags: ["ui", "a11y"] });
    expect(port.calls).toHaveLength(2);
    expect(port.calls[0]?.prompt).toBe("summarize chapter 1");
  });

  test("zero usage — a fake never has real token cost to report", async () => {
    const port = new FakeStructuredGenerationPort([{ title: "x", tags: [] }]);
    const result = await port.generate({ schema, prompt: "p" });
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test("a fixture that fails the request's schema raises StructuredGenerationError, not a silent bad object", async () => {
    const port = new FakeStructuredGenerationPort([{ title: "missing tags" }]);
    await expectRejection(port.generate({ schema, prompt: "p" }), StructuredGenerationError);
  });

  test("an exhausted queue raises StructuredGenerationError rather than returning undefined", async () => {
    const port = new FakeStructuredGenerationPort([]);
    await expectRejection(port.generate({ schema, prompt: "p" }), StructuredGenerationError);
  });

  test("a responder function computes the fixture from the request", async () => {
    const port = new FakeStructuredGenerationPort((request) => ({
      title: request.prompt.toUpperCase(),
      tags: [],
    }));
    const result = await port.generate({ schema, prompt: "hello" });
    expect(result.object.title).toBe("HELLO");
  });
});

describe("FakeAgenticSessionPort", () => {
  test("sessionId is undefined before the first turn and stable across later turns", async () => {
    const port = new FakeAgenticSessionPort();
    const session = port.createSession();
    expect(session.sessionId).toBeUndefined();

    const first = await runToCompletion(session, "hello");
    expect(session.sessionId).toBeDefined();
    const idAfterFirst = session.sessionId as string;
    expect(first.sessionId).toBe(idAfterFirst);

    const second = await runToCompletion(session, "again");
    expect(session.sessionId).toBe(idAfterFirst);
    expect(second.sessionId).toBe(idAfterFirst);
  });

  test("two sessions from the same port get distinct session ids", () => {
    const port = new FakeAgenticSessionPort();
    const a = port.createSession();
    const b = port.createSession();
    expect(port.sessions).toHaveLength(2);
    expect(a).not.toBe(b);
  });

  test("deleteStoredSession records the id, with no live session handle required (T2.4)", async () => {
    const port = new FakeAgenticSessionPort();
    // No `createSession()` call at all — the cold-session shape this method
    // exists for: an id read back from stored metadata, not from a handle.
    await port.deleteStoredSession("cold-session-id");
    expect(port.deletedStoredSessionIds).toEqual(["cold-session-id"]);
  });

  test("default responder echoes the prompt", async () => {
    const port = new FakeAgenticSessionPort();
    const session = port.createSession();
    const result = await runToCompletion(session, "what is a volume?");
    expect(result.text).toBe("echo: what is a volume?");
    expect(result.isError).toBe(false);
  });

  test("a scripted responder can drive tool-use/tool-result events, and usage accumulates across turns", async () => {
    const port = new FakeAgenticSessionPort((prompt, { turnIndex }) => ({
      text: `turn ${turnIndex}`,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      events:
        turnIndex === 0
          ? [
              { type: "tool-use", toolName: "search", input: { query: prompt } },
              { type: "tool-result", toolName: "search", output: "found it", isError: false },
            ]
          : [],
    }));
    const session = port.createSession();

    const events: string[] = [];
    for await (const event of session.stream("find Linear's density system")) {
      events.push(event.type);
    }
    expect(events).toEqual(["tool-use", "tool-result", "done"]);
    expect(session.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    await runToCompletion(session, "second turn");
    expect(session.usage).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test("prompts sent through a session are recorded in order", async () => {
    const port = new FakeAgenticSessionPort();
    const session = port.createSession();
    await runToCompletion(session, "first");
    await runToCompletion(session, "second");
    const fake = port.sessions[0];
    expect(fake?.prompts).toEqual(["first", "second"]);
  });

  describe("persistSession: false cannot be resumed (the Wave 3 bug, modeled)", () => {
    test("a first turn on a non-persisted session succeeds", async () => {
      const port = new FakeAgenticSessionPort();
      const session = port.createSession({ persistSession: false });
      const result = await runToCompletion(session, "one");
      expect(result.isError).toBe(false);
      expect(result.text).toBe("echo: one");
    });

    test("a second turn on the SAME non-persisted session handle throws, exactly like the real adapter/SDK", async () => {
      const port = new FakeAgenticSessionPort();
      const session = port.createSession({ persistSession: false });
      await runToCompletion(session, "one");

      await expectRejection(runToCompletion(session, "two"), AgenticSessionError);
    });

    test("persistSession omitted (SDK default true) or explicitly true: a second turn on the same handle succeeds — this is the multi-turn path Shadow's chat and research agent both depend on (D6)", async () => {
      const port = new FakeAgenticSessionPort();
      const defaultSession = port.createSession();
      await runToCompletion(defaultSession, "one");
      const second = await runToCompletion(defaultSession, "two");
      expect(second.isError).toBe(false);

      const explicitSession = port.createSession({ persistSession: true });
      await runToCompletion(explicitSession, "one");
      const explicitSecond = await runToCompletion(explicitSession, "two");
      expect(explicitSecond.isError).toBe(false);
    });
  });

  describe("first turn derived from a successful session id, not a turn count (T1.1)", () => {
    test("a turn that fails via a THROWN responder is not latched — the next stream() call is still treated as a first turn", async () => {
      let calls = 0;
      const port = new FakeAgenticSessionPort((prompt) => {
        calls += 1;
        if (calls === 1) {
          throw new Error("simulated transport failure");
        }
        return { text: `echo: ${prompt}` };
      });
      const session = port.createSession();

      await expectRejection(runToCompletion(session, "first turn"), Error);
      expect(session.sessionId).toBeUndefined();

      const second = await runToCompletion(session, "retry");
      expect(second.isError).toBe(false);
      expect(session.sessionId).toBeDefined();
    });

    test("a turn scripted with isError: true is not latched into sessionId, but is reported on the result and tracked as failed", async () => {
      const port = new FakeAgenticSessionPort((prompt, { turnIndex }) => ({
        text: turnIndex === 0 ? "boom" : `echo: ${prompt}`,
        isError: turnIndex === 0,
      }));
      const session = port.createSession();

      const first = await runToCompletion(session, "first turn");
      expect(first.isError).toBe(true);
      expect(first.sessionId).toBeDefined(); // still reported to the caller...
      expect(session.sessionId).toBeUndefined(); // ...but not latched as this handle's own session
      const fake = port.sessions[0];
      expect(fake?.failedSessionIds).toEqual([first.sessionId]);

      const second = await runToCompletion(session, "retry");
      expect(second.isError).toBe(false);
      expect(session.sessionId).toBeDefined();
    });

    test("persistSession: false guard is keyed off ownSessionId, not a turn count: a failed first turn does not trip it, but a genuine successful second turn still does", async () => {
      const port = new FakeAgenticSessionPort((_prompt, { turnIndex }) => ({
        isError: turnIndex === 0,
      }));
      const session = port.createSession({ persistSession: false });

      const first = await runToCompletion(session, "one");
      expect(first.isError).toBe(true);
      expect(session.sessionId).toBeUndefined();

      // Retry after the failure is still a "first turn" as far as the guard
      // is concerned — it must not throw here.
      const second = await runToCompletion(session, "two");
      expect(second.isError).toBe(false);
      expect(session.sessionId).toBeDefined();

      // A further turn is now a genuine second turn on a non-persisted
      // session — the guard fires.
      await expectRejection(runToCompletion(session, "three"), AgenticSessionError);
    });
  });

  describe("close()", () => {
    test("marks the session closed, inspectable via isClosed", async () => {
      const port = new FakeAgenticSessionPort();
      const session = port.createSession();
      await runToCompletion(session, "one");
      expect(port.sessions[0]?.isClosed).toBe(false);

      await session.close?.();
      expect(port.sessions[0]?.isClosed).toBe(true);
    });

    test("a turn sent after close() throws", async () => {
      const port = new FakeAgenticSessionPort();
      const session = port.createSession();
      await runToCompletion(session, "one");
      await session.close?.();

      await expectRejection(runToCompletion(session, "two"), AgenticSessionError);
    });

    test("after an errored first turn, close() 'deletes' the failed transcript even though it was never latched into sessionId (T1.1)", async () => {
      const port = new FakeAgenticSessionPort((_prompt, { turnIndex }) => ({
        isError: turnIndex === 0,
      }));
      const session = port.createSession();

      const first = await runToCompletion(session, "one");
      expect(session.sessionId).toBeUndefined();

      await session.close?.();
      const fake = port.sessions[0];
      expect(fake?.deletedSessionIds).toEqual([first.sessionId]);
    });

    test("close() on persistSession: false records nothing — nothing was ever persisted, successful or failed", async () => {
      const port = new FakeAgenticSessionPort();
      const session = port.createSession({ persistSession: false });
      await runToCompletion(session, "one");

      await session.close?.();
      const fake = port.sessions[0];
      expect(fake?.deletedSessionIds).toEqual([]);
    });

    test("F3 review fix: a resumed first turn that errors does NOT track the resume target for deletion", async () => {
      // The fake's own assigned session id is predictable (sequential,
      // `fake-session-N`) — set the resume target to match it, modeling the
      // real CLI's behavior of echoing back the id it was asked to resume
      // on a first-turn error (see `ClaudeAgentSdkSession`'s mirrored fix).
      const port = new FakeAgenticSessionPort(() => ({ isError: true, stopReason: "boom" }));
      const session = port.createSession({
        resume: { sessionId: "fake-session-1" },
      }) as FakeAgenticSession;

      const first = await runToCompletion(session, "first turn");
      expect(first.isError).toBe(true);
      expect(first.sessionId).toBe("fake-session-1");
      expect(session.failedSessionIds).toEqual([]); // excluded, not tracked

      await session.close?.();
      expect(session.deletedSessionIds).toEqual([]); // nothing deleted either
    });

    test("F3 review fix: close() is idempotent — a second call does not double-record already-deleted ids", async () => {
      const port = new FakeAgenticSessionPort((_prompt, { turnIndex }) => ({
        isError: turnIndex === 0,
      }));
      const session = port.createSession();

      await runToCompletion(session, "one"); // fails, tracked in failedSessionIds
      await runToCompletion(session, "two"); // succeeds, latched as ownSessionId

      await session.close?.();
      const fake = port.sessions[0];
      const afterFirstClose = [...(fake?.deletedSessionIds ?? [])];
      expect(afterFirstClose.length).toBeGreaterThan(0);

      await session.close?.();
      expect(fake?.deletedSessionIds).toEqual(afterFirstClose); // unchanged — no duplicates
    });
  });

  describe("FakeAgenticTurnScript.throws (T1.2: scripting the thrown-error channel)", () => {
    test("a script with `throws` set throws that value instead of yielding a result, and records the prompt anyway", async () => {
      const boom = new AgenticSessionError("simulated transient failure");
      const port = new FakeAgenticSessionPort(() => ({ throws: boom }));
      const session = port.createSession();

      const rejection = await expectRejection(
        runToCompletion(session, "hello"),
        AgenticSessionError,
      );
      expect(rejection).toBe(boom);
      expect(port.sessions[0]?.prompts).toEqual(["hello"]);
      // No session id was ever produced — a thrown failure gives the real
      // adapter nothing to latch or track either (see the fake's own
      // `stream()` comment on this branch).
      expect(session.sessionId).toBeUndefined();
      expect(port.sessions[0]?.failedSessionIds).toEqual([]);
    });

    test("the `done`-result-only fields are ignored when `throws` is set — no result-shaped event before the throw", async () => {
      const port = new FakeAgenticSessionPort(() => ({
        throws: new AgenticSessionError("boom"),
        text: "should never be seen",
      }));
      const session = port.createSession();

      const events: string[] = [];
      await expectRejection(
        (async () => {
          for await (const event of session.stream("hello")) {
            events.push(event.type);
          }
        })(),
        AgenticSessionError,
      );
      expect(events).toEqual([]);
    });

    test("F6 review fix: `events` coexists with `throws` — scripted events are yielded, THEN the turn throws", async () => {
      const boom = new AgenticSessionError("mid-turn transport failure");
      const port = new FakeAgenticSessionPort(() => ({
        events: [
          { type: "text-delta", text: "partial " },
          { type: "text-delta", text: "output" },
        ],
        throws: boom,
      }));
      const session = port.createSession();

      const events: AgenticStreamEvent[] = [];
      const rejection = await expectRejection(
        (async () => {
          for await (const event of session.stream("hello")) {
            events.push(event);
          }
        })(),
        AgenticSessionError,
      );

      expect(rejection).toBe(boom);
      expect(events).toEqual([
        { type: "text-delta", text: "partial " },
        { type: "text-delta", text: "output" },
      ]);
      // No `done` event was ever produced — the turn failed mid-stream, not
      // after completing a result.
      expect(events.some((e) => e.type === "done")).toBe(false);
    });
  });

  describe("failNTimesThenSucceed (T1.2: scripting fail-N-then-succeed)", () => {
    test("throws the given error on the first N calls, then returns the success script on every call after", async () => {
      const boom = new AgenticSessionError("Overloaded (please retry)");
      const port = new FakeAgenticSessionPort(
        failNTimesThenSucceed(2, boom, { text: "recovered" }),
      );
      const session = port.createSession();

      await expectRejection(runToCompletion(session, "one"), AgenticSessionError);
      await expectRejection(runToCompletion(session, "two"), AgenticSessionError);
      const third = await runToCompletion(session, "three");
      expect(third.isError).toBe(false);
      expect(third.text).toBe("recovered");

      // And stays succeeded — the counter doesn't reset.
      const fourth = await runToCompletion(session, "four");
      expect(fourth.text).toBe("recovered");
    });

    test("failCount: 0 succeeds immediately — the edge case of 'no failures scripted'", async () => {
      const port = new FakeAgenticSessionPort(
        failNTimesThenSucceed(0, new Error("never thrown"), { text: "ok" }),
      );
      const session = port.createSession();
      const result = await runToCompletion(session, "hello");
      expect(result.text).toBe("ok");
    });

    test("the thrown value round-trips through turnFailureFromThrown exactly as the real classification path would see it", async () => {
      const boom = new AgenticSessionError("API Error: 529 Overloaded");
      const port = new FakeAgenticSessionPort(failNTimesThenSucceed(1, boom));
      const session = port.createSession();

      try {
        await runToCompletion(session, "one");
        expect.unreachable("expected the first call to throw");
      } catch (error) {
        const failure = turnFailureFromThrown(error);
        expect(failure).toEqual({
          kind: "thrown",
          message: "API Error: 529 Overloaded",
          error: boom,
        });
      }
    });
  });

  describe("noConversationFoundError (T1.2: the faithful no-conversation-found shape)", () => {
    test("produces an AgenticSessionError whose message matches the real CLI's verified text", () => {
      const error = noConversationFoundError("session-xyz");
      expect(error).toBeInstanceOf(AgenticSessionError);
      expect(error.message).toBe("No conversation found with session ID: session-xyz");
    });

    test("scripted as a `throws` entry, it surfaces to a caller exactly like the real adapter's resume-of-a-gone-session failure", async () => {
      const port = new FakeAgenticSessionPort(() => ({
        throws: noConversationFoundError("stale-session-id"),
      }));
      const session = port.createSession();

      const rejection = await expectRejection(
        runToCompletion(session, "resume me"),
        AgenticSessionError,
      );
      expect(rejection.message).toContain(
        "No conversation found with session ID: stale-session-id",
      );
    });
  });
});
