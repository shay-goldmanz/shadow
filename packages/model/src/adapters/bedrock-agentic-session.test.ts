import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { AgenticSessionError } from "../errors.ts";
import type {
  AgenticSession,
  AgenticSessionOptions,
  AgenticStreamEvent,
} from "../ports/agentic-session.ts";
import { expectRejection, expectSyncThrow } from "../test-helpers.ts";
import { createToolServer, defineTool } from "../tools.ts";
import {
  type BedrockAgenticSessionPortDeps,
  createBedrockAgenticSessionPort,
} from "./bedrock-agentic-session.ts";

/**
 * A fake `readSkillFile` backed by an in-memory map, keyed by the exact path
 * `resolveSkillPath` builds (`<cwd>/.claude/skills/<name>/SKILL.md`) — never
 * touches the real filesystem, matching this file's "every test injects a
 * fake" convention above.
 */
function fakeSkillFs(files: Record<string, string>): NonNullable<
  BedrockAgenticSessionPortDeps["readSkillFile"]
> {
  return (path: string) => {
    const content = files[path];
    if (content === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
    return content;
  };
}

function skillPath(cwd: string, name: string): string {
  return `${cwd}/.claude/skills/${name}/SKILL.md`;
}

/**
 * Offline coverage for the Bedrock agentic-session adapter. Every test
 * injects a fake `streamText` (never the real Vercel AI SDK/Bedrock call) —
 * the fake simulates exactly what `streamText`'s own multi-step tool loop
 * would emit on `fullStream` for a given scenario, and where a test wants to
 * prove the real tool-execution wiring works, it calls the captured
 * `tools[name].execute(...)` itself (the same AI-SDK `tool()` object
 * `buildTools` constructs from a `ToolDefinition`), rather than faking that
 * result too.
 */

interface CapturedCall {
  readonly model: unknown;
  readonly system: string | undefined;
  readonly messages: unknown[];
  // biome-ignore lint/suspicious/noExplicitAny: stands in for streamText's real ToolSet-generic `tools` param — this file only needs `.execute` off of it.
  readonly tools: Record<string, any>;
  readonly stopWhen: unknown;
}

/**
 * A scripted `fullStream` part, or a thunk that produces one asynchronously
 * — needed wherever a test wants a part's field (typically a `tool-result`
 * part's `output`) built by actually `await`ing the captured fake tool's
 * `execute(...)`, exactly as the real Vercel AI SDK awaits a tool's
 * execution before emitting that part (a part never carries an unresolved
 * `Promise` as one of its fields).
 */
type ScriptedPart = Record<string, unknown> | (() => Promise<Record<string, unknown>>);

interface ScriptedTurn {
  readonly parts?: readonly ScriptedPart[];
  readonly text?: string;
  readonly usage?: Record<string, unknown>;
  readonly finishReason?: string;
  readonly responseMessages?: readonly unknown[];
}

const ZERO_LANGUAGE_MODEL_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
};

function makeStreamTextFake(script: (call: CapturedCall, index: number) => ScriptedTurn) {
  const calls: CapturedCall[] = [];
  const fn = (params: CapturedCall) => {
    const index = calls.length;
    // Snapshot `messages` at call time — the adapter passes its live,
    // mutable history array by reference, and later turns push this turn's
    // response messages onto that *same* array, so capturing the reference
    // itself would silently pick up future mutations.
    calls.push({ ...params, messages: [...params.messages] });
    const turn = script(params, index);
    return {
      fullStream: (async function* () {
        for (const part of turn.parts ?? []) {
          yield typeof part === "function" ? await part() : part;
        }
      })(),
      responseMessages: Promise.resolve(turn.responseMessages ?? []),
      text: Promise.resolve(turn.text ?? ""),
      usage: Promise.resolve(turn.usage ?? ZERO_LANGUAGE_MODEL_USAGE),
      finishReason: Promise.resolve(turn.finishReason ?? "stop"),
    };
  };
  return {
    fn: fn as unknown as NonNullable<BedrockAgenticSessionPortDeps["streamText"]>,
    calls,
  };
}

