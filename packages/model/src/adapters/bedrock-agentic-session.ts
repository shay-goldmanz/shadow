/**
 * Port 2 adapter — Bedrock strategy (D26). Vercel AI SDK `streamText`
 * via `@ai-sdk/amazon-bedrock`, looped by this file rather than by a CLI
 * subprocess.
 *
 * The claude-code adapter (`claude-agent-sdk-session.ts`) gets its whole
 * agent loop — tool dispatch, multi-turn iteration, session persistence —
 * from `@anthropic-ai/claude-agent-sdk`'s `query()`. Bedrock is a raw model
 * endpoint with no such loop attached, so this adapter owns one. It turns
 * out the Vercel AI SDK's own `streamText` already *has* a multi-step tool
 * loop built in — give it `tools` with `execute` functions and a `stopWhen`
 * condition wider than one step, and it will call the model, run any tool
 * calls the model makes, feed the results back, and keep going until the
 * model stops calling tools or the step cap is hit — all before `streamText`
 * returns. That is exactly the "call model → run tools → call model again"
 * cycle this port needs, so this adapter rides `streamText`'s own loop
 * (`stopWhen: stepCountIs(...)`) instead of writing a second one on top of
 * it. What this file adds: translating `streamText`'s step-by-step
 * `fullStream` into this port's `AgenticStreamEvent` union as it arrives,
 * and — since Bedrock has no session concept of its own — an in-memory
 * `ModelMessage[]` history per session handle, appended to after every turn,
 * that stands in for the claude-code adapter's `resume`-by-`session_id`.
 *
 * ## Session identity and resume (no CLI, no disk)
 *
 * A `sessionId` here is a `crypto.randomUUID()` this file mints on a
 * session's first turn — nothing upstream assigns one. "Persisting" a
 * session (`persistSession` unset or `true`, the default) means registering
 * it in a `Map` closed over by this port's factory, keyed by that id, so a
 * *different* `createSession({ resume: { sessionId } })` call *in the same
 * process* can pick the conversation back up. There is no on-disk
 * transcript — restart the process and every id is gone, including for
 * `persistSession: true` sessions. That is a real, permanent limitation
 * relative to the claude-code adapter's `~/.claude/projects/`-backed
 * `resume` (documented here rather than silently assumed away); a future
 * iteration may revisit whether Bedrock-backed chat needs real persistence.
 *
 * Resuming a registered id constructs a **new** `BedrockAgenticSession`
 * using *this* call's options (its own tools/system prompt/model — matching
 * `ClaudeAgentSdkSession`, where a resumed session is a fresh instance too),
 * seeded with the found session's message history and accumulated usage.
 * Without `resume.forkSession`, the new instance keeps the *same* session id
 * and replaces the registry's entry for it (so a later `resume` of that id
 * picks up from here, not from the pre-resume state). With `forkSession:
 * true`, the new instance starts with no id of its own — it mints a fresh
 * one on its own first turn, leaving the original id's registry entry
 * untouched — an independent branch off the same history.
 *
 * `persistSession: false` combined with `resume`/`continueMostRecent` throws
 * at `createSession` time, for the same reason `ClaudeAgentSdkSession`
 * throws it on a second turn: a non-persisted session is never in the
 * registry, so there would be nothing for that resume to find. Failing at
 * construction (before any turn runs) is strictly earlier than the
 * claude-code adapter can manage (it can only detect this once a *second*
 * turn is attempted on the *same* handle) — offered here because Bedrock's
 * registry makes the contradiction visible immediately.
 *
 * ## Tool naming (see `buildTools`)
 *
 * `ToolDefinition.name` (bare, e.g. `"search"`) is what this adapter hands
 * `streamText` and what it reports on `tool-use`/`tool-result` events — the
 * name a research tool-agent's own bookkeeping (`retrieval-tools.ts`,
 * `ResearchRun`) actually keys on. The `mcp__{server}__{tool}` form
 * (`tools.ts`'s doc: "addressable as `mcp__{server.name}__{toolName}` in
 * `allowedTools`") only ever appears here as a comparison key when applying
 * `allowedTools`/`disallowedTools` — it is never the name a Bedrock tool call
 * actually uses, because there is no MCP transport underneath to namespace.
 *
 * ## Skills inlining
 *
 * The claude-code adapter's `skills` option is a *filter* over skills the
 * CLI discovers on disk and the model invokes on demand via its built-in
 * `Skill` tool (see `@shadow/agent`'s `skills.ts` module doc for the exact
 * discovery convention: `<cwd>/.claude/skills/<name>/SKILL.md`, gated by
 * `settingSources` including `"project"`). There is no CLI here and no
 * `Skill` tool to invoke on demand, so this adapter takes the other option
 * the brief allows for: read every named skill's `SKILL.md` up front and
 * inline its body straight into the system prompt, under its own `## Skill:
 * <name>` section (`buildSkillsSection`). The model never "calls" a skill on
 * this transport — the instructions are simply already in front of it,
 * always, for the whole session. `settingSources` and `permissionMode` stay
 * true no-ops (there is still no settings-file loading or permission-prompt
 * concept on a raw model endpoint) — only `skills` gets real behavior here.
 *
 * This reads the *same* on-disk location the claude-code adapter's skill
 * discovery does (`<cwd>/.claude/skills/<name>/SKILL.md`), not a
 * `<cwd>/skills/<name>/SKILL.md` shortcut — so a caller that already
 * installs a skill for the claude-code path (Shadow chat's
 * `ensureWritingVolumesSkillInstalled`, which copies the monorepo's
 * canonical `skills/writing-volumes/SKILL.md` into
 * `<cwd>/.claude/skills/writing-volumes/SKILL.md` before `createSession`)
 * needs no separate install step for this adapter; the same copy step
 * satisfies both. `cwd` falls back to `process.cwd()` when the caller omits
 * it, matching the claude-code adapter/Agent SDK's own default.
 *
 * A named skill whose `SKILL.md` cannot be read throws `AgenticSessionError`
 * **at `createSession` time**, naming the resolved path — before any turn
 * runs, let alone reaches the network. Silently degrading to prose without
 * the skill's instructions would be a worse failure than a loud one: the
 * whole reason `skills` is set is that the model's behavior depends on
 * content it would otherwise never see. `skills: "all"` (the claude-code
 * adapter's "discover every skill under every loaded settings source" mode)
 * has no equivalent to inline here — there is no directory-wide scan on this
 * adapter — so it throws the same way, asking the caller for an explicit
 * list instead.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AmazonBedrockProviderSettings } from "@ai-sdk/amazon-bedrock";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import type { LanguageModelUsage, ModelMessage, Tool } from "ai";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { AgenticSessionError } from "../errors.ts";
import type {
  AgenticSession,
  AgenticSessionOptions,
  AgenticSessionPort,
  AgenticStreamEvent,
  AgenticTurnResult,
  SystemPromptOption,
} from "../ports/agentic-session.ts";
import type { ResolvedToolServerHandle } from "../tools.ts";
import { addUsage, type TokenUsage, ZERO_USAGE } from "../usage.ts";
import { BEDROCK_DEFAULT_MODEL, resolveModelId } from "./bedrock-structured-generation.ts";

/** The provider instance `createAmazonBedrock` returns — same rationale as `bedrock-structured-generation.ts`'s identical alias. */
type AmazonBedrockProvider = ReturnType<typeof createAmazonBedrock>;

