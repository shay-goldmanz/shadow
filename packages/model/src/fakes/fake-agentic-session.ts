/**
 * In-memory fake for `AgenticSessionPort` — no LLM, no subprocess.
 *
 * Exported from the package's public surface (`../index.ts`) so T2.x/T3.x
 * packages can test tool-agent and chat orchestration logic offline. It
 * reproduces the two real-adapter behaviors callers actually depend on:
 *
 * 1. A session's `sessionId` is `undefined` until the first turn, then
 *    stays *stable* across every later turn sent through the same handle —
 *    the observable shape of D6's session reuse, without a subprocess to
 *    reuse.
 * 2. A session created with `persistSession: false` **throws** if a second
 *    turn is ever sent through it, exactly like `ClaudeAgentSdkSession`
 *    (`../adapters/claude-agent-sdk-session.ts`) and the real CLI beneath
 *    it. This one is load-bearing: before it existed, this fake happily
 *    let a non-persisted handle "resume" forever, which is exactly how
 *    `@shadow/agent`'s chat session shipped with `persistSession: false`
 *    plus resume-based multi-turn continuation and every offline test
 *    stayed green. Without this, the fake is a *more* permissive model of
 *    the SDK than the SDK itself — see the class doc on
 *    `AgenticSessionOptions.persistSession` for the incident.
 *
 * T1.2 grows this fake with transient-failure and no-conversation-found
 * scripting (`FakeAgenticTurnScript.throws`, `failNTimesThenSucceed`,
 * `noConversationFoundError` below) — a prerequisite for T1.3's retrying
 * decorator (`../retrying-agentic-session.ts`, now built) and T2.5's
 * resume-fallback tests. `throws` can additionally yield scripted `events`
 * first before throwing (F6 review fix) — the "partial output, then a
 * mid-turn failure" shape T2.5's tee tests need, which a whole-turn-only
 * `throws` couldn't script.
 */

import { AgenticSessionError } from "../errors.ts";
import type {
  AgenticSession,
  AgenticSessionOptions,
  AgenticSessionPort,
  AgenticStreamEvent,
  AgenticTurnResult,
} from "../ports/agentic-session.ts";
import { addUsage, type TokenUsage, ZERO_USAGE } from "../usage.ts";

/** What one turn should produce. All fields optional — omit anything you don't care about in a given test. */
export interface FakeAgenticTurnScript {
  readonly text?: string;
  readonly usage?: TokenUsage;
  readonly stopReason?: string | null;
  readonly isError?: boolean;
  readonly subagentsEnabled?: boolean;
  /** Extra events to yield before the final `done` event (e.g. scripted `tool-use`/`tool-result`/`text-delta`). `done` is always appended automatically — unless `throws` is also set, see that field's doc. */
  readonly events?: readonly AgenticStreamEvent[];
  /**
   * If set, this turn throws `throws` instead of producing a `done` result
   * — mirrors the `"thrown"` failure channel out of the real
   * `ClaudeAgentSdkSession.stream()` (T1.2's `TurnFailure`,
   * `../ports/retry-policy.ts` — e.g. a transient transport failure, or
   * `noConversationFoundError` below). `text`/`usage`/`stopReason`/
   * `isError`/`subagentsEnabled` are ignored when this is set — there is no
   * `done` result to build when the turn never produces one. `events`,
   * however, is honored first (F6 review fix): any scripted events are
   * yielded, in order, before the throw — the "partial output, then a
   * mid-turn failure" shape T2.5's tee tests need, and the one
   * `RetryingAgenticSession` (T1.3) treats as non-retryable once anything
   * has reached the caller. Omit `events` for the original whole-turn
   * failure shape (nothing yielded, immediate throw). Either way, the
   * prompt is recorded in `session.prompts` — the turn really was sent
   * before it failed.
   */
  readonly throws?: unknown;
}

/**
 * Builds a `FakeAgenticTurnResponder` that throws `error` on the first
 * `failCount` calls, then returns `succeedWith` on every call after — the
 * transient-then-recovers shape `conservativeRetryPolicy` exists to paper
 * over (`../ports/retry-policy.ts`, T1.2/T1.3): 529/overloaded,
 * rate-limited, or a transient 5xx that clears up within a couple of
 * retries. The call counter is shared by every session this responder is
 * attached to (mirroring `FakeAgenticSessionPort`'s single `respond`
 * callback, shared across all sessions it creates) — pass a fresh call to
 * this function per test unless sharing across sessions is the point.
 */