function makeFakeCreateProvider(): NonNullable<BedrockAgenticSessionPortDeps["createProvider"]> {
  return ((_settings: unknown) => ({
    languageModel: (modelId: string) => ({ modelId }),
    // biome-ignore lint/suspicious/noExplicitAny: fake provider only needs to satisfy `.languageModel(...)` — the model id is never dereferenced by anything except our own fake `streamText`.
  })) as any;
}

function makePort(
  streamTextFn: ReturnType<typeof makeStreamTextFake>["fn"],
  extraDeps: Partial<BedrockAgenticSessionPortDeps> = {},
) {
  return createBedrockAgenticSessionPort(
    {},
    { streamText: streamTextFn, createProvider: makeFakeCreateProvider(), ...extraDeps },
  );
}

async function drain(session: AgenticSession, prompt: string): Promise<AgenticStreamEvent[]> {
  const events: AgenticStreamEvent[] = [];
  for await (const event of session.stream(prompt)) events.push(event);
  return events;
}

function lastEvent(events: readonly AgenticStreamEvent[]): AgenticStreamEvent {
  const last = events[events.length - 1];
  if (!last) throw new Error("expected at least one event");
  return last;
}

describe("createBedrockAgenticSessionPort — event ordering", () => {
  test("a text-only turn yields text-delta* then done, with done last", async () => {
    const { fn } = makeStreamTextFake(() => ({
      parts: [
        { type: "text-delta", id: "1", text: "Hello" },
        { type: "text-delta", id: "1", text: " world" },
        { type: "finish", finishReason: "stop" },
      ],
      text: "Hello world",
    }));
    const port = makePort(fn);
    const session = port.createSession({});

    const events = await drain(session, "hi");

    expect(events.map((e) => e.type)).toEqual(["text-delta", "text-delta", "done"]);
    const done = lastEvent(events);
    if (done.type !== "done") throw new Error("expected done");
    expect(done.result.text).toBe("Hello world");
    expect(done.result.isError).toBe(false);
    expect(done.result.subagentsEnabled).toBe(false);
  });
});