/** Per-adapter options for the `"bedrock"` strategy's agentic-session half — same three fields as `BedrockStructuredGenerationOptions`, kept as its own type (matching `ClaudeAgentSdkSessionDefaults` alongside `ClaudeCodeStructuredGenerationOptions`) since the two adapters may grow independent options later. */
export interface BedrockAgenticSessionDefaults {
  readonly model?: string;
  readonly region?: string;
  readonly apiKey?: string;
}

export interface BedrockAgenticSessionPortDeps {
  /** Injectable for tests. Defaults to `createAmazonBedrock` from `@ai-sdk/amazon-bedrock`. */
  readonly createProvider?: (settings: AmazonBedrockProviderSettings) => AmazonBedrockProvider;
  /** Injectable for tests. Defaults to the real `streamText` from `ai`. Typed as the real function so a fake stays honest to the actual call shape. */
  readonly streamText?: typeof streamText;
  /**
   * Injectable for tests. Defaults to a synchronous `readFileSync(path,
   * "utf8")`. Backs skills inlining (see the module doc's "Skills inlining"
   * section) — kept synchronous because `createSession` itself is
   * synchronous (`AgenticSessionPort.createSession` returns an
   * `AgenticSession`, not a `Promise`), and a missing skill file must fail
   * at that same synchronous call rather than lazily on the first `stream()`.
   */
  readonly readSkillFile?: (path: string) => string;
}

