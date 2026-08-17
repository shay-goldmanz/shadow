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
  /** Extra events to yield before the final `done` event (e.g. scripted `tool-use`/`tool-result`/`text-delta`). `done` is always appended automatically. */
  readonly events?: readonly AgenticStreamEvent[];
}

export type FakeAgenticTurnResponder = (
  prompt: string,
  context: { readonly turnIndex: number; readonly sessionId: string | undefined },
) => FakeAgenticTurnScript;

const defaultResponder: FakeAgenticTurnResponder = (prompt) => ({ text: `echo: ${prompt}` });

export class FakeAgenticSessionPort implements AgenticSessionPort {
  /** Every session this fake has created, in creation order — inspect in assertions. */
  readonly sessions: FakeAgenticSession[] = [];

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
   * `close()` cleans up below. Inspectable for tests that want to assert
   * on the "deletable" set directly rather than only through `close()`'s
   * side effects.
   */
  readonly failedSessionIds: string[] = [];
  private readonly _deletedSessionIds: string[] = [];

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

    for (const event of script.events ?? []) {
      yield event;
    }

    const usage = script.usage ?? ZERO_USAGE;
    const isError = script.isError ?? false;
    if (isError) {
      // Mirrors the real adapter: an error result's session id is never
      // latched into `ownSessionId` (that would make the next `stream()`
      // wrongly believe this handle has a successful session to resume),
      // but it's still tracked as something `close()` should clean up.
      this.failedSessionIds.push(this.assignedSessionId);
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
   * `deleteSession`.
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.options.persistSession === false) return;

    const ids = new Set(this.failedSessionIds);
    if (this.ownSessionId !== undefined) {
      ids.add(this.ownSessionId);
    }
    for (const id of ids) {
      this._deletedSessionIds.push(id);
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