export function failNTimesThenSucceed(
  failCount: number,
  error: unknown,
  succeedWith: FakeAgenticTurnScript = {},
): FakeAgenticTurnResponder {
  let calls = 0;
  return () => {
    calls += 1;
    return calls <= failCount ? { throws: error } : succeedWith;
  };
}

/**
 * The real Claude Agent SDK CLI's error text when `resume`/`continue` names
 * a session id the CLI has no transcript for — thrown out of the raw
 * `query()` generator, never surfaced as an `isError` result. Verified live
 * (see `ClaudeAgentSdkSession.stream`'s `persistSession: false` guard
 * comment, `../adapters/claude-agent-sdk-session.ts`, which reproduces the
 * same text for the one case that guard can trigger offline). This helper
 * is for scripting the general case that guard doesn't cover: Tier 2
 * resuming a session id that once existed on disk but no longer does
 * (deleted, expired, moved machines) — the shape `conservativeRetryPolicy`
 * (`../ports/retry-policy.ts`) must never retry, so Tier 2's resume
 * fallback sees it on the first attempt.
 */
export function noConversationFoundError(sessionId: string): AgenticSessionError {
  return new AgenticSessionError(`No conversation found with session ID: ${sessionId}`);
}

export type FakeAgenticTurnResponder = (
  prompt: string,
  context: { readonly turnIndex: number; readonly sessionId: string | undefined },
) => FakeAgenticTurnScript;

const defaultResponder: FakeAgenticTurnResponder = (prompt) => ({ text: `echo: ${prompt}` });

export class FakeAgenticSessionPort implements AgenticSessionPort {
  /** Every session this fake has created, in creation order — inspect in assertions. */
  readonly sessions: FakeAgenticSession[] = [];
  /**
   * Every id passed to `deleteStoredSession`, in call order (T2.4) — the
   * fake's inspectable stand-in for the SDK's `deleteSession`, mirroring
   * `ClaudeAgentSdkSession`'s real adapter. Deliberately a *separate* list
   * from any individual `FakeAgenticSession.deletedSessionIds`: this one
   * records port-level, id-only deletions that need no live handle at all —
   * exactly the cold-session shape this method exists for.
   */
  readonly deletedStoredSessionIds: string[] = [];

  private sessionCounter = 0;

  constructor(private readonly respond: FakeAgenticTurnResponder = defaultResponder) {}

  createSession(options: AgenticSessionOptions = {}): AgenticSession {
    this.sessionCounter += 1;
    const session = new FakeAgenticSession(
      `fake-session-${this.sessionCounter}`,
      this.respond,
      options,
    );
    this.sessions.push(session);
    return session;
  }

  async deleteStoredSession(sdkSessionId: string): Promise<void> {
    this.deletedStoredSessionIds.push(sdkSessionId);
  }
}

export class FakeAgenticSession implements AgenticSession {
  /** Every prompt sent through this session, in order — inspect in assertions. */
  readonly prompts: string[] = [];

  private ownSessionId: string | undefined;
  private accumulatedUsage: TokenUsage = ZERO_USAGE;
  private turnIndex = 0;
  private closed = false;
  /**
   * Mirrors `ClaudeAgentSdkSession.failedSessionIds`: ids from `isError`
   * scripts, which are never latched into `ownSessionId` (T1.1) but are
   * still reported back via `AgenticTurnResult.sessionId` and are what
   * `close()` cleans up below — EXCEPT this handle's own `options.resume`
   * target (F3 review fix, see the id-assignment branch below), which is
   * never added here even if an `isError` script fires on the first turn.
   * Inspectable for tests that want to assert on the "deletable" set
   * directly rather than only through `close()`'s side effects; cleared by
   * a successful `close()` (idempotency, F3 review fix), so read it before
   * calling `close()` if the pre-clear contents matter to the assertion.
   */
  readonly failedSessionIds: string[] = [];
  private readonly _deletedSessionIds: string[] = [];
  /** Mirrors `ClaudeAgentSdkSession.ownSessionDeleted` — makes `close()` idempotent (F3 review fix). */
  private ownSessionDeleted = false;

  constructor(
    private readonly assignedSessionId: string,
    private readonly respond: FakeAgenticTurnResponder,
    public readonly options: AgenticSessionOptions,
  ) {}

  get sessionId(): string | undefined {
    return this.ownSessionId;
  }

  get usage(): TokenUsage {
    return this.accumulatedUsage;
  }