/**
 * Cap on `streamText`'s own step loop per `stream()` call — the "32 tool
 * rounds" ceiling the brief asks for, expressed as `stopWhen: stepCountIs(n)`
 * (one `stepCountIs` step is one model call, whether or not it made tool
 * calls, so this bounds "model call ↔ tool round" cycles, not raw tool
 * invocations). `AgenticSessionOptions.maxTurns` overrides it per session,
 * mirroring the claude-code adapter's identically-named option, which caps
 * the same kind of thing (agent turns within one `query()` call) there.
 */
const DEFAULT_MAX_TOOL_ROUNDS = 32;

/**
 * `systemPrompt: { type: "preset", preset: "claude_code" }`'s resolution on
 * this adapter: a short, neutral assistant preamble — **not** an attempt at
 * parity with the real Claude Code CLI system prompt (there is no CLI here
 * to load it from, and it runs thousands of words describing CLI-specific
 * conventions — tool-call formatting, `CLAUDE.md` discovery, slash commands
 * — that have no meaning on a raw model endpoint). That gap is fine in
 * practice: every real caller of this preset (Shadow chat, via
 * `@shadow/agent`'s `conversation.ts`) supplies its *own* full system prompt
 * as `append`, which is where the actual persona and instructions live —
 * this constant only needs to give the model a reasonable default frame
 * before `append` (or the caller's own plain string, for the non-preset
 * case) does the real work.
 */
const PRESET_SYSTEM_PROMPT =
  "You are a capable, autonomous agent. Use whatever tools are available in this session " +
  "when they help you complete the task, and be direct and concrete in what you report back.";

/**
 * Preamble prepended to every inlined skill section (see the module doc's
 * "Skills inlining" section) — told once, not once per skill, so each
 * section below it can just be the skill's own content.
 */
const SKILLS_PREAMBLE =
  "The sections below are skills: operating instructions the claude-code CLI would normally " +
  "load on demand via a built-in `Skill` tool. This session has no such tool, so their full " +
  "content is inlined here instead, up front. Treat each section as binding guidance whenever " +
  "its subject matter applies to what you are doing.";

/** Matches a leading YAML frontmatter block (`---\n...\n---\n`) at the very start of a `SKILL.md` file's content, non-greedy so it stops at the first closing `---` line rather than one that appears later in the body (e.g. inside a fenced example). */
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

/** A `SKILL.md`'s frontmatter is routing metadata for the claude-code CLI's own skill discovery — not useful once the whole file is being inlined unconditionally — so only the body past it is inlined. */
function stripFrontmatter(content: string): string {
  return content.replace(FRONTMATTER_RE, "").trim();
}

/** The same on-disk convention the claude-code adapter's skill discovery uses — see the module doc's "Skills inlining" section for why this matters (it's what lets one install step serve both adapters). */
function resolveSkillPath(cwd: string, name: string): string {
  return join(cwd, ".claude", "skills", name, "SKILL.md");
}

function loadSkillSection(
  name: string,
  cwd: string,
  readSkillFile: (path: string) => string,
): string {
  const path = resolveSkillPath(cwd, name);
  let raw: string;
  try {
    raw = readSkillFile(path);
  } catch (cause) {
    throw new AgenticSessionError(
      `bedrock agentic session: skill "${name}" not found at ${path}. This adapter inlines a ` +
        "skill's SKILL.md into the system prompt instead of the claude-code CLI's on-demand " +
        "Skill-tool discovery, so the file must already exist at " +
        "<cwd>/.claude/skills/<name>/SKILL.md before createSession is called — the same " +
        "location and the same install step the claude-code path needs (e.g. @shadow/agent's " +
        "ensureWritingVolumesSkillInstalled(cwd), which must run before createSession here too).",
      cause,
    );
  }
  return `## Skill: ${name}\n\n${stripFrontmatter(raw)}`;
}

