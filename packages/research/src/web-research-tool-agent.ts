/**
 * `WebResearchToolAgent` — the reference `ResearchBriefPort` implementation
 * (T2.1b). Takes a brief, drives an `@shadow/model` agentic session armed
 * with exactly the three tools from `retrieval-tools.ts`, and returns
 * findings already bound to sources it wrote into the evidence ledger.
 *
 * ## How bypassing the transport is made structurally hard
 *
 * Three independent layers, deliberately redundant with each other:
 *
 * 1. **Allowlist is exhaustive.** `AgenticSessionOptions.allowedTools` is
 *    set to *exactly* `mcp__research__search`, `mcp__research__fetch`,
 *    `mcp__research__submit_findings` — nothing else. A tool the model
 *    isn't allowed to call is inert (`@shadow/model`'s `tools.ts` doc), so
 *    there is no other tool surface to reach for.
 * 2. **Built-ins are explicitly denied.** `disallowedTools` names the Agent
 *    SDK's own `WebFetch`, `WebSearch`, and `Bash` (which could otherwise
 *    shell out to `curl`). Belt-and-braces against (1): even a future
 *    change to this port's defaults that accidentally widened
 *    `allowedTools` would still hit this list.
 * 3. **`settingSources: []`.** No project/user/local settings are loaded
 *    for this session, so no `.claude/settings.json` anywhere on disk can
 *    grant a permission this session did not ask for.
 *
 * Underneath all three, the handlers themselves (`retrieval-tools.ts`) are
 * plain closures over an injected `RetrievalTransport` — they contain no
 * `fetch` call of their own. Swap the transport for `ReplayTransport` and
 * every one of these layers is moot for determinism anyway: the tools
 * physically cannot resolve a URL that is not in the fixture corpus.
 *
 * ## Session reuse (D6)
 *
 * One `AgenticSession` is created lazily on the first `research()` call and
 * reused for every later one on the same instance — not one session per
 * `research()` call, and certainly not one per `fetch`/`search` tool call
 * (those happen *inside* a single turn's tool loop, at no extra session
 * cost). The tool server is also built once, in the constructor; its
 * handlers read "which run is currently active" through `getActiveRun`
 * rather than closing over a fixed `ResearchRun`, which is what lets one
 * long-lived session serve many `research()` calls without rewiring tools
 * on every call.
 *
 * This reuse is what makes this class unsafe to share across concurrent
 * callers (see the `busy` guard in `research()` below): a second concurrent
 * `research()` call on the same instance would corrupt which run the
 * shared tool handlers are scoped to, so it is refused rather than
 * interleaved. `PerBriefResearchAgent` (`per-brief-research-agent.ts`,
 * T0.1) is the concurrency-safe `ResearchBriefPort` built on top of this
 * class: it constructs a fresh instance per `research()` call instead of
 * sharing one, which is also why it passes `sessionTuning.persistSession:
 * false` — see that field's doc.
 */

import type { EvidenceStore } from "@shadow/evidence";
import type {
  AgenticSession,
  AgenticSessionOptions,
  AgenticSessionPort,
  ToolDefinition,
} from "@shadow/model";
import { createToolServer, runToCompletion } from "@shadow/model";
import type { ResearchBrief, ResearchBriefPort, ResearchResult } from "./brief.ts";
import {
  NoFindingsProducedError,
  ResearchAgentBusyError,
  ResearchTurnFailedError,
} from "./errors.ts";
import { ResearchRun } from "./research-run.ts";
import { buildResearchTools } from "./retrieval-tools.ts";
import type { RetrievalTransport } from "./types.ts";

export const DEFAULT_RESEARCH_AGENT_ID = "@shadow/research/web-research-tool-agent@0.1.0";

const TOOL_SERVER_NAME = "research";

/** Narrow, additive-only session tuning. Deliberately excludes `toolServers`, `allowedTools`, `disallowedTools`, and `settingSources` — those are exactly the surface the class doc's structural hardening depends on, so a caller cannot loosen them by passing options through. */
export interface ResearchSessionTuning {
  readonly model?: string;
  readonly cwd?: string;
  readonly maxTurns?: number;
  /** Appended to the built-in research system prompt, e.g. house style notes. */
  readonly systemPromptAppend?: string;
  /**
   * Passed straight through to `AgenticSessionOptions.persistSession`.
   * Omitted (the default) takes the Agent SDK's own default (`true`),
   * which is what this class's own "Session reuse (D6)" section depends
   * on — a caller planning to send more than one `research()` call
   * through the same instance must leave this unset. Set `false` only
   * when the caller knows this specific instance will receive exactly one
   * `research()` call, ever (T0.1's `PerBriefResearchAgent`, `@shadow/research`,
   * is the reference caller): a session that will never be resumed gains
   * nothing from being persisted, and persisting it anyway is what leaks
   * one orphaned `~/.claude/projects/` transcript per brief.
   */
  readonly persistSession?: boolean;
}

export interface WebResearchToolAgentDeps {
  readonly transport: RetrievalTransport;
  readonly evidenceStore: EvidenceStore;
  readonly sessions: AgenticSessionPort;
  /** Recorded as `retrieval.agent` on every source this agent writes. */
  readonly agentId?: string;
  readonly sessionTuning?: ResearchSessionTuning;
}

interface ActiveRun {
  readonly run: ResearchRun;
  readonly brief: ResearchBrief;
}