  async *stream(prompt: string): AsyncGenerator<AgenticStreamEvent, void, undefined> {
    // Mirrors `ClaudeAgentSdkSession.stream` (T1.1): derived from a
    // *successful* session id, not a count of turns sent, so a turn that
    // fails via an `isError` script still looks like a first turn to the
    // next `stream()` call on this handle — see the id-assignment branch
    // below, which is the other half of this.
    const isFirstTurn = this.ownSessionId === undefined;

    if (!isFirstTurn && this.options.persistSession === false) {
      // Mirrors `ClaudeAgentSdkSession.stream`'s eager guard, which mirrors
      // the real CLI: a session created with `persistSession: false` was
      // never written to `~/.claude/projects/`, so a `resume` on turn 2+
      // has nothing to find. Verified live: the real error reads
      // `No conversation found with session ID: <id>` — reproduced here in
      // shape, not byte-for-byte, since this fake never talks to a CLI.
      // Keyed off `ownSessionId` rather than `turnIndex`: a first turn that
      // failed (no `ownSessionId` latched) gets to retry as a first turn
      // too, not trip this guard.
      throw new AgenticSessionError(
        `No conversation found with session ID: ${this.ownSessionId} ` +
          "(fake: this session was created with persistSession: false and cannot be resumed " +
          "for a second turn)",
      );
    }
    if (this.closed) {
      throw new AgenticSessionError(
        `session ${this.ownSessionId} was closed via close() and cannot be resumed`,
      );
    }

    this.prompts.push(prompt);
    const script = this.respond(prompt, {
      turnIndex: this.turnIndex,
      sessionId: this.ownSessionId,
    });
    this.turnIndex += 1;

    // F6 review fix: scripted `events` are yielded even when `throws` is
    // also set — see `FakeAgenticTurnScript.throws`'s doc. An empty/absent
    // `events` (the common case) makes this a no-op loop, preserving the
    // original "nothing yielded before the throw" shape exactly.
    for (const event of script.events ?? []) {
      yield event;
    }

    if (script.throws !== undefined) {
      // Mirrors the real adapter's thrown-error channel: no session id is
      // touched — a turn that failed before ever producing a `result`
      // message gives the real adapter no id to latch or track either.
      throw script.throws;
    }

    const usage = script.usage ?? ZERO_USAGE;
    const isError = script.isError ?? false;
    if (isError) {
      // Mirrors the real adapter: an error result's session id is never
      // latched into `ownSessionId` (that would make the next `stream()`
      // wrongly believe this handle has a successful session to resume),
      // but it's still tracked as something `close()` should clean up —
      // UNLESS it's this handle's own `options.resume` target (F3 review
      // fix): a resumed handle's first-turn error reasonably echoes back
      // the id it was asked to resume, and that id is the operator's
      // pre-existing transcript, not one this handle orphaned.
      if (this.assignedSessionId !== this.options.resume?.sessionId) {
        this.failedSessionIds.push(this.assignedSessionId);
      }
    } else {
      // Session reuse, faked: the id is assigned once and never changes for
      // the lifetime of this handle, matching the real adapter's contract.
      this.ownSessionId = this.assignedSessionId;
    }
    this.accumulatedUsage = addUsage(this.accumulatedUsage, usage);

    const result: AgenticTurnResult = {
      text: script.text ?? "",
      usage,
      sessionId: this.assignedSessionId,
      stopReason: script.stopReason ?? "end_turn",
      isError,
      subagentsEnabled: script.subagentsEnabled ?? false,
    };
    yield { type: "done", result };
  }

  /**
   * Mirrors `ClaudeAgentSdkSession.close`: marks the session unusable for a
   * further turn, and — unless this session was created with
   * `persistSession: false` — records which session id(s) would have been
   * deleted (this handle's own `ownSessionId`, plus any `failedSessionIds`)
   * into `deletedSessionIds`. There is no real transcript to delete offline,
   * so this is the fake's inspectable stand-in for spying on
   * `deleteSession`. Idempotent (F3 review fix): `failedSessionIds` is
   * cleared and `ownSessionDeleted` latched once ids are actually recorded,
   * so a second `close()` call finds nothing left to add.
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.options.persistSession === false) return;

    const ids = new Set(this.failedSessionIds);
    if (this.ownSessionId !== undefined && !this.ownSessionDeleted) {
      ids.add(this.ownSessionId);
    }
    if (ids.size === 0) return;

    for (const id of ids) {
      this._deletedSessionIds.push(id);
    }
    this.failedSessionIds.length = 0;
    if (this.ownSessionId !== undefined) {
      this.ownSessionDeleted = true;
    }
  }

  /** Whether `close()` has been called — for tests asserting cleanup. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Session id(s) `close()` has "deleted" so far — see `close()`'s doc. */
  get deletedSessionIds(): readonly string[] {
    return this._deletedSessionIds;
  }
}