/** Builds the full inlined-skills block for `options.skills`, or `undefined` if there are none to inline. Throws `AgenticSessionError` for `skills: "all"` (no directory-wide scan exists on this adapter to make that meaningful) or for any named skill whose file can't be read — see `loadSkillSection`. */
function buildSkillsSection(
  options: AgenticSessionOptions,
  cwd: string,
  readSkillFile: (path: string) => string,
): string | undefined {
  const skills = options.skills;
  if (skills === undefined) return undefined;
  if (skills === "all") {
    throw new AgenticSessionError(
      'bedrock agentic session: skills: "all" has no equivalent here. The claude-code CLI\'s ' +
        '"all" scans every settings-source skill directory at runtime; this adapter has no such ' +
        "scan and needs an explicit list of skill names to inline instead — pass skills as a " +
        'string[] (e.g. ["writing-volumes"]).',
    );
  }
  if (skills.length === 0) return undefined;
  const sections = skills.map((name) => loadSkillSection(name, cwd, readSkillFile));
  return `${SKILLS_PREAMBLE}\n\n${sections.join("\n\n")}`;
}

function resolveBaseSystemPrompt(option: SystemPromptOption | undefined): string | undefined {
  if (option === undefined) return undefined;
  if (typeof option === "string") return option;
  return option.append ? `${PRESET_SYSTEM_PROMPT}\n\n${option.append}` : PRESET_SYSTEM_PROMPT;
}

/**
 * The full `system` string handed to `streamText`: the resolved base
 * (plain string / preset-plus-append / omitted) with any inlined skills
 * section appended after it. Called once per `createSession` — including
 * once per `resume`/`continueMostRecent` call, each of which builds a fresh
 * `BedrockAgenticSession` from that call's own options (module doc's
 * "Session identity and resume" section) — never lazily inside `stream()`,
 * so a missing skill file fails at `createSession` time (see the module
 * doc's "Skills inlining" section).
 */
function buildSystemPrompt(
  options: AgenticSessionOptions,
  readSkillFile: (path: string) => string,
): string | undefined {
  const base = resolveBaseSystemPrompt(options.systemPrompt);
  const cwd = options.cwd ?? process.cwd();
  const skillsSection = buildSkillsSection(options, cwd, readSkillFile);
  if (!skillsSection) return base;
  return base ? `${base}\n\n${skillsSection}` : skillsSection;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function translateUsage(usage: LanguageModelUsage): TokenUsage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
  };
}

/** The `mcp__{server}__{tool}` name existing consumers already write into `allowedTools`/`disallowedTools` (see `tools.ts`'s doc) — reproduced here purely for allow/disallow-list matching. Never the name actually handed to the model or reported on stream events — see the module doc's "Tool naming" section. */
function namespacedName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/**
 * Convert every `toolServers` entry's `ToolDefinition`s into AI SDK
 * `tool()`s, filtered by `allowedTools`/`disallowedTools`. Built fresh per
 * `stream()` call (cheap — no LLM call, just object construction) so a
 * session's tool set always reflects its own options; nothing here is
 * mutable shared state.
 *
 * Filtering matches by the namespaced `mcp__{server}__{tool}` form (see
 * `namespacedName`) so options built for the claude-code adapter (e.g.
 * `web-research-tool-agent.ts`'s `allowedTools`) work unmodified against
 * this adapter too. A name in `allowedTools`/`disallowedTools` that doesn't
 * correspond to any `toolServers` entry — every claude-code built-in
 * (`WebFetch`, `WebSearch`, `Bash`, `Agent`/`Task`, ...) — has no Bedrock
 * equivalent and is silently ignored: there is no built-in tool surface on
 * this adapter for such a name to allow or deny in the first place.
 */
