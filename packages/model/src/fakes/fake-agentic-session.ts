/**
 * In-memory fake for `AgenticSessionPort` — no LLM, no subprocess.
 *
 * Exported from the package's public surface (`../index.ts`) so T2.x/T3.x
 * packages can test tool-agent and chat orchestration logic offline. It
 * reproduces the one real-adapter behavior callers actually depend on:
 * a session's `sessionId` is `undefined` until the first turn, then stays
 * *stable* across every later turn sent through the same handle — the
 * observable shape of D6's session reuse, without a subprocess to reuse.
 */

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
    // Session reuse, faked: the id is assigned once and never changes for
    // the lifetime of this handle, matching the real adapter's contract.
    this.ownSessionId = this.assignedSessionId;
    this.accumulatedUsage = addUsage(this.accumulatedUsage, usage);

    const result: AgenticTurnResult = {
      text: script.text ?? "",
      usage,
      sessionId: this.assignedSessionId,
      stopReason: script.stopReason ?? "end_turn",
      isError: script.isError ?? false,
      subagentsEnabled: script.subagentsEnabled ?? false,
    };
    yield { type: "done", result };
  }
}
