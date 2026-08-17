/**
 * Port 2 — agentic sessions (D5).
 *
 * Tool-heavy, multi-turn work: Shadow chat, research tool-agents,
 * skill-guided writing. Backed by `@anthropic-ai/claude-agent-sdk`
 * `query()` directly — see `../adapters/claude-agent-sdk-session.ts`.
 *
 * D6 shape: `createSession` returns a handle a caller holds across turns.
 * The handle threads Claude Code's `resume` mechanism internally after the
 * first turn, so the ~18k-cache-write-token preamble is paid once per
 * session, not once per call — that reuse is this port's whole reason to
 * exist as a session abstraction rather than a bare "ask the model
 * something" function.
 *
 * Deliberately one required primitive (`stream`) rather than a
 * buffered-and-streaming pair: `runToCompletion` below is a generic helper
 * built purely on `AgenticSession`, so both the real adapter and
 * `FakeAgenticSessionPort` only ever have to implement `stream`.
 */

import { AgenticSessionError } from "../errors.ts";
import type { ToolServerHandle } from "../tools.ts";
import type { TokenUsage } from "../usage.ts";

/** Filesystem settings sources to load — mirrors the Agent SDK's `SettingSource`, kept as our own literal type so this port's public surface never needs the SDK's types (see D5). */
export type SettingsSource = "user" | "project" | "local";

/** Mirrors the Agent SDK's `PermissionMode`, as our own type for the same reason. */
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";

/**
 * System prompt configuration.
 *
 * - omit entirely: the Agent SDK's own default, which is **minimal** —
 *   unlike the `claude` CLI, `query()` does not start from the Claude Code
 *   system prompt unless told to.
 * - `string`: a fully custom system prompt.
 * - `{ type: "preset", preset: "claude_code", append? }`: CLI parity — the
 *   full Claude Code system prompt, optionally with extra instructions
 *   appended. This is what Shadow chat wants; a narrow research tool-agent
 *   more often wants a custom string instead.
 */
export type SystemPromptOption =
  | string
  | { readonly type: "preset"; readonly preset: "claude_code"; readonly append?: string };

/** A subagent invocable via the `Agent` tool (see `AgenticSessionOptions.subagents`). Mirrors the Agent SDK's `AgentDefinition`, narrowed to the fields this port supports. */
export interface SubagentDefinition {
  readonly description: string;
  readonly prompt: string;
  readonly tools?: readonly string[];
  readonly model?: string;
}

export interface AgenticSessionOptions {
  readonly model?: string;
  readonly cwd?: string;
  readonly systemPrompt?: SystemPromptOption;
  /**
   * Tools auto-allowed without a permission prompt. Note: subagents need
   * `"Agent"` here (renamed from `"Task"` in Agent SDK v2.1.63) — see
   * `AgenticTurnResult.subagentsEnabled`, which handles both names when
   * reading back what the CLI actually reports.
   */
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly skills?: readonly string[] | "all";
  /**
   * Filesystem settings sources to load. Deliberately no default: omitting
   * this loads every source (`user`, `project`, `local`), matching CLI
   * defaults — Shadow chat wants project skills loaded. Pass `[]` for
   * isolation — tests, and any offline/deterministic caller, want that.
   * There is no "safe" implicit choice between those two, so callers must
   * make it explicitly every time.
   */
  readonly settingSources?: readonly SettingsSource[];
  /** Custom tools built with `defineTool`/`createToolServer` (`../tools.ts`). Each server's tools are addressable as `mcp__{server.name}__{toolName}` in `allowedTools`. */
  readonly toolServers?: readonly ToolServerHandle[];
  /** Named subagents invocable via the `Agent` tool. Keys are agent names. */
  readonly subagents?: Readonly<Record<string, SubagentDefinition>>;
  readonly permissionMode?: PermissionMode;
  readonly maxTurns?: number;
  /**
   * @default true — set `false` only for a session you know will receive
   * exactly one turn (e.g. a one-shot generation). A non-persisted session
   * is never written to `~/.claude/projects/`, so there is nothing for a
   * later turn's `resume` to find — **`persistSession: false` and sending a
   * second turn on the same `AgenticSession` handle are mutually
   * exclusive.** `ClaudeAgentSdkSession` enforces this at the port boundary
   * (throws before spawning a subprocess) and `FakeAgenticSession` mirrors
   * the same failure offline, so a caller that reuses a handle it created
   * non-persisted fails loudly and immediately rather than silently
   * "working" until it hits the real adapter (see DECISIONS.md D6, and the
   * incident that made this comment necessary — a wave-3 review proved
   * Shadow's chat handle was doing exactly this).
   */
  readonly persistSession?: boolean;
  /**
   * Extra environment variables for the CLI subprocess, merged over
   * `process.env` (never in place of it — see `../env.ts`).
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Resume a session created by a previous `AgenticSession` instance (e.g. a session id persisted to disk). Ignored after the first turn of a session that already has its own `sessionId`. */
  readonly resume?: { readonly sessionId: string; readonly forkSession?: boolean };
  /** Equivalent to the CLI's `--continue`: continue the most recent conversation in `cwd` instead of starting a new one. Mutually exclusive with `resume`. */
  readonly continueMostRecent?: boolean;
}

