/**
 * Port 2 adapter — `@anthropic-ai/claude-agent-sdk` `query()` directly.
 *
 * D6 session reuse, concretely: `ClaudeAgentSdkSession` remembers the
 * `session_id` the CLI assigned on its first turn and passes it back as
 * `resume` on every later turn sent through the *same* handle. Each turn is
 * still a fresh `query()` call (and a fresh subprocess) — `resume` is what
 * lets that fresh process pick the conversation back up cheaply, reading
 * the Claude Code preamble from cache instead of paying to write it again.
 * `resume` only works against a session that was actually persisted to
 * `~/.claude/projects/`, so any handle that will see a second `stream()`
 * call must be created without `persistSession: false` — enforced in
 * `stream()` below rather than left as a convention (see
 * `AgenticSessionOptions.persistSession`'s doc for the incident that made
 * this necessary). `close()` is the matching cleanup half: a persisted
 * session accumulates on disk for as long as its caller keeps the handle
 * alive, so a long-lived caller should delete it when done.
 *
 * Guardrail: the CLI's first message is always the `system`/`init` message
 * carrying `apiKeySource`. We check it before yielding anything to the
 * caller and before the turn produces any content — the earliest point the
 * signal exists, and (unlike Port 1's best-effort abort) a point at which
 * we have not yet handed the caller a single byte of output.
 */

import {
  type AgentDefinition,
  deleteSession,
  type McpServerConfig,
  type ModelUsage,
  type Options,
  query,
  type SDKMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import { buildSubprocessEnv } from "../env.ts";
import { AgenticSessionError } from "../errors.ts";
import { assertSubscriptionAuth } from "../guardrail.ts";
import type {
  AgenticSession,
  AgenticSessionOptions,
  AgenticSessionPort,
  AgenticStreamEvent,
  AgenticTurnResult,
} from "../ports/agentic-session.ts";
import type { ResolvedToolServerHandle } from "../tools.ts";
import { addUsage, type TokenUsage, ZERO_USAGE } from "../usage.ts";

export interface ClaudeAgentSdkSessionDefaults {
  readonly model?: string;
  readonly cwd?: string;
}

/**
 * The slice of `query()`'s signature this adapter actually depends on —
 * async iteration, nothing else. Narrower than the SDK's own `Query`
 * return type (which also carries `interrupt`/`accountInfo`/etc.) so tests
 * can inject a fake that only implements iteration, without stubbing every
 * method `Query` declares. The real `query` function satisfies this type
 * as-is, by return-type covariance.
 */
export type QueryFn = (params: {
  prompt: string;
  options?: Options;
}) => AsyncGenerator<SDKMessage, void>;

export interface ClaudeAgentSdkSessionPortDeps {
  /** Injectable for tests. Defaults to the real `query()`. */
  readonly query?: QueryFn;
  /** Injectable for tests. Defaults to the real `deleteSession()`. Backs `AgenticSession.close()`. */
  readonly deleteSession?: typeof deleteSession;
}

export function createClaudeAgentSdkSessionPort(
  defaults: ClaudeAgentSdkSessionDefaults = {},
  deps: ClaudeAgentSdkSessionPortDeps = {},
): AgenticSessionPort {
  const queryFn = deps.query ?? query;
  const deleteSessionFn = deps.deleteSession ?? deleteSession;
  return {
    createSession(options: AgenticSessionOptions = {}): AgenticSession {
      return new ClaudeAgentSdkSession(queryFn, deleteSessionFn, defaults, options);
    },
  };
}

function sumModelUsage(modelUsage: Record<string, ModelUsage>): TokenUsage {
  let usage = ZERO_USAGE;
  for (const entry of Object.values(modelUsage)) {
    usage = addUsage(usage, {
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadTokens: entry.cacheReadInputTokens,
      cacheWriteTokens: entry.cacheCreationInputTokens,
    });
  }
  return usage;
}

function buildQueryOptions(
  defaults: ClaudeAgentSdkSessionDefaults,
  options: AgenticSessionOptions,
  resume: { readonly ownSessionId: string | undefined; readonly isFirstTurn: boolean },
): Options {
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const server of options.toolServers ?? []) {
    const resolved = server as ResolvedToolServerHandle;
    mcpServers[resolved.name] = resolved.config as McpServerConfig;
  }

  const agents: Record<string, AgentDefinition> | undefined = options.subagents
    ? Object.fromEntries(
        Object.entries(options.subagents).map(([name, definition]) => [
          name,
          {
            description: definition.description,
            prompt: definition.prompt,
            tools: definition.tools ? [...definition.tools] : undefined,
            model: definition.model,
          } satisfies AgentDefinition,
        ]),
      )
    : undefined;

  const base: Options = {
    model: options.model ?? defaults.model,
    cwd: options.cwd ?? defaults.cwd,
    systemPrompt: options.systemPrompt,
    allowedTools: options.allowedTools ? [...options.allowedTools] : undefined,
    disallowedTools: options.disallowedTools ? [...options.disallowedTools] : undefined,
    skills: options.skills ? (options.skills === "all" ? "all" : [...options.skills]) : undefined,
    settingSources: options.settingSources
      ? ([...options.settingSources] as SettingSource[])
      : undefined,
    mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
    agents,
    permissionMode: options.permissionMode,
    maxTurns: options.maxTurns,
    persistSession: options.persistSession,
    // Required for `text-delta` streaming — without it we only ever see
    // complete assistant messages, not incremental tokens.
    includePartialMessages: true,
    // `Options.env` REPLACES the subprocess environment, not merges — see
    // `../env.ts`. Every call site of `Options.env` in this package must
    // go through `buildSubprocessEnv`; this is the one.
    env: buildSubprocessEnv(options.env),
  };

  if (!resume.isFirstTurn) {
    // D6 session reuse: this handle already has its own session — resume
    // it regardless of what the caller originally passed for `resume` /
    // `continueMostRecent` (those only apply to bootstrapping turn one).
    return { ...base, resume: resume.ownSessionId };
  }

  if (options.resume) {
    return { ...base, resume: options.resume.sessionId, forkSession: options.resume.forkSession };
  }

  if (options.continueMostRecent) {
    return { ...base, continue: true };
  }

  return base;
}