function buildTools(options: AgenticSessionOptions): Record<string, Tool> {
  const allowed = options.allowedTools;
  const disallowed = options.disallowedTools;
  const result: Record<string, Tool> = {};

  for (const server of options.toolServers ?? []) {
    const resolved = server as ResolvedToolServerHandle;
    for (const definition of resolved.definitions) {
      const fullName = namespacedName(resolved.name, definition.name);
      if (allowed && !allowed.includes(fullName)) continue;
      if (disallowed?.includes(fullName)) continue;
      if (result[definition.name]) {
        throw new AgenticSessionError(
          `bedrock agentic session: duplicate tool name "${definition.name}" across toolServers ` +
            `(server "${resolved.name}") — this adapter exposes tools by bare name (see the module ` +
            'doc\'s "Tool naming" section), so two servers defining the same tool name collide.',
        );
      }
      result[definition.name] = tool({
        description: definition.description,
        inputSchema: z.object(definition.inputSchema),
        // `ToolDefinition.handler` already returns a `ToolResult` shape
        // (`{ content, isError? }`, never throwing for an ordinary tool
        // failure — see `tools.ts`) so a normal failed call surfaces to the
        // model as tool output, exactly like the claude-code adapter's MCP
        // wrapping, and the loop continues. Only a genuine bug in `handler`
        // itself (an actual thrown exception) reaches `streamText` as a
        // `tool-error` step — see `BedrockAgenticSession.stream`'s handling
        // of that part type, which ends the turn with `isError: true`.
        execute: async (input: unknown) =>
          definition.handler(input as Parameters<typeof definition.handler>[0]),
      });
    }
  }

  return result;
}

/** One process-local registry entry: enough to seed a resumed/forked/continued session — see the module doc's "Session identity and resume" section. */
interface RegistryEntry {
  readonly session: BedrockAgenticSession;
}

export function createBedrockAgenticSessionPort(
  defaults: BedrockAgenticSessionDefaults = {},
  deps: BedrockAgenticSessionPortDeps = {},
): AgenticSessionPort {
  const createProvider = deps.createProvider ?? createAmazonBedrock;
  const runStreamText = deps.streamText ?? streamText;
  const readSkillFile = deps.readSkillFile ?? ((path: string) => readFileSync(path, "utf8"));

  const provider = createProvider({ region: defaults.region, apiKey: defaults.apiKey });

  const registry = new Map<string, RegistryEntry>();
  let mostRecentSessionId: string | undefined;

  function register(session: BedrockAgenticSession): void {
    const id = session.sessionId;
    if (!id) return;
    registry.set(id, { session });
    mostRecentSessionId = id;
  }

  function resolveModel(options: AgenticSessionOptions) {
    const modelId = resolveModelId(options.model ?? defaults.model ?? BEDROCK_DEFAULT_MODEL);
    return provider.languageModel(modelId);
  }

  return {
    createSession(options: AgenticSessionOptions = {}): AgenticSession {
      const persisted = options.persistSession !== false;

      if (!persisted && (options.resume || options.continueMostRecent)) {
        throw new AgenticSessionError(
          "AgenticSessionOptions.persistSession: false is incompatible with resume/" +
            "continueMostRecent: a non-persisted Bedrock session is never registered, so " +
            "there is nothing for either to find. Either drop persistSession: false, or drop " +
            "resume/continueMostRecent and let this call start a fresh session.",
        );
      }

      // `resume` takes precedence over `continueMostRecent` when both are
      // set — matching `ClaudeAgentSdkSession`'s `buildQueryOptions`, which
      // only ever checks `continueMostRecent` in the branch where `resume`
      // was absent.
      if (options.resume) {
        const entry = registry.get(options.resume.sessionId);
        if (!entry) {
          throw new AgenticSessionError(
            `No session found with session ID: ${options.resume.sessionId} (this process's ` +
              "in-memory registry has no record of it — Bedrock sessions are process-local, so " +
              "a session created in a different process, or since this one restarted, cannot " +
              'be resumed here; see the module doc\'s "Session identity and resume" section).',
          );
        }
        const session = new BedrockAgenticSession(
          runStreamText,
          resolveModel(options),
          options,
          buildSystemPrompt(options, readSkillFile),
          register,
        );
        session.seedFromResume(entry.session, options.resume.forkSession ?? false);
        if (!options.resume.forkSession) register(session);
        return session;
      }

      if (options.continueMostRecent) {
        if (!mostRecentSessionId) {
          throw new AgenticSessionError(
            "continueMostRecent: no session has been created yet in this process (Bedrock has " +
              "no on-disk conversation history to fall back to — see the module doc's " +
              '"Session identity and resume" section).',
          );
        }
        // Cannot be missing: every id ever assigned to `mostRecentSessionId` was set in the
        // same `register` call that inserted it into `registry`, and entries are never evicted.
        const entry = registry.get(mostRecentSessionId) as RegistryEntry;
        const session = new BedrockAgenticSession(
          runStreamText,
          resolveModel(options),
          options,
          buildSystemPrompt(options, readSkillFile),
          register,
        );
        session.seedFromResume(entry.session, false);
        register(session);
        return session;
      }

      return new BedrockAgenticSession(
        runStreamText,
        resolveModel(options),
        options,
        buildSystemPrompt(options, readSkillFile),
        register,
      );
    },
  };
}