function buildPrompt(brief: ResearchBrief): string {
  const lines: string[] = [
    `Research goal: ${brief.goal}`,
    "",
    "Use `search` to find candidate pages, `fetch` to retrieve and read one (this also " +
      "records it as a source — note the returned sourceId), and `submit_findings` to report " +
      "what you learned. Every finding must cite the exact sourceId and an exact quoted span " +
      "from a fetch you actually performed in this conversation. Do not paraphrase into a " +
      "quote — copy the text verbatim from what `fetch` returned. Call `submit_findings` " +
      "exactly once you are done; it is the only way your findings reach the caller.",
  ];
  if (brief.subjectDomains && brief.subjectDomains.length > 0) {
    lines.push(
      `Subject domains (treated as primary-authority sources): ${brief.subjectDomains.join(", ")}`,
    );
  }
  if (brief.constraints && brief.constraints.length > 0) {
    lines.push("Constraints:", ...brief.constraints.map((c) => `- ${c}`));
  }
  if (brief.maxSources !== undefined) {
    lines.push(`Fetch at most ${brief.maxSources} distinct source(s).`);
  }
  return lines.join("\n");
}

const RESEARCH_SYSTEM_PROMPT =
  "You are a research tool-agent. Your only way to learn anything about the outside world is " +
  "the search/fetch tools provided — you have no other web access. Every finding you report " +
  "must be traceable to a page you actually fetched in this conversation, quoted exactly. " +
  "Never invent a sourceId, never invent a quote, and never report something you did not " +
  "actually read via `fetch`.";

/** The reference `ResearchBriefPort` implementation — see the module doc. */
export class WebResearchToolAgent implements ResearchBriefPort {
  private readonly agentId: string;
  private readonly toolServerName = TOOL_SERVER_NAME;
  /**
   * Built once, in the constructor — cheap (plain objects, no LLM call), so
   * there is no cost to doing it eagerly instead of lazily inside
   * `getOrCreateSession`. Each handler closes over `getActive`, not a fixed
   * `ResearchRun`, which is what lets these same definitions serve every
   * `research()` call on this instance (D6) without being rebuilt.
   *
   * `private` (TypeScript-only) rather than omitted: it keeps this off the
   * public type real callers see through `ResearchBriefPort`/this class,
   * while still being reachable from this package's own white-box tests —
   * see `web-research-tool-agent.test.ts` for why that matters (a
   * same-process simulation of the Agent SDK's tool loop, which
   * `@shadow/model`'s fakes cannot execute themselves).
   */
  // biome-ignore lint/suspicious/noExplicitAny: matches ResearchToolsDeps/createToolServer's own necessarily-heterogeneous array type — see retrieval-tools.ts
  private readonly toolDefinitions: ReadonlyArray<ToolDefinition<any>>;
  private session: AgenticSession | undefined;
  private active: ActiveRun | undefined;
  private busy = false;

  constructor(private readonly deps: WebResearchToolAgentDeps) {
    this.agentId = deps.agentId ?? DEFAULT_RESEARCH_AGENT_ID;
    this.toolDefinitions = buildResearchTools({
      transport: this.deps.transport,
      evidenceStore: this.deps.evidenceStore,
      agentId: this.agentId,
      getActive: () => this.active,
    });
  }

  async research(brief: ResearchBrief): Promise<ResearchResult> {
    if (this.busy) {
      throw new ResearchAgentBusyError(brief.goal);
    }
    this.busy = true;
    const run = new ResearchRun(brief.maxSources);
    this.active = { run, brief };
    try {
      const session = this.getOrCreateSession();
      const result = await runToCompletion(session, buildPrompt(brief));
      if (result.isError) {
        throw new ResearchTurnFailedError(brief.goal, result.stopReason, result.text);
      }
      if (run.findingCount === 0) {
        throw new NoFindingsProducedError(brief.goal, result.text);
      }
      return { findings: run.findingsSoFar, sources: run.sources };
    } finally {
      this.active = undefined;
      this.busy = false;
    }
  }

  /** Inspectable for tests/callers that want to confirm session reuse (D6) without a real subprocess. */
  get sessionId(): string | undefined {
    return this.session?.sessionId;
  }

  private getOrCreateSession(): AgenticSession {
    if (this.session) return this.session;

    const toolServer = createToolServer(this.toolServerName, this.toolDefinitions);

    const allowedTools = toolServer.toolNames.map((name) => `mcp__${toolServer.name}__${name}`);

    const options: AgenticSessionOptions = {
      model: this.deps.sessionTuning?.model,
      cwd: this.deps.sessionTuning?.cwd,
      maxTurns: this.deps.sessionTuning?.maxTurns,
      systemPrompt: this.deps.sessionTuning?.systemPromptAppend
        ? `${RESEARCH_SYSTEM_PROMPT}\n\n${this.deps.sessionTuning.systemPromptAppend}`
        : RESEARCH_SYSTEM_PROMPT,
      // See the class doc's "How bypassing the transport is made
      // structurally hard" — these four fields together are the guardrail.
      allowedTools,
      disallowedTools: ["WebFetch", "WebSearch", "Bash", "Agent", "Task"],
      toolServers: [toolServer],
      settingSources: [],
      permissionMode: "default",
      // Threaded straight from `sessionTuning.persistSession` — see that
      // field's doc. Left unset (the common case, when this instance is
      // reused across many `research()` calls per D6), this omits the
      // field and takes the Agent SDK's own default (`true`), which is
      // required for the second and later calls' `resume` to find
      // anything. Passing `false` here for a reused instance would be the
      // identical contradiction a Wave 3 review found and fixed in
      // `@shadow/agent`'s `conversation.ts` (see that file's comment on
      // this same field) — `sessionTuning.persistSession`'s doc is what
      // keeps that mistake from recurring here.
      persistSession: this.deps.sessionTuning?.persistSession,
    };

    this.session = this.deps.sessions.createSession(options);
    return this.session;
  }
}