describe("createBedrockAgenticSessionPort — tool loop", () => {
  function researchToolServer() {
    return createToolServer("research", [
      defineTool({
        name: "search",
        description: "search for things",
        inputSchema: { query: z.string() },
        handler: async ({ query }) => ({ content: `results for ${query}` }),
      }),
      defineTool({
        name: "fetch",
        description: "fetch a page",
        inputSchema: { url: z.string() },
        handler: async ({ url }) => ({ content: `page at ${url}` }),
      }),
    ]);
  }

  test("tool-use -> tool-result -> continues -> done, across multiple rounds in one turn", async () => {
    const toolServer = researchToolServer();
    const { fn, calls } = makeStreamTextFake((call) => ({
      parts: [
        { type: "tool-call", toolCallId: "1", toolName: "search", input: { query: "a" } },
        async () => ({
          type: "tool-result",
          toolCallId: "1",
          toolName: "search",
          input: { query: "a" },
          // biome-ignore lint/suspicious/noExplicitAny: test double dereferencing the captured fake `tools` param
          output: await (call.tools as any).search.execute({ query: "a" }, {}),
        }),
        { type: "tool-call", toolCallId: "2", toolName: "search", input: { query: "b" } },
        async () => ({
          type: "tool-result",
          toolCallId: "2",
          toolName: "search",
          input: { query: "b" },
          // biome-ignore lint/suspicious/noExplicitAny: test double dereferencing the captured fake `tools` param
          output: await (call.tools as any).search.execute({ query: "b" }, {}),
        }),
        { type: "text-delta", id: "1", text: "done" },
        { type: "finish", finishReason: "stop" },
      ],
      text: "done",
    }));
    const port = makePort(fn);
    const session = port.createSession({
      toolServers: [toolServer],
      allowedTools: ["mcp__research__search", "mcp__research__fetch"],
    });

    const events = await drain(session, "go");

    expect(events.map((e) => e.type)).toEqual([
      "tool-use",
      "tool-result",
      "tool-use",
      "tool-result",
      "text-delta",
      "done",
    ]);
    const toolUseEvents = events.filter((e) => e.type === "tool-use");
    expect(toolUseEvents.every((e) => e.type === "tool-use" && e.toolName === "search")).toBe(true);
    expect(calls[0]?.tools).toHaveProperty("search");
    expect(calls[0]?.tools).toHaveProperty("fetch");
  });

  test("a normal { isError: true } tool result surfaces on the event but does not end the turn", async () => {
    const toolServer = createToolServer("research", [
      defineTool({
        name: "search",
        description: "search",
        inputSchema: { query: z.string() },
        handler: async () => ({ content: "not found", isError: true }),
      }),
    ]);
    const { fn } = makeStreamTextFake((call) => ({
      parts: [
        { type: "tool-call", toolCallId: "1", toolName: "search", input: { query: "a" } },
        async () => ({
          type: "tool-result",
          toolCallId: "1",
          toolName: "search",
          input: { query: "a" },
          // biome-ignore lint/suspicious/noExplicitAny: test double
          output: await (call.tools as any).search.execute({ query: "a" }, {}),
        }),
        { type: "text-delta", id: "1", text: "sorry, nothing found" },
        { type: "finish", finishReason: "stop" },
      ],
      text: "sorry, nothing found",
    }));
    const port = makePort(fn);
    const session = port.createSession({
      toolServers: [toolServer],
      allowedTools: ["mcp__research__search"],
    });

    const events = await drain(session, "go");
    const toolResult = events.find((e) => e.type === "tool-result");
    if (!toolResult || toolResult.type !== "tool-result") throw new Error("expected tool-result");
    // The adapter unwraps the `ToolResult` shape (`{ content, isError? }`)
    // onto the event: `output` becomes the bare content string, `isError`
    // its own field — never a nested object.
    expect(toolResult.output).toBe("not found");
    expect(toolResult.isError).toBe(true);
    const done = lastEvent(events);
    if (done.type !== "done") throw new Error("expected done");
    expect(done.result.isError).toBe(false);
  });

  test("allowedTools/disallowedTools filter the tool set handed to streamText, by bare tool name on the model side", async () => {
    const toolServer = researchToolServer();
    const { fn, calls } = makeStreamTextFake(() => ({ text: "ok" }));
    const port = makePort(fn);

    const allowOnlySearch = port.createSession({
      toolServers: [toolServer],
      allowedTools: ["mcp__research__search"],
    });
    await drain(allowOnlySearch, "go");
    expect(Object.keys(calls[0]?.tools ?? {})).toEqual(["search"]);

    const disallowFetch = port.createSession({
      toolServers: [toolServer],
      allowedTools: ["mcp__research__search", "mcp__research__fetch"],
      disallowedTools: ["mcp__research__fetch", "WebFetch", "WebSearch", "Bash"],
    });
    await drain(disallowFetch, "go");
    expect(Object.keys(calls[1]?.tools ?? {})).toEqual(["search"]);
  });
});

