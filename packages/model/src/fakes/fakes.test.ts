import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { AgenticSessionError, StructuredGenerationError } from "../errors.ts";
import { runToCompletion } from "../ports/agentic-session.ts";
import { expectRejection } from "../test-helpers.ts";
import { FakeAgenticSessionPort } from "./fake-agentic-session.ts";
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
  });
});