export type AgenticStreamEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "tool-use"; readonly toolName: string; readonly input: unknown }
  | {
      readonly type: "tool-result";
      readonly toolName: string;
      readonly output: unknown;
      readonly isError: boolean;
    }
  | { readonly type: "done"; readonly result: AgenticTurnResult };

export interface AgenticTurnResult {
  readonly text: string;
  readonly usage: TokenUsage;
  readonly sessionId: string;
  readonly stopReason: string | null;
  readonly isError: boolean;
  /**
   * Whether subagent invocation was available for this turn. Reads the
   * init message's advertised tool list for either `"Agent"` (current
   * name, Agent SDK v2.1.63+) or `"Task"` (older CLIs may still report
   * this) — see `AgenticSessionOptions.allowedTools`.
   */
  readonly subagentsEnabled: boolean;
}

export interface AgenticSession {
  /** `undefined` until the first turn completes. */
  readonly sessionId: string | undefined;
  /** Usage accumulated across every turn sent through this session handle. */
  readonly usage: TokenUsage;
  /**
   * Session ids an *error* result (`is_error: true`) reported but that were
   * never latched into `sessionId` (T1.1's first-turn derivation) — the CLI
   * may still have persisted a transcript under one of these before the
   * turn failed. Excludes this handle's own `resume` target even when an
   * error result echoes it back (F3 review fix — that id is a pre-existing
   * transcript this handle didn't orphan, not a new one). Grows across every
   * failed turn sent through this handle; nothing here clears it except
   * `close()`. F7 review fix (T3.1): the caller-facing surface of
   * `ClaudeAgentSdkSession`'s/`FakeAgenticSession`'s private
   * `failedSessionIds` tracking (both pre-dating this getter, T1.1) — what
   * lets `@shadow/agent`'s `ShadowConversation` and, through it,
   * `@shadow/api`'s `SessionService.finishTurn` record a failed FIRST turn's
   * id in `SessionMeta.failedSdkSessionIds` even though `close()` is never
   * called on the ordinary path (see that class's doc). Empty when nothing
   * has ever failed with a session id on this handle.
   */
  readonly failedSessionIds: readonly string[];
  /**
   * Send one user turn, streaming events as they arrive. The final event is
   * always `{ type: "done", result }` — on every path, including an error
   * turn (`result.isError`) — so a consumer can always find the outcome by
   * draining to the end rather than wrapping the call in try/catch for the
   * ordinary "the model reported failure" case. A thrown error from this
   * method means something failed *before* a turn could be attempted at
   * all (most importantly, `SubscriptionAuthError` from the guardrail).
   *
   * @throws {SubscriptionAuthError} if auth did not resolve to the
   *   operator's subscription (D5's guardrail).
   * @throws {AgenticSessionError} on a transport/process failure that
   *   prevented the turn from running, including reusing a handle created
   *   with `persistSession: false` for a second turn (see that option's
   *   doc).
   */
  stream(prompt: string): AsyncIterable<AgenticStreamEvent>;
  /**
   * Release this session's on-disk transcript, if it has one. A no-op for a
   * session that never completed a turn (`sessionId` still `undefined`) or
   * that was created with `persistSession: false` (nothing was ever
   * written). Optional because most callers — anything short-lived, and
   * every existing implementer besides the real adapter and its fake —
   * have no cleanup to do; see `ClaudeAgentSdkSession.close` for why a
   * long-lived handle (Shadow chat, D6) should call this when it is done
   * with a conversation, since persisted sessions otherwise accumulate
   * under `~/.claude/projects/` for as long as the operator keeps chatting.
   */
  close?(): Promise<void>;
}

export interface AgenticSessionPort {
  createSession(options?: AgenticSessionOptions): AgenticSession;
  /**
   * Delete a previously-persisted session's on-disk transcript by its SDK
   * session id, with no live `AgenticSession` handle required (T2.4/D6b).
   *
   * Once sessions outlive the process (`@shadow/sessions`, Tier 2), the
   * *only* thing that knows a session's SDK id after a restart or an
   * eviction is stored metadata (`SessionMeta.sdkSessionId`) — there is no
   * in-memory `AgenticSession` left to call `close()` through, and `close()`
   * couldn't help anyway: it deletes ids a *live* handle latched during its
   * own turns (`ownSessionId`/`failedSessionIds` on
   * `ClaudeAgentSdkSession`), which a cold session never had a handle to
   * latch in the first place. This method is the id-based counterpart that
   * works regardless — wraps the Agent SDK's `deleteSession` directly, and
   * is the sole deletion path callers should use going forward
   * (`ShadowConversation.release()` no longer deletes anything; see its
   * doc). A no-op if `sdkSessionId` was never persisted, per the SDK's own
   * `deleteSession` contract.
   */
  deleteStoredSession(sdkSessionId: string): Promise<void>;
}

/**
 * Drain `session.stream(prompt)` and return the final result. The
 * buffered-call convenience every non-streaming caller (research
 * tool-agents, index/eval work that happens to want tools) actually wants,
 * built once here rather than duplicated in every adapter and fake.
 */
export async function runToCompletion(
  session: AgenticSession,
  prompt: string,
): Promise<AgenticTurnResult> {
  let final: AgenticTurnResult | undefined;
  for await (const event of session.stream(prompt)) {
    if (event.type === "done") {
      final = event.result;
    }
  }
  if (!final) {
    throw new AgenticSessionError("session.stream() ended without a 'done' event");
  }
  return final;
}