describe("createBedrockAgenticSessionPort — errors", () => {
  test("a mid-turn tool-error part ends the turn with isError: true, done still last", async () => {
    const { fn } = makeStreamTextFake(() => ({
      parts: [
        { type: "text-delta", id: "1", text: "working on it..." },
        {
          type: "tool-error",
          toolCallId: "1",
          toolName: "search",
          input: {},
          error: new Error("boom"),
        },
      ],
    }));
    const port = makePort(fn);
    const session = port.createSession({});

    const events = await drain(session, "go");

    expect(events.map((e) => e.type)).toEqual(["text-delta", "done"]);
    const done = lastEvent(events);
    if (done.type !== "done") throw new Error("expected done");
    expect(done.result.isError).toBe(true);
    expect(done.result.text).toContain("boom");
    expect(done.result.sessionId).toBeTruthy();
  });

  test("a stream-level error part ends the turn with isError: true", async () => {
    const { fn } = makeStreamTextFake(() => ({
      parts: [{ type: "error", error: new Error("network exploded") }],
    }));
    const port = makePort(fn);
    const session = port.createSession({});

    const events = await drain(session, "go");

    expect(events).toHaveLength(1);
    const done = lastEvent(events);
    if (done.type !== "done") throw new Error("expected done");
    expect(done.result.isError).toBe(true);
    expect(done.result.text).toContain("network exploded");
  });

  test("an errored turn's prompt is popped back out of history: the next turn's streamText call sees no trace of it", async () => {
    const { fn, calls } = makeStreamTextFake((_call, index) => {
      if (index === 1) {
        return { parts: [{ type: "error", error: new Error("throttled") }] };
      }
      return {
        text: index === 0 ? "first reply" : "third reply",
        responseMessages: [
          { role: "assistant", content: index === 0 ? "first reply" : "third reply" },
        ],
      };
    });
    const port = makePort(fn);
    const session = port.createSession({});

    await drain(session, "first prompt");

    const turn2Events = await drain(session, "second prompt (errors mid-stream)");
    const turn2Done = lastEvent(turn2Events);
    if (turn2Done.type !== "done") throw new Error("expected done");
    expect(turn2Done.result.isError).toBe(true);

    await drain(session, "third prompt");

    // Turn 1's exchange is still there, but turn 2's prompt — which never
    // got an assistant reply — is gone rather than sitting fused with turn
    // 3's prompt as one merged user message (see `stream()`'s error-path
    // `history.pop()`).
    expect(calls[2]?.messages).toEqual([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first reply" },
      { role: "user", content: "third prompt" },
    ]);
  });
});

