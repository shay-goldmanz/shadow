/**
 * Tests for the `WebResearchToolAgent` class itself: session reuse (D6),
 * the structural tool-allowlist hardening, error typing, and the
 * concurrency guard. Everything about the *tools themselves* — citation
 * binding, source integrity, fixture replay determinism, authority
 * inference — is tested directly against `retrieval-tools.ts` in
 * `retrieval-tools.test.ts`, because that is the real production code path
 * and it is fully offline-testable on its own.
 *
 * What is genuinely untestable offline is the Agent SDK's own tool-dispatch
 * loop (the part of a real run where the *model* decides to call `fetch`
 * then `submit_findings`) — `@shadow/model`'s `FakeAgenticSessionPort`
 * cannot execute it either, since it never touches the real
 * `createSdkMcpServer` instance a `ToolServerHandle` wraps. Rather than
 * leave that as a silent gap, this file's first test drives a small
 * same-process test double (`ScriptedToolLoopSession`, defined below) that
 * reaches `WebResearchToolAgent`'s own tool definitions — a `private`
 * field, accessible here only because this is the same package's
 * white-box test suite — and calls them exactly as the real SDK's loop
 * would. That proves `research()`'s wiring (the `getActive` closures, the
 * fresh `ResearchRun` per call) is correct end to end, without needing the
 * SDK itself.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemVolumeStore, toVolumeSlug, type VolumeSlug } from "@shadow/core";
import { FileSystemEvidenceStore } from "@shadow/evidence";
import type {
  AgenticSession,
  AgenticSessionOptions,
  AgenticSessionPort,
  AgenticStreamEvent,
  AgenticTurnResult,
  ToolDefinition,
} from "@shadow/model";
import { FakeAgenticSessionPort, ZERO_USAGE } from "@shadow/model";
import type { ResearchBrief } from "./brief.ts";
import {
  NoFindingsProducedError,
  ResearchAgentBusyError,
  ResearchTurnFailedError,
} from "./errors.ts";
import { FixtureCorpus } from "./fixture-corpus.ts";
import { ReplayTransport } from "./replay-transport.ts";
import { expectRejection } from "./test-helpers.ts";
import { WebResearchToolAgent, type WebResearchToolAgentDeps } from "./web-research-tool-agent.ts";

const LINEAR_URL = "https://linear.app/blog/design-system";
const LINEAR_HTML =
  "<html><body><main><p>Linear renders its sidebar on a 4px spacing scale.</p></main></body></html>";

async function withHarness<T>(
  fn: (deps: WebResearchToolAgentDeps & { volume: VolumeSlug }) => Promise<T>,
): Promise<T> {
  const fixturesRoot = await mkdtemp(join(tmpdir(), "shadow-research-agent-fixtures-"));
  const volumeRoot = await mkdtemp(join(tmpdir(), "shadow-research-agent-volume-"));
  try {
    const corpus = new FixtureCorpus(fixturesRoot);
    await corpus.writePage({
      requestedUrl: LINEAR_URL,
      finalUrl: LINEAR_URL,
      httpStatus: 200,
      contentType: "text/html",
      headers: {},
      bytes: new TextEncoder().encode(LINEAR_HTML),
      retrievedAt: "2026-08-11T09:14:22.000Z",
      transport: "live",
    });
    const transport = new ReplayTransport(corpus);
    const volumeStore = new FileSystemVolumeStore(volumeRoot);
    const volume = toVolumeSlug("test-volume");
    await volumeStore.createVolume({ slug: volume, title: "Test Volume" });
    const evidenceStore = new FileSystemEvidenceStore(volumeStore);
    return await fn({ transport, evidenceStore, sessions: new FakeAgenticSessionPort(), volume });
  } finally {
    await rm(fixturesRoot, { recursive: true, force: true });
    await rm(volumeRoot, { recursive: true, force: true });
  }
}

function brief(volume: VolumeSlug, overrides: Partial<ResearchBrief> = {}): ResearchBrief {
  return { volume, goal: "how does Linear design its sidebar", ...overrides };
}

// ---------------------------------------------------------------------------
// a same-process stand-in for the Agent SDK's tool-dispatch loop — see the
// module doc for why this is necessary and what it does and doesn't prove.
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: reaching into ToolDefinition's heterogeneous handler shape, exactly like retrieval-tools.ts's own createToolServer boundary
type AnyToolDefinition = ToolDefinition<any>;

class ScriptedToolLoopSession implements AgenticSession {
  sessionId: string | undefined;
  usage = ZERO_USAGE;
  readonly prompts: string[] = [];

  constructor(
    private readonly id: string,
    private readonly getToolDefinitions: () => readonly AnyToolDefinition[],
    private readonly script: (tools: readonly AnyToolDefinition[]) => Promise<string>,
  ) {}

  async *stream(prompt: string): AsyncGenerator<AgenticStreamEvent, void, undefined> {
    this.prompts.push(prompt);
    const text = await this.script(this.getToolDefinitions());
    this.sessionId = this.id;
    const result: AgenticTurnResult = {
      text,
      usage: ZERO_USAGE,
      sessionId: this.id,
      stopReason: "end_turn",
      isError: false,
      subagentsEnabled: false,
    };
    yield { type: "done", result };
  }
}

class ScriptedToolLoopSessionPort implements AgenticSessionPort {
  readonly sessions: ScriptedToolLoopSession[] = [];

  constructor(
    private readonly getToolDefinitions: () => readonly AnyToolDefinition[],
    private readonly script: (tools: readonly AnyToolDefinition[]) => Promise<string>,
  ) {}

  createSession(_options?: AgenticSessionOptions): AgenticSession {
    const session = new ScriptedToolLoopSession(
      `scripted-${this.sessions.length + 1}`,
      this.getToolDefinitions,
      this.script,
    );
    this.sessions.push(session);
    return session;
  }

  async deleteStoredSession(): Promise<void> {}
}

function toolDefinitionsOf(agent: WebResearchToolAgent): readonly AnyToolDefinition[] {
  return (agent as unknown as { toolDefinitions: readonly AnyToolDefinition[] }).toolDefinitions;
}

function findTool(tools: readonly AnyToolDefinition[], name: string): AnyToolDefinition {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool;
}

describe("WebResearchToolAgent — full happy path via a scripted tool loop", () => {
  test("research() returns findings bound to sources actually fetched and written to the ledger", async () => {
    await withHarness(async ({ transport, evidenceStore, volume }) => {
      let agent: WebResearchToolAgent | undefined;
      const sessions = new ScriptedToolLoopSessionPort(
        () => toolDefinitionsOf(agent as WebResearchToolAgent),
        async (tools) => {
          const fetchResult = await findTool(tools, "fetch").handler({
            url: LINEAR_URL,
            title: undefined,
            authorityTier: undefined,
            authorityRationale: undefined,
            volatility: undefined,
          });
          const sourceId = fetchResult.content.match(/^sourceId: (\S+)/m)?.[1];
          if (!sourceId) throw new Error("fetch did not return a sourceId");
          await findTool(tools, "submit_findings").handler({
            findings: [
              {
                text: "Linear renders its sidebar on a 4px spacing scale.",
                citations: [
                  { sourceId, quote: "Linear renders its sidebar on a 4px spacing scale." },
                ],
              },
            ],
          });
          return "Done.";
        },
      );
      agent = new WebResearchToolAgent({ transport, evidenceStore, sessions });

      const result = await agent.research(brief(volume));

      expect(result.findings).toHaveLength(1);
      expect(result.sources).toHaveLength(1);
      const citation = result.findings[0]?.citations[0];
      expect(citation?.sourceId).toBe(result.sources[0]?.id);

      const persisted = await evidenceStore.listSources(volume);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.retrieval.transport).toBe("fixture");
    });
  });
});

describe("WebResearchToolAgent — session reuse (D6)", () => {
  test("one session serves every research() call on the same instance, not one per call", async () => {
    await withHarness(async ({ transport, evidenceStore, volume }) => {
      const sessions = new FakeAgenticSessionPort(() => ({ text: "no tool calls happened" }));
      const agent = new WebResearchToolAgent({ transport, evidenceStore, sessions });

      // Neither call ever invokes a tool (the fake can't run the SDK's tool
      // loop — see the module doc), so both are expected to fail with
      // NoFindingsProducedError. What this test actually checks is that a
      // session was still created exactly once across both attempts.
      await expectRejection(agent.research(brief(volume)), NoFindingsProducedError);
      await expectRejection(
        agent.research(brief(volume, { goal: "a second, different brief" })),
        NoFindingsProducedError,
      );

      expect(sessions.sessions).toHaveLength(1);
      expect(sessions.sessions[0]?.prompts).toHaveLength(2);
      expect(agent.sessionId).toBe(sessions.sessions[0]?.sessionId);
    });
  });
});

describe("WebResearchToolAgent — structural tool-allowlist hardening", () => {
  test("allowedTools names exactly this agent's three research tools; disallowedTools names the SDK's own web/shell tools; settingSources is empty", async () => {
    await withHarness(async ({ transport, evidenceStore, volume }) => {
      const sessions = new FakeAgenticSessionPort(() => ({ text: "no tool calls" }));
      const agent = new WebResearchToolAgent({ transport, evidenceStore, sessions });

      await expectRejection(agent.research(brief(volume)), NoFindingsProducedError);

      const options = sessions.sessions[0]?.options;
      expect(options?.allowedTools).toEqual([
        "mcp__research__search",
        "mcp__research__fetch",
        "mcp__research__submit_findings",
      ]);
      expect(options?.disallowedTools).toContain("WebFetch");
      expect(options?.disallowedTools).toContain("WebSearch");
      expect(options?.disallowedTools).toContain("Bash");
      expect(options?.settingSources).toEqual([]);
      expect(options?.toolServers).toHaveLength(1);
      expect(options?.toolServers?.[0]?.name).toBe("research");
    });
  });
});

describe("WebResearchToolAgent — error propagation", () => {
  test("an isError turn becomes ResearchTurnFailedError", async () => {
    await withHarness(async ({ transport, evidenceStore, volume }) => {
      const sessions = new FakeAgenticSessionPort(() => ({
        isError: true,
        stopReason: "error",
        text: "something went wrong in the CLI subprocess",
      }));
      const agent = new WebResearchToolAgent({ transport, evidenceStore, sessions });
      await expectRejection(agent.research(brief(volume)), ResearchTurnFailedError);
    });
  });

  test("a successful turn with no submitted findings becomes NoFindingsProducedError, never an empty result", async () => {
    await withHarness(async ({ transport, evidenceStore, volume }) => {
      const sessions = new FakeAgenticSessionPort(() => ({ text: "I looked but found nothing." }));
      const agent = new WebResearchToolAgent({ transport, evidenceStore, sessions });
      await expectRejection(agent.research(brief(volume)), NoFindingsProducedError);
    });
  });
});

describe("WebResearchToolAgent — concurrency guard", () => {
  test("a second research() call on the same instance while the first is in flight is refused", async () => {
    await withHarness(async ({ transport, evidenceStore, volume }) => {
      let releaseFirst: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      class BlockingSession implements AgenticSession {
        sessionId: string | undefined = "blocking-session";
        usage = ZERO_USAGE;
        async *stream(): AsyncGenerator<AgenticStreamEvent, void, undefined> {
          await gate;
          const result: AgenticTurnResult = {
            text: "eventually done",
            usage: ZERO_USAGE,
            sessionId: "blocking-session",
            stopReason: "end_turn",
            isError: false,
            subagentsEnabled: false,
          };
          yield { type: "done", result };
        }
      }
      class BlockingSessionPort implements AgenticSessionPort {
        createSession(): AgenticSession {
          return new BlockingSession();
        }

        async deleteStoredSession(): Promise<void> {}
      }

      const agent = new WebResearchToolAgent({
        transport,
        evidenceStore,
        sessions: new BlockingSessionPort(),
      });

      const first = agent.research(brief(volume));
      const second = agent.research(brief(volume, { goal: "a concurrent second brief" }));

      await expectRejection(second, ResearchAgentBusyError);
      releaseFirst?.();
      // First call still resolves its own way (no findings submitted, so it
      // rejects too) — the point is only that it was not corrupted by the
      // concurrent attempt.
      await expectRejection(first, NoFindingsProducedError);
    });
  });
});