/** Narrows a `stream_event` message's raw Anthropic stream event down to a text delta, if that's what it is. */
function extractTextDelta(
  event: Extract<SDKMessage, { type: "stream_event" }>["event"],
): string | undefined {
  if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
    return event.delta.text;
  }
  return undefined;
}

class ClaudeAgentSdkSession implements AgenticSession {
  private ownSessionId: string | undefined;
  private accumulatedUsage: TokenUsage = ZERO_USAGE;
  /**
   * Session ids an error `result` reported (`is_error: true`) but that were
   * never latched into `ownSessionId` — see the `case "result"` branch
   * below. The CLI may still have written a transcript for that session id
   * before failing, so `close()` deletes these too, not just `ownSessionId`.
   */
  private readonly failedSessionIds = new Set<string>();

  constructor(
    private readonly queryFn: QueryFn,
    private readonly deleteSessionFn: typeof deleteSession,
    private readonly defaults: ClaudeAgentSdkSessionDefaults,
    private readonly options: AgenticSessionOptions,
  ) {}

  get sessionId(): string | undefined {
    return this.ownSessionId;
  }

  get usage(): TokenUsage {
    return this.accumulatedUsage;
  }

  async *stream(prompt: string): AsyncGenerator<AgenticStreamEvent, void, undefined> {
    // Derived from a *successful* session id, not a count of turns sent: a
    // failed first turn must still look like a first turn to the retry that
    // follows it (fresh `resume`/`continueMostRecent` bootstrap, not
    // `resume: undefined` masquerading as "nothing to resume"). See
    // `case "result"` below for the other half of this — `ownSessionId` is
    // only ever assigned from a non-error result.
    const isFirstTurn = this.ownSessionId === undefined;

    if (!isFirstTurn && this.options.persistSession === false) {
      // `persistSession: false` and resume are mutually exclusive by
      // construction (see `AgenticSessionOptions.persistSession`'s doc): a
      // non-persisted session was never written to `~/.claude/projects/`,
      // so `resume: ownSessionId` below would have nothing to find. The
      // real CLI does discover this — but only after we spawn a subprocess
      // and pay for a round trip, surfacing as a raw
      // "No conversation found with session ID: ..." error from inside
      // `query()`. Fail fast, before any of that, with a message that
      // names the actual cause. This is the exact bug a Wave 3 review
      // proved live: Shadow's chat session (`@shadow/agent`'s
      // `conversation.ts`) set `persistSession: false` while relying on
      // resume-based multi-turn continuation (D6) — the fix there was to
      // stop setting it, not to work around this guard. Keying this off
      // `ownSessionId` rather than a turn count also means a persisted-
      // false session whose first turn *failed* gets to retry as a first
      // turn too — a resumed second turn only exists once a turn has
      // actually succeeded.
      throw new AgenticSessionError(
        "This AgenticSession was created with persistSession: false and cannot be resumed " +
          "for a second turn: non-persisted sessions are never written to " +
          "~/.claude/projects/, so there is nothing for `resume` to find. If this handle " +
          "needs more than one turn, do not set persistSession: false when creating it — " +
          "the SDK default is already `true` — and see DECISIONS.md D6 for how to manage " +
          "the resulting on-disk transcript.",
      );
    }

    const queryOptions = buildQueryOptions(this.defaults, this.options, {
      ownSessionId: this.ownSessionId,
      isFirstTurn,
    });

    const rawMessages = this.queryFn({ prompt, options: queryOptions });

    let initSeen = false;
    let subagentsEnabled = false;
    const toolNameByUseId = new Map<string, string>();

    for await (const message of rawMessages) {
      if (!initSeen) {
        if (message.type !== "system" || message.subtype !== "init") {
          // The CLI always emits system/init first; tolerate anything else
          // arriving first rather than assuming protocol order, but the
          // guardrail has nothing to check yet.
          continue;
        }
        initSeen = true;
        // Throwing here aborts this generator; the `for await` above calls
        // `.return()` on `rawMessages`, and nothing has been yielded to our
        // caller yet — no content from an unverified credential ever
        // reaches them.
        assertSubscriptionAuth({ apiKeySource: message.apiKeySource });
        subagentsEnabled = message.tools.includes("Agent") || message.tools.includes("Task");
        continue;
      }

      switch (message.type) {
        case "stream_event": {
          const text = extractTextDelta(message.event);
          if (text !== undefined) {
            yield { type: "text-delta", text };
          }
          break;
        }
        case "assistant": {
          for (const block of message.message.content) {
            if (block.type === "tool_use") {
              toolNameByUseId.set(block.id, block.name);
              yield { type: "tool-use", toolName: block.name, input: block.input };
            }
          }
          break;
        }
        case "user": {
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_result") {
                yield {
                  type: "tool-result",
                  toolName: toolNameByUseId.get(block.tool_use_id) ?? "unknown-tool",
                  output: block.content,
                  isError: block.is_error ?? false,
                };
              }
            }
          }
          break;
        }
        case "result": {
          const usage = sumModelUsage(message.modelUsage);
          if (message.is_error) {
            // Do NOT latch an error result's session id into `ownSessionId`
            // — 529/overloaded and friends report `is_error: true` here,
            // and latching would make the *next* `stream()` call believe
            // this handle already has a successful session to resume, when
            // in fact the caller's original `resume`/`continueMostRecent`
            // bootstrap should be retried instead. The CLI may still have
            // persisted a transcript under this id before failing, so it's
            // tracked for `close()` to clean up rather than discarded.
            if (message.session_id) {
              this.failedSessionIds.add(message.session_id);
            }
          } else {
            this.ownSessionId = message.session_id;
          }
          this.accumulatedUsage = addUsage(this.accumulatedUsage, usage);
          const result: AgenticTurnResult = {
            text: message.subtype === "success" ? message.result : "",
            usage,
            sessionId: message.session_id,
            stopReason: message.stop_reason,
            isError: message.is_error,
            subagentsEnabled,
          };
          yield { type: "done", result };
          return;
        }
        default:
          // Every other message subtype (status, compaction, hooks, task
          // progress, plugin install, ...) is outside this port's contract.
          // Ignored, not an error — a forward-compatible default as the
          // Agent SDK's message union keeps growing.
          break;
      }
    }

    throw new AgenticSessionError("query() stream ended without a 'result' message");
  }

  /**
   * Deletes this session's persisted transcript(s) from
   * `~/.claude/projects/` via the SDK's `deleteSession` — this handle's own
   * successful session id (`ownSessionId`), *and* any id an errored turn on
   * this handle reported (`failedSessionIds`): a persisted-but-errored turn
   * can still have written a transcript the caller has no other way to
   * reach, since that id was never exposed as `sessionId`. A no-op when
   * there is nothing to delete: no turn ever completed or failed with a
   * session id, or this session was created with `persistSession: false`
   * (nothing was ever written for it, successful or not). Deliberately not
   * called automatically anywhere in this package — this port has no
   * notion of "the caller is done with this conversation," so a long-lived
   * caller (Shadow chat, D6) that wants sessions to not accumulate
   * indefinitely on disk must call this itself once it retires a handle.
   */
  async close(): Promise<void> {
    if (this.options.persistSession === false) return;

    const idsToDelete = new Set(this.failedSessionIds);
    if (this.ownSessionId !== undefined) {
      idsToDelete.add(this.ownSessionId);
    }
    if (idsToDelete.size === 0) return;

    try {
      for (const id of idsToDelete) {
        await this.deleteSessionFn(id);
      }
    } catch (error) {
      throw new AgenticSessionError(
        `failed to delete persisted session(s): ${[...idsToDelete].join(", ")}`,
        error,
      );
    }
  }
}
