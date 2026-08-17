/**
 * Tests for `PerBriefResearchAgent` (T0.1): the fresh-instance-per-call
 * `ResearchBriefPort` that replaces one `WebResearchToolAgent` shared
 * across every conversation.
 *
 * Two levels of test, deliberately:
 *
 * - Directly against `PerBriefResearchAgent.research()` for what it alone
 *   is responsible for: a fresh, non-persisted session per call, and no
 *   `ResearchAgentBusyError` when two calls are genuinely in flight
 *   together. These use `FakeAgenticSessionPort`/a small scripted session
 *   the same way `web-research-tool-agent.test.ts`'s own
 *   "session reuse"/"concurrency guard" tests do — the responder never
 *   drives a real tool call (`FakeAgenticSession` cannot run the SDK's
 *   tool-dispatch loop, see that file's module doc), so every call here
 *   rejects with `NoFindingsProducedError`; what matters is *how many*
 *   sessions were created and whether either call was refused as busy.
 *
 * - Against two directly-constructed `WebResearchToolAgent` instances,
 *   built exactly the way `PerBriefResearchAgent.research()` builds one
 *   internally (same deps, `sessionTuning.persistSession: false`), for
 *   "findings/sources do not bleed across concurrent runs". This needs
 *   real tool execution (a scripted tool loop, `web-research-tool-agent
 *   .test.ts`'s `ScriptedToolLoopSession` pattern) to produce real
 *   findings to compare — and `PerBriefResearchAgent.research()` never
 *   exposes the instance it constructs internally for a test to reach
 *   into, by design (that's the whole point of T0.1), so this level
 *   constructs the two instances itself rather than going through the
 *   factory a second time for no added coverage.
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
import { NoFindingsProducedError } from "./errors.ts";
import { FixtureCorpus } from "./fixture-corpus.ts";
import { PerBriefResearchAgent } from "./per-brief-research-agent.ts";
import { ReplayTransport } from "./replay-transport.ts";
import { expectRejection } from "./test-helpers.ts";
import { WebResearchToolAgent, type WebResearchToolAgentDeps } from "./web-research-tool-agent.ts";

const LINEAR_URL = "https://linear.app/blog/design-system";
const LINEAR_HTML =
  "<html><body><main><p>Linear renders its sidebar on a 4px spacing scale.</p></main></body></html>";
const LINEAR_FINDING = "Linear renders its sidebar on a 4px spacing scale.";

const NOTION_URL = "https://notion.so/blog/whitespace";
const NOTION_HTML =
  "<html><body><main><p>Notion favors near-zero chrome and generous whitespace.</p></main></body></html>";
const NOTION_FINDING = "Notion favors near-zero chrome and generous whitespace.";

async function withHarness<T>(
  fn: (deps: WebResearchToolAgentDeps & { volume: VolumeSlug }) => Promise<T>,
): Promise<T> {
  const fixturesRoot = await mkdtemp(join(tmpdir(), "shadow-per-brief-fixtures-"));
  const volumeRoot = await mkdtemp(join(tmpdir(), "shadow-per-brief-volume-"));
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
    await corpus.writePage({
      requestedUrl: NOTION_URL,
      finalUrl: NOTION_URL,
      httpStatus: 200,
      contentType: "text/html",
      headers: {},
      bytes: new TextEncoder().encode(NOTION_HTML),
      retrievedAt: "2026-08-11T09:15:47.000Z",
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
// PerBriefResearchAgent.research() directly: fresh, non-persisted sessions;
// no busy contention between concurrent calls.
// ---------------------------------------------------------------------------

describe("PerBriefResearchAgent — fresh, non-persisted session per call (T0.1)", () => {
  test("each research() call gets its own freshly-created session, never reused — unlike WebResearchToolAgent's D6 reuse", async () => {
    await withHarness(async ({ transport, evidenceStore, volume }) => {
      const sessions = new FakeAgenticSessionPort();
      const agent = new PerBriefResearchAgent({ transport, evidenceStore, sessions });

      await expectRejection(agent.research(brief(volume)), NoFindingsProducedError);
      await expectRejection(
        agent.research(brief(volume, { goal: "a second, different brief" })),
        NoFindingsProducedError,
      );

      expect(sessions.sessions).toHaveLength(2);
      expect(sessions.sessions[0]?.prompts).toHaveLength(1);
      expect(sessions.sessions[1]?.prompts).toHaveLength(1);
    });
  });

  test("created sessions are non-persisted — persistSession: false is threaded through, regardless of any sessionTuning the caller passed", async () => {
    await withHarness(async ({ transport, evidenceStore, volume }) => {
      const sessions = new FakeAgenticSessionPort();
      const agent = new PerBriefResearchAgent({
        transport,
        evidenceStore,
        sessions,
        sessionTuning: { model: "claude-test-model" },
      });

      await expectRejection(agent.research(brief(volume)), NoFindingsProducedError);

      const options = sessions.sessions[0]?.options;
      expect(options?.persistSession).toBe(false);
      // The rest of sessionTuning still passes through unaffected.
      expect(options?.model).toBe("claude-test-model");
    });
  });
});

describe("PerBriefResearchAgent — concurrent calls both complete (T0.1)", () => {
  test("two research() calls in flight at once both settle — no ResearchAgentBusyError, because each runs its own fresh WebResearchToolAgent instance", async () => {
    await withHarness(async ({ transport, evidenceStore, volume }) => {
      let releaseFirst: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      class ControllableSession implements AgenticSession {
        sessionId: string | undefined;
        usage = ZERO_USAGE;
        readonly failedSessionIds: readonly string[] = [];
        constructor(
          private readonly id: string,
          public readonly options: AgenticSessionOptions | undefined,
          private readonly delayed: boolean,
        ) {}
        async *stream(): AsyncGenerator<AgenticStreamEvent, void, undefined> {
          if (this.delayed) await gate;
          this.sessionId = this.id;
          const result: AgenticTurnResult = {
            text: "eventually done",
            usage: ZERO_USAGE,
            sessionId: this.id,
            stopReason: "end_turn",
            isError: false,
            subagentsEnabled: false,
          };
          yield { type: "done", result };
        }
      }

      let created = 0;
      const sessions: AgenticSessionPort = {
        createSession(options?: AgenticSessionOptions): AgenticSession {
          const index = created++;
          expect(options?.persistSession).toBe(false);
          // The first call's session blocks on `gate`; the second's does
          // not — so the second can only settle *before* the first is
          // released if the two calls are genuinely running concurrently,
          // not serialized behind a shared `busy` flag.
          return new ControllableSession(`controllable-${index}`, options, index === 0);
        },
        deleteStoredSession: async () => {},
      };

      const agent = new PerBriefResearchAgent({ transport, evidenceStore, sessions });

      const first = agent.research(brief(volume));
      const second = agent.research(brief(volume, { goal: "a concurrent second brief" }));

      // Second settles without waiting for the first to be released —
      // proof the two calls ran concurrently, each on its own instance,
      // rather than one being refused or queued behind the other.
      await expectRejection(second, NoFindingsProducedError);
      releaseFirst?.();
      await expectRejection(first, NoFindingsProducedError);
    });
  });
});

// ---------------------------------------------------------------------------
// Findings/sources isolation under real concurrent tool execution — see the
// module doc for why this level constructs its two agents directly.
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: reaching into ToolDefinition's heterogeneous handler shape, exactly like web-research-tool-agent.test.ts's own boundary
type AnyToolDefinition = ToolDefinition<any>;

class ScriptedToolLoopSession implements AgenticSession {
  sessionId: string | undefined;
  usage = ZERO_USAGE;
  readonly failedSessionIds: readonly string[] = [];

  constructor(
    private readonly id: string,
    private readonly toolDefinitions: readonly AnyToolDefinition[],
    private readonly script: (tools: readonly AnyToolDefinition[]) => Promise<string>,
  ) {}

  async *stream(_prompt: string): AsyncGenerator<AgenticStreamEvent, void, undefined> {
    const text = await this.script(this.toolDefinitions);
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

function toolDefinitionsOf(agent: WebResearchToolAgent): readonly AnyToolDefinition[] {
  return (agent as unknown as { toolDefinitions: readonly AnyToolDefinition[] }).toolDefinitions;
}

function findTool(tools: readonly AnyToolDefinition[], name: string): AnyToolDefinition {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool;
}

describe("PerBriefResearchAgent's underlying mechanism — findings/sources do not bleed across concurrent runs (T0.1)", () => {
  test("two fresh, non-persisted WebResearchToolAgent instances (built exactly as PerBriefResearchAgent builds them) running concurrently both complete, and each result carries only its own brief's findings and sources", async () => {
    await withHarness(async ({ transport, evidenceStore, volume }) => {
      let agentA: WebResearchToolAgent | undefined;
      let agentB: WebResearchToolAgent | undefined;

      // A barrier: neither script proceeds past it until *both* have
      // arrived — proof the two `research()` calls are genuinely in
      // flight together (controlled latency), not merely dispatched one
      // after the other.
      let remaining = 2;
      let releaseBoth: (() => void) | undefined;
      const bothArrived = new Promise<void>((resolve) => {
        releaseBoth = resolve;
      });
      async function arrive(): Promise<void> {
        remaining -= 1;
        if (remaining === 0) releaseBoth?.();
        await bothArrived;
      }

      function scriptFor(url: string, findingText: string) {
        return async (tools: readonly AnyToolDefinition[]): Promise<string> => {
          await arrive();
          const fetchResult = await findTool(tools, "fetch").handler({
            url,
            title: undefined,
            authorityTier: undefined,
            authorityRationale: undefined,
            volatility: undefined,
          });
          const sourceId = fetchResult.content.match(/^sourceId: (\S+)/m)?.[1];
          if (!sourceId) throw new Error("fetch did not return a sourceId");
          await findTool(tools, "submit_findings").handler({
            findings: [{ text: findingText, citations: [{ sourceId, quote: findingText }] }],
          });
          return "Done.";
        };
      }

      let created = 0;
      const sessions: AgenticSessionPort = {
        createSession(): AgenticSession {
          const index = created++;
          if (index === 0) {
            return new ScriptedToolLoopSession(
              "concurrent-a",
              toolDefinitionsOf(agentA as WebResearchToolAgent),
              scriptFor(LINEAR_URL, LINEAR_FINDING),
            );
          }
          return new ScriptedToolLoopSession(
            "concurrent-b",
            toolDefinitionsOf(agentB as WebResearchToolAgent),
            scriptFor(NOTION_URL, NOTION_FINDING),
          );
        },
        deleteStoredSession: async () => {},
      };

      // Constructed exactly the way `PerBriefResearchAgent.research()`
      // constructs its instance internally: same deps, a fresh instance
      // per brief, `persistSession: false`.
      agentA = new WebResearchToolAgent({
        transport,
        evidenceStore,
        sessions,
        sessionTuning: { persistSession: false },
      });
      agentB = new WebResearchToolAgent({
        transport,
        evidenceStore,
        sessions,
        sessionTuning: { persistSession: false },
      });

      const [resultA, resultB] = await Promise.all([
        agentA.research(brief(volume, { goal: "how does Linear design its sidebar" })),
        agentB.research(brief(volume, { goal: "how does Notion use whitespace" })),
      ]);

      expect(resultA.findings).toHaveLength(1);
      expect(resultB.findings).toHaveLength(1);
      expect(resultA.findings[0]?.text).toBe(LINEAR_FINDING);
      expect(resultB.findings[0]?.text).toBe(NOTION_FINDING);

      expect(resultA.sources).toHaveLength(1);
      expect(resultB.sources).toHaveLength(1);
      expect(resultA.sources[0]?.url).toBe(LINEAR_URL);
      expect(resultB.sources[0]?.url).toBe(NOTION_URL);
      expect(resultA.sources[0]?.id).not.toBe(resultB.sources[0]?.id);

      // No cross-contamination: each result's citation resolves only to
      // its own source, never the other run's.
      expect(resultA.findings[0]?.citations[0]?.sourceId).toBe(resultA.sources[0]?.id);
      expect(resultB.findings[0]?.citations[0]?.sourceId).toBe(resultB.sources[0]?.id);

      // Both sources genuinely landed in the shared evidence ledger.
      const persisted = await evidenceStore.listSources(volume);
      expect(persisted).toHaveLength(2);
    });
  });
});