describe("createBedrockAgenticSessionPort — multi-turn session state", () => {
  test("sessionId is undefined until turn 1, then stable across later turns", async () => {
    const { fn } = makeStreamTextFake(() => ({ text: "ok" }));
    const port = makePort(fn);
    const session = port.createSession({});

    expect(session.sessionId).toBeUndefined();
    await drain(session, "one");
    const id = session.sessionId;
    expect(id).toBeTruthy();
    await drain(session, "two");
    expect(session.sessionId).toBe(id);
  });

  test("usage accumulates across turns", async () => {
    const usageOf = (inputTokens: number, outputTokens: number) => ({
      inputTokens,
      outputTokens,
      inputTokenDetails: { noCacheTokens: inputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: outputTokens, reasoningTokens: 0 },
    });
    const { fn } = makeStreamTextFake((_call, index) => ({
      text: "ok",
      usage: index === 0 ? usageOf(10, 5) : usageOf(3, 2),
    }));
    const port = makePort(fn);
    const session = port.createSession({});

    await drain(session, "one");
    expect(session.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    await drain(session, "two");
    expect(session.usage).toEqual({
      inputTokens: 13,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test("message history grows across turns and is threaded into the next streamText call", async () => {
    const { fn, calls } = makeStreamTextFake((_call, index) => ({
      text: index === 0 ? "first reply" : "second reply",
      responseMessages: [
        { role: "assistant", content: index === 0 ? "first reply" : "second reply" },
      ],
    }));
    const port = makePort(fn);
    const session = port.createSession({});

    await drain(session, "first prompt");
    expect(calls[0]?.messages).toEqual([{ role: "user", content: "first prompt" }]);

    await drain(session, "second prompt");
    expect(calls[1]?.messages).toEqual([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first reply" },
      { role: "user", content: "second prompt" },
    ]);
  });
});

describe("createBedrockAgenticSessionPort — resume/continueMostRecent semantics", () => {
  test("a persisted session can be resumed by id in-process: new options, inherited history, same id", async () => {
    const { fn, calls } = makeStreamTextFake((_call, index) => ({
      text: index === 0 ? "first reply" : "second reply",
      responseMessages: [
        { role: "assistant", content: index === 0 ? "first reply" : "second reply" },
      ],
    }));
    const port = makePort(fn);
    const original = port.createSession({});
    await drain(original, "first prompt");
    const id = original.sessionId;
    expect(id).toBeTruthy();

    // biome-ignore lint/style/noNonNullAssertion: asserted truthy above
    const resumed = port.createSession({ resume: { sessionId: id! } });
    expect(resumed.sessionId).toBe(id);

    await drain(resumed, "second prompt");
    expect(calls[1]?.messages).toEqual([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first reply" },
      { role: "user", content: "second prompt" },
    ]);
  });

  test("resume.forkSession starts an independent session id, keeping the original resumable", async () => {
    const { fn } = makeStreamTextFake(() => ({ text: "reply", responseMessages: [] }));
    const port = makePort(fn);
    const original = port.createSession({});
    await drain(original, "first prompt");
    const id = original.sessionId;

    // biome-ignore lint/style/noNonNullAssertion: asserted truthy in the session-creation flow above
    const forked = port.createSession({ resume: { sessionId: id!, forkSession: true } });
    expect(forked.sessionId).toBeUndefined();
    await drain(forked, "forked prompt");
    expect(forked.sessionId).toBeTruthy();
    expect(forked.sessionId).not.toBe(id);

    // The original id is still resumable — forking didn't overwrite its registry entry.
    // biome-ignore lint/style/noNonNullAssertion: asserted truthy above
    const resumedOriginal = port.createSession({ resume: { sessionId: id! } });
    expect(resumedOriginal.sessionId).toBe(id);
  });

  test("resuming an unknown session id throws", () => {
    const { fn } = makeStreamTextFake(() => ({ text: "ok" }));
    const port = makePort(fn);

    expectSyncThrow(
      () => port.createSession({ resume: { sessionId: "does-not-exist" } }),
      AgenticSessionError,
    );
  });

  test("continueMostRecent with no session created yet in this process throws", () => {
    const { fn } = makeStreamTextFake(() => ({ text: "ok" }));
    const port = makePort(fn);

    expectSyncThrow(() => port.createSession({ continueMostRecent: true }), AgenticSessionError);
  });

  test("continueMostRecent resolves to the most recently used session", async () => {
    const { fn, calls } = makeStreamTextFake((_call, index) => ({
      text: "ok",
      responseMessages: [{ role: "assistant", content: `reply ${index}` }],
    }));
    const port = makePort(fn);
    const a = port.createSession({});
    await drain(a, "a prompt");

    const continued = port.createSession({ continueMostRecent: true });
    expect(continued.sessionId).toBe(a.sessionId);
    await drain(continued, "continued prompt");
    expect(calls[1]?.messages).toEqual([
      { role: "user", content: "a prompt" },
      { role: "assistant", content: "reply 0" },
      { role: "user", content: "continued prompt" },
    ]);
  });

  test("persistSession: false combined with resume throws at createSession time", () => {
    const { fn } = makeStreamTextFake(() => ({ text: "ok" }));
    const port = makePort(fn);

    expectSyncThrow(
      () => port.createSession({ persistSession: false, resume: { sessionId: "whatever" } }),
      AgenticSessionError,
    );
  });

  test("persistSession: false combined with continueMostRecent throws at createSession time", () => {
    const { fn } = makeStreamTextFake(() => ({ text: "ok" }));
    const port = makePort(fn);

    expectSyncThrow(
      () => port.createSession({ persistSession: false, continueMostRecent: true }),
      AgenticSessionError,
    );
  });

  test("persistSession: false session throws on a second stream() call, mirroring the claude-code adapter and the fake", async () => {
    const { fn } = makeStreamTextFake(() => ({ text: "ok" }));
    const port = makePort(fn);
    const session = port.createSession({ persistSession: false });

    await drain(session, "one");
    await expectRejection(drain(session, "two"), AgenticSessionError);
  });

  test("a persistSession: false session is never registered — resuming its id afterward fails", async () => {
    const { fn } = makeStreamTextFake(() => ({ text: "ok" }));
    const port = makePort(fn);
    const session = port.createSession({ persistSession: false });
    await drain(session, "one");
    const id = session.sessionId;
    expect(id).toBeTruthy();

    expectSyncThrow(
      // biome-ignore lint/style/noNonNullAssertion: asserted truthy above
      () => port.createSession({ resume: { sessionId: id! } }),
      AgenticSessionError,
    );
  });
});

describe("createBedrockAgenticSessionPort — options accepted but no-op", () => {
  test("settingSources/permissionMode/subagents don't crash and don't affect the tool set", async () => {
    const options: AgenticSessionOptions = {
      settingSources: ["project"],
      permissionMode: "acceptEdits",
      subagents: { helper: { description: "d", prompt: "p" } },
    };
    const { fn } = makeStreamTextFake(() => ({ text: "ok" }));
    const port = makePort(fn);
    const session = port.createSession(options);

    const events = await drain(session, "go");
    const done = lastEvent(events);
    if (done.type !== "done") throw new Error("expected done");
    expect(done.result.subagentsEnabled).toBe(false);
  });
});

describe("createBedrockAgenticSessionPort — skills inlining", () => {
  test("a named skill's SKILL.md is read from <cwd>/.claude/skills/<name>/SKILL.md and inlined into the system prompt", async () => {
    const cwd = "/fake/shadow-home";
    const readSkillFile = fakeSkillFs({
      [skillPath(cwd, "writing-volumes")]:
        "---\nname: writing-volumes\ndescription: how to write volumes\n---\n\n" +
        "# Writing volumes\n\nMark every claim with a footnote.",
    });
    const { fn, calls } = makeStreamTextFake(() => ({ text: "ok" }));
    const port = makePort(fn, { readSkillFile });

    const session = port.createSession({ cwd, skills: ["writing-volumes"] });
    await drain(session, "go");

    const system = calls[0]?.system ?? "";
    expect(system).toContain("Mark every claim with a footnote.");
    // Frontmatter is routing metadata for the CLI's own discovery, not useful
    // once the file is inlined unconditionally — it should not appear.
    expect(system).not.toContain("description: how to write volumes");
    expect(system).toContain("## Skill: writing-volumes");
  });

  test("multiple skills each get their own section, in order", async () => {
    const cwd = "/fake/home";
    const readSkillFile = fakeSkillFs({
      [skillPath(cwd, "alpha")]: "---\nname: alpha\n---\n\nAlpha body.",
      [skillPath(cwd, "beta")]: "---\nname: beta\n---\n\nBeta body.",
    });
    const { fn, calls } = makeStreamTextFake(() => ({ text: "ok" }));
    const port = makePort(fn, { readSkillFile });

    const session = port.createSession({ cwd, skills: ["alpha", "beta"] });
    await drain(session, "go");

    const system = calls[0]?.system ?? "";
    expect(system.indexOf("## Skill: alpha")).toBeGreaterThanOrEqual(0);
    expect(system.indexOf("## Skill: beta")).toBeGreaterThan(system.indexOf("## Skill: alpha"));
    expect(system).toContain("Alpha body.");
    expect(system).toContain("Beta body.");
  });

  test("cwd falls back to process.cwd() when omitted", async () => {
    const cwd = process.cwd();
    const readSkillFile = fakeSkillFs({
      [skillPath(cwd, "writing-volumes")]: "---\nname: writing-volumes\n---\n\nBody text.",
    });
    const { fn, calls } = makeStreamTextFake(() => ({ text: "ok" }));
    const port = makePort(fn, { readSkillFile });

    const session = port.createSession({ skills: ["writing-volumes"] });
    await drain(session, "go");

    expect(calls[0]?.system ?? "").toContain("Body text.");
  });

  test("a missing skill file throws AgenticSessionError at createSession time, naming the resolved path, before any turn runs", () => {
    const cwd = "/fake/home";
    const readSkillFile = fakeSkillFs({}); // nothing on "disk"
    const { fn, calls } = makeStreamTextFake(() => ({ text: "ok" }));
    const port = makePort(fn, { readSkillFile });

    const error = expectSyncThrow(
      () => port.createSession({ cwd, skills: ["writing-volumes"] }),
      AgenticSessionError,
    );
    expect(error.message).toContain(skillPath(cwd, "writing-volumes"));
    expect(calls).toHaveLength(0); // never reached streamText
  });

  test('skills: "all" throws AgenticSessionError — no directory-wide scan exists on this adapter', () => {
    const { fn } = makeStreamTextFake(() => ({ text: "ok" }));
    const port = makePort(fn);

    expectSyncThrow(() => port.createSession({ skills: "all" }), AgenticSessionError);
  });

  test("no skills option and an empty skills array both produce no skills section", async () => {
    const { fn, calls } = makeStreamTextFake(() => ({ text: "ok" }));
    const port = makePort(fn);

    await drain(port.createSession({}), "go");
    expect(calls[0]?.system).toBeUndefined();

    await drain(port.createSession({ skills: [] }), "go");
    expect(calls[1]?.system).toBeUndefined();
  });

  test("skills are appended after a plain-string systemPrompt", async () => {
    const cwd = "/fake/home";
    const readSkillFile = fakeSkillFs({
      [skillPath(cwd, "writing-volumes")]: "---\nname: writing-volumes\n---\n\nSkill body.",
    });
    const { fn, calls } = makeStreamTextFake(() => ({ text: "ok" }));
    const port = makePort(fn, { readSkillFile });

    const session = port.createSession({
      cwd,
      systemPrompt: "You are Shadow.",
      skills: ["writing-volumes"],
    });
    await drain(session, "go");

    const system = calls[0]?.system ?? "";
    expect(system.indexOf("You are Shadow.")).toBe(0);
    expect(system.indexOf("Skill body.")).toBeGreaterThan(system.indexOf("You are Shadow."));
  });

  test("a resumed session resolves skills again from its own (new) call's options", async () => {
    const cwd = "/fake/home";
    const readSkillFile = fakeSkillFs({
      [skillPath(cwd, "writing-volumes")]: "---\nname: writing-volumes\n---\n\nSkill body.",
    });
    const { fn, calls } = makeStreamTextFake(() => ({ text: "ok", responseMessages: [] }));
    const port = makePort(fn, { readSkillFile });

    const original = port.createSession({ cwd });
    await drain(original, "first");
    // biome-ignore lint/style/noNonNullAssertion: asserted by earlier resume tests in this file
    const id = original.sessionId!;

    const resumed = port.createSession({ cwd, resume: { sessionId: id }, skills: ["writing-volumes"] });
    await drain(resumed, "second");

    expect(calls[0]?.system).toBeUndefined();
    expect(calls[1]?.system ?? "").toContain("Skill body.");
  });
});

describe("createBedrockAgenticSessionPort — preset systemPrompt", () => {
  test("preset with no append resolves to a neutral, non-empty preamble", async () => {
    const { fn, calls } = makeStreamTextFake(() => ({ text: "ok" }));
    const port = makePort(fn);

    const session = port.createSession({ systemPrompt: { type: "preset", preset: "claude_code" } });
    await drain(session, "go");

    const system = calls[0]?.system ?? "";
    expect(system.length).toBeGreaterThan(0);
  });

  test("preset with append puts the preamble first and the caller's append text after it", async () => {
    const { fn, calls } = makeStreamTextFake(() => ({ text: "ok" }));
    const port = makePort(fn);

    const session = port.createSession({
      systemPrompt: { type: "preset", preset: "claude_code", append: "You are Shadow, specifically." },
    });
    await drain(session, "go");

    const system = calls[0]?.system ?? "";
    expect(system.indexOf("You are Shadow, specifically.")).toBeGreaterThan(0);
  });

  test("preset + append + skills: preamble, then append, then skills, in that order", async () => {
    const cwd = "/fake/home";
    const readSkillFile = fakeSkillFs({
      [skillPath(cwd, "writing-volumes")]: "---\nname: writing-volumes\n---\n\nSkill instructions.",
    });
    const { fn, calls } = makeStreamTextFake(() => ({ text: "ok" }));
    const port = makePort(fn, { readSkillFile });

    const session = port.createSession({
      cwd,
      systemPrompt: { type: "preset", preset: "claude_code", append: "You are Shadow." },
      skills: ["writing-volumes"],
    });
    await drain(session, "go");

    const system = calls[0]?.system ?? "";
    const appendIndex = system.indexOf("You are Shadow.");
    const skillIndex = system.indexOf("Skill instructions.");
    expect(appendIndex).toBeGreaterThan(0);
    expect(skillIndex).toBeGreaterThan(appendIndex);
  });
});

describe("createBedrockAgenticSessionPort — allowedTools: [\"Skill\"] semantics", () => {
  test("allowedTools naming only the built-in Skill tool, with no toolServers, yields an empty tool set and a normal completed turn (not a crash)", async () => {
    const { fn, calls } = makeStreamTextFake(() => ({
      parts: [
        { type: "text-delta", id: "1", text: "done" },
        { type: "finish", finishReason: "stop" },
      ],
      text: "done",
    }));
    const port = makePort(fn);

    const session = port.createSession({ allowedTools: ["Skill"] });
    const events = await drain(session, "go");

    expect(calls[0]?.tools).toEqual({});
    const done = lastEvent(events);
    if (done.type !== "done") throw new Error("expected done");
    expect(done.result.isError).toBe(false);
    expect(done.result.text).toBe("done");
  });
});

describe("createBedrockAgenticSessionPort — conversation-harness proof", () => {
  /**
   * Approximates a real `ShadowConversation` turn without importing
   * `@shadow/agent` into `@shadow/model`'s tests: `@shadow/agent` already
   * depends on `@shadow/model` (its `package.json`'s `dependencies`), so
   * importing it back here would be a cycle. Instead this constructs
   * `createSession`'s options with the *exact* literal shape
   * `packages/agent/src/conversation.ts` passes (copied by hand —
   * plain-string `systemPrompt`, not a preset; chat never uses the preset
   * form today, despite `AgenticSessionOptions.systemPrompt`'s doc framing
   * it as "what Shadow chat wants") — the same
   * `cwd`/`systemPrompt`/`skills`/`settingSources`/`allowedTools`/
   * `disallowedTools`/`permissionMode` fields, in the same shape — through
   * the real port (fake `streamText`/`createProvider`, real `buildSystemPrompt`/
   * `buildTools`), and asserts the skills content and the real system
   * prompt text both reach `streamText`, and that the turn actually streams
   * and completes.
   */
  test("chat's exact createSession() options: skills inlined + real system prompt text reach streamText, turn streams and completes", async () => {
    const cwd = "/fake/shadow-home";
    const shadowSystemPromptExcerpt =
      "You are Shadow, the operator's shadow writer."; // representative excerpt of buildShadowSystemPrompt()'s real opening line (packages/agent/src/system-prompt.ts)
    const readSkillFile = fakeSkillFs({
      [skillPath(cwd, "writing-volumes")]:
        "---\nname: writing-volumes\ndescription: writing volumes skill\n---\n\n" +
        "# Writing volumes\n\nMark every claim with a footnote, keyed by kind.",
    });
    const { fn, calls } = makeStreamTextFake(() => ({
      parts: [
        { type: "text-delta", id: "1", text: "Understood." },
        { type: "finish", finishReason: "stop" },
      ],
      text: "Understood.",
      responseMessages: [{ role: "assistant", content: "Understood." }],
    }));
    const port = makePort(fn, { readSkillFile });

    // Mirrors conversation.ts's `agenticSessionPort.createSession({...})` call verbatim in shape.
    const session = port.createSession({
      cwd,
      systemPrompt: shadowSystemPromptExcerpt,
      skills: ["writing-volumes"],
      settingSources: ["project"],
      allowedTools: ["Skill"],
      disallowedTools: ["WebFetch", "WebSearch", "Bash", "Read", "Write", "Edit", "Agent", "Task"],
      permissionMode: "default",
    });

    const events = await drain(session, "Let's write a chapter.");

    const system = calls[0]?.system ?? "";
    expect(system).toContain(shadowSystemPromptExcerpt);
    expect(system).toContain("Mark every claim with a footnote, keyed by kind.");
    expect(system).not.toContain("description: writing volumes skill");

    expect(events.map((e) => e.type)).toEqual(["text-delta", "done"]);
    const done = lastEvent(events);
    if (done.type !== "done") throw new Error("expected done");
    expect(done.result.isError).toBe(false);
    expect(done.result.text).toBe("Understood.");
    // No toolServers configured (chat has none) — `allowedTools: ["Skill"]`
    // naming only a built-in with no Bedrock equivalent must not crash or
    // otherwise break the (empty) tool set.
    expect(calls[0]?.tools).toEqual({});
  });
});
