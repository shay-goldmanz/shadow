/**
 * Port 2 adapter — `@anthropic-ai/claude-agent-sdk` `query()` directly.
 *
 * D6 session reuse, concretely: `ClaudeAgentSdkSession` remembers the
 * `session_id` the CLI assigned on its first turn and passes it back as
 * `resume` on every later turn sent through the *same* handle. Each turn is
 * still a fresh `query()` call (and a fresh subprocess) — `resume` is what
 * lets that fresh process pick the conversation back up cheaply, reading
 * the Claude Code preamble from cache instead of paying to write it again.
 *
 * Guardrail: the CLI's first message is always the `system`/`init` message
 * carrying `apiKeySource`. We check it before yielding anything to the
 * caller and before the turn produces any content — the earliest point the
 * signal exists, and (unlike Port 1's best-effort abort) a point at which
 * we have not yet handed the caller a single byte of output.
 */

import {
  type AgentDefinition,
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
}

export function createClaudeAgentSdkSessionPort(
  defaults: ClaudeAgentSdkSessionDefaults = {},
  deps: ClaudeAgentSdkSessionPortDeps = {},
): AgenticSessionPort {
  const queryFn = deps.query ?? query;
  return {
    createSession(options: AgenticSessionOptions = {}): AgenticSession {
      return new ClaudeAgentSdkSession(queryFn, defaults, options);
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
  private turnsSent = 0;

  constructor(
    private readonly queryFn: QueryFn,
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
    const isFirstTurn = this.turnsSent === 0;
    this.turnsSent += 1;

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
          this.ownSessionId = message.session_id;
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
}