class BedrockAgenticSession implements AgenticSession {
  private history: ModelMessage[] = [];
  private ownSessionId: string | undefined;
  private accumulatedUsage: TokenUsage = ZERO_USAGE;
  private turnsSent = 0;

  constructor(
    // biome-ignore lint/suspicious/noExplicitAny: `streamText`'s real generic signature can't be named without repeating its full type parameter list; DI only ever swaps this for a same-shaped test fake, never a caller-visible type.
    private readonly runStreamText: any,
    // biome-ignore lint/suspicious/noExplicitAny: `provider.languageModel(...)`'s return type, likewise not worth naming here.
    private readonly model: any,
    private readonly options: AgenticSessionOptions,
    /**
     * Precomputed by `buildSystemPrompt` at `createSession` time (see that
     * function's doc) — never recomputed per-turn, so a skill file read
     * happens once, up front, rather than on every `stream()` call.
     */
    private readonly systemPrompt: string | undefined,
    private readonly onFirstTurn: (session: BedrockAgenticSession) => void,
  ) {}

  get sessionId(): string | undefined {
    return this.ownSessionId;
  }

  get usage(): TokenUsage {
    return this.accumulatedUsage;
  }

  /** Seeds this (brand-new, zero-turn) instance from a resumed/continued session's state — see the module doc's "Session identity and resume" section for the fork-vs-not distinction. */
  seedFromResume(existing: BedrockAgenticSession, fork: boolean): void {
    this.history = [...existing.history];
    this.accumulatedUsage = existing.accumulatedUsage;
    if (!fork) {
      this.ownSessionId = existing.ownSessionId;
      this.turnsSent = existing.turnsSent;
    }
    // `fork: true` deliberately leaves `ownSessionId`/`turnsSent` at their
    // just-constructed defaults (`undefined`/`0`) — this instance mints its
    // own fresh session id on its own first turn below, independent of
    // `existing`'s id.
  }

  async *stream(prompt: string): AsyncGenerator<AgenticStreamEvent, void, undefined> {
    if (this.turnsSent > 0 && this.options.persistSession === false) {
      // Mirrors `ClaudeAgentSdkSession.stream`'s identical guard: a second
      // turn on a handle created with `persistSession: false` has nothing
      // to resume from (this session was never registered — see
      // `createBedrockAgenticSessionPort`'s `register`), matching the real
      // adapter and `FakeAgenticSession`'s shared contract.
      throw new AgenticSessionError(
        "This AgenticSession was created with persistSession: false and cannot be resumed " +
          "for a second turn: non-persisted sessions are never registered, so there is " +
          "nothing for a second turn to continue. If this handle needs more than one turn, " +
          "do not set persistSession: false when creating it — the default is already true.",
      );
    }

    const isFirstTurn = this.turnsSent === 0;
    if (isFirstTurn && this.ownSessionId === undefined) {
      this.ownSessionId = crypto.randomUUID();
    }
    if (isFirstTurn && this.options.persistSession !== false) {
      this.onFirstTurn(this);
    }
    this.turnsSent += 1;

    this.history.push({ role: "user", content: prompt });

    const tools = buildTools(this.options);
    const maxRounds = this.options.maxTurns ?? DEFAULT_MAX_TOOL_ROUNDS;

    const result = this.runStreamText({
      model: this.model,
      system: this.systemPrompt,
      messages: this.history,
      tools,
      stopWhen: stepCountIs(maxRounds),
    });

    let sawError: unknown;
    try {
      for await (const part of result.fullStream as AsyncIterable<
        { type: string } & Record<string, unknown>
      >) {
        switch (part.type) {
          case "text-delta": {
            yield { type: "text-delta", text: part.text as string };
            break;
          }
          case "tool-call":
            yield { type: "tool-use", toolName: part.toolName as string, input: part.input };
            break;
          case "tool-result": {
            const output: unknown = part.output;
            const isToolResultShape =
              typeof output === "object" && output !== null && "content" in output;
            yield {
              type: "tool-result",
              toolName: part.toolName as string,
              output: isToolResultShape ? (output as { content: unknown }).content : output,
              isError: isToolResultShape
                ? Boolean((output as { isError?: boolean }).isError)
                : false,
            };
            break;
          }
          case "tool-error":
            // A genuine thrown exception from `ToolDefinition.handler` (see
            // `buildTools`'s doc) — not a normal `{ isError: true }` tool
            // result, which arrives as an ordinary "tool-result" part
            // above and does not end the turn. This does: the contract
            // (`AgenticSession.stream`'s doc) wants `done` last with
            // `isError: true`, not a thrown error from this generator, for
            // any failure that happens mid-turn rather than before it.
            sawError = (part as unknown as { error: unknown }).error;
            break;
          case "error":
            sawError = (part as unknown as { error: unknown }).error;
            break;
          default:
            break;
        }
        if (sawError !== undefined) break;
      }
    } catch (error) {
      sawError = error;
    }

    if (sawError !== undefined) {
      // Undo the push at the top of this turn: with no assistant response
      // to pair it with, leaving the user prompt in `history` would let it
      // sit there as a dangling user message. The Bedrock provider merges
      // consecutive user-role messages into one, so a retry's prompt would
      // otherwise get silently fused with this failed turn's prompt into a
      // single message the model has no way to tell apart. Popping it back
      // off restores `history` to its exact pre-turn state so a retry (or
      // any later turn) starts clean.
      this.history.pop();

      const turnResult: AgenticTurnResult = {
        // The contract (`AgenticSession.stream`'s doc) wants the error
        // described in `result.text` for an errored turn — any text
        // streamed before the failure was already forwarded as its own
        // `text-delta` events above, so it isn't repeated here.
        text: describeError(sawError),
        // Best-effort only: the stream ended before `streamText` finished
        // accounting for the turn, so there is no reliable total usage to
        // report here — a known gap, not an oversight (see the module doc).
        usage: ZERO_USAGE,
        // biome-ignore lint/style/noNonNullAssertion: minted unconditionally above, on this same turn, before any yield.
        sessionId: this.ownSessionId!,
        stopReason: "error",
        isError: true,
        subagentsEnabled: false,
      };
      yield { type: "done", result: turnResult };
      return;
    }

    const responseMessages = (await result.responseMessages) as ModelMessage[];
    this.history.push(...responseMessages);

    const text = (await result.text) as string;
    const usage = translateUsage((await result.usage) as LanguageModelUsage);
    const finishReason = (await result.finishReason) as string;
    this.accumulatedUsage = addUsage(this.accumulatedUsage, usage);

    const turnResult: AgenticTurnResult = {
      text,
      usage,
      // biome-ignore lint/style/noNonNullAssertion: minted unconditionally above, on this same turn, before any yield.
      sessionId: this.ownSessionId!,
      stopReason: finishReason,
      isError: false,
      // Bedrock has no `Agent`/`Task` built-in tool and this adapter never
      // synthesizes subagent invocation — see `AgenticSessionOptions.subagents`'s
      // doc; that field is accepted (typechecks) and silently ignored.
      subagentsEnabled: false,
    };
    yield { type: "done", result: turnResult };
  }

  /**
   * No-op: unlike `ClaudeAgentSdkSession.close` (which deletes a
   * `~/.claude/projects/` transcript), a Bedrock session has nothing
   * on-disk to clean up — its only footprint is this process's in-memory
   * registry entry, and this adapter does not evict registry entries on
   * `close()` (a long-lived process that opens and closes many sessions
   * will accumulate history in memory for as long as it runs; acceptable
   * for the tool-agent/short-session use this port serves today, revisit
   * if Bedrock backs a long-lived chat surface).
   */
  async close(): Promise<void> {}
}
