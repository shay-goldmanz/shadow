/**
 * T0.3 — end-to-end proof, at the HTTP handler level, that `PerBriefResearchAgent`
 * (T0.1) actually delivers its no-shared-state-across-briefs contract when
 * driven the way production traffic drives it — through two real
 * `POST /api/chat` sessions, not a direct unit-level call: two sessions that
 * both trigger research in *overlapping* turns complete successfully, and
 * neither stream ever surfaces `research_agent_busy`
 * (`ResearchAgentBusyError`, `error-mapping.ts`).
 *
 * ## Injection seam
 *
 * `test-helpers.ts`'s `withScriptedApi` builds exactly one `ShadowAgent`
 * (and therefore exactly one `researchBriefPort`) per harness/server —
 * mirroring `composition.ts`'s `buildRealApiDeps`, which also builds one
 * `ShadowAgent` for the whole running process, shared by every
 * conversation any client ever starts. `WithApiOptions.researchBriefPort`
 * is the seam this test uses to supply that single, server-wide port: two
 * `ShadowConversation`s minted from two different `POST /api/chat` calls
 * (different volumes, so chapter/publish-lock concerns never enter it)
 * both delegate into the *same* `researchBriefPort` instance, exactly as
 * they would in production.
 *
 * ## What port is actually under test
 *
 * Rather than a hand-rolled stand-in, this test constructs the seam with
 * the real `PerBriefResearchAgent` (`@shadow/research`, T0.1) — the exact
 * class `composition.ts` wires in — over a controllable underlying
 * `AgenticSessionPort` that lets the test pin down genuine overlap between
 * the two `research()` calls (waits for both sessions to have actually
 * started streaming before releasing either). Because the scripted session
 * never calls `submit_findings`, `WebResearchToolAgent.research()` settles
 * as `NoFindingsProducedError` — an ordinary, non-fatal `research-failed`
 * `ShadowEvent` (`conversation.ts`'s `runResearchDirectives` catch), which
 * reaches the client as a `research.failed` SSE event, not `error`. That
 * keeps the fixture simple while still exercising the exact code path
 * (`WebResearchToolAgent`'s instance-level `busy` flag,
 * `web-research-tool-agent.ts:166-181`) T0.1 was built to make
 * unreachable under concurrency.
 *
 * ## What this test actually pins — and what it doesn't
 *
 * This test injects the real `PerBriefResearchAgent` (T0.1) as
 * `WithApiOptions.researchBriefPort` and asserts it survives two genuinely
 * concurrent `research()` calls issued through two real HTTP sessions. That
 * pins `PerBriefResearchAgent`'s own contract — a fresh `WebResearchToolAgent`
 * per `research()` call, not one shared, `busy`-flagged instance — at the
 * handler level, exercising `conversation.ts`'s real dispatch path into
 * whatever `researchBriefPort` a caller supplies. It does **not** exercise
 * `composition.ts`: that file's wiring (which concrete class it constructs
 * for `researchBriefPort`) is never imported or invoked here, so this test
 * cannot catch a regression where `composition.ts` alone reverts to
 * constructing a single shared `WebResearchToolAgent` while
 * `PerBriefResearchAgent` itself stays correct — only a manual read of
 * `composition.ts`, or a dedicated test importing it, would catch that.
 *
 * The contract this test pins is real, though — verified by a manual
 * experiment (performed and undone while writing this test, not left in the
 * tree): replacing the `researchPort` construction below —
 *
 *   const researchPort = new PerBriefResearchAgent({ transport, evidenceStore, sessions });
 *
 * — with a single shared instance reused for both calls —
 *
 *   const researchPort = new WebResearchToolAgent({ transport, evidenceStore, sessions });
 *
 * — reproduces exactly the bug T0.1 fixes: with `PerBriefResearchAgent`
 * swapped out, `researchBriefPort.research()` is called on the *same*
 * `WebResearchToolAgent` instance for both sessions, and that instance's
 * `busy` check (`web-research-tool-agent.ts:179-181`) runs *before* it ever
 * creates a session — so session B's `research()` call never reaches
 * `ControllableResearchSessionPort.createSession` at all, it just throws
 * `ResearchAgentBusyError` synchronously into session A's still-open
 * `research()` call's `try`/`catch`. Ran exactly that swap locally: this
 * test failed — not with a caught busy-message assertion (there was no
 * second session for `waitForStart(1)` to ever observe), but by *timing
 * out* after 5s, hung forever on `await researchSessions.waitForStart(1)`,
 * which is just as decisive a failure signal as an assertion would be —
 * this test cannot pass under either failure shape a shared
 * `WebResearchToolAgent` produces (immediate busy throw, or the
 * silently-never-invoked-second-call this port's synchronous guard causes
 * here). Reverted back to `PerBriefResearchAgent` before landing.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemVolumeStore, toVolumeSlug } from "@shadow/core";
import { FileSystemEvidenceStore } from "@shadow/evidence";
import type {
  AgenticSession,
  AgenticSessionOptions,
  AgenticSessionPort,
  AgenticStreamEvent,
  AgenticTurnResult,
  FakeAgenticTurnResponder,
} from "@shadow/model";
import { ZERO_USAGE } from "@shadow/model";
import type { RetrievalTransport } from "@shadow/research";
import { PerBriefResearchAgent } from "@shadow/research";
import { readAllSseEvents, seedVolume, withScriptedApi } from "../test-helpers.ts";

/** Never called in this test — no tool ever fetches/searches, so the transport is dead weight the type system still requires. */
const unusedTransport: RetrievalTransport = {
  fetchPage() {
    throw new Error("unexpected fetchPage call in T0.3's overlap test");
  },
  search() {
    throw new Error("unexpected search call in T0.3's overlap test");
  },
};

/**
 * A controllable `AgenticSessionPort` for the underlying research sessions
 * `PerBriefResearchAgent` creates — one fresh session per `research()`
 * call (T0.1). Mirrors `ControllableResearchBriefPort`
 * (`packages/agent/src/conversation.test.ts`) one layer down: instead of
 * gating a `ResearchBriefPort` directly, this gates the *session* each
 * fresh `WebResearchToolAgent` opens, so the test can prove the two
 * underlying model turns were genuinely in flight together — `waitForStart`
 * resolves once that session's `stream()` has actually begun, independent
 * of creation order; `release` lets the test settle it whenever it wants.
 */
class ControllableResearchSessionPort implements AgenticSessionPort {
  private created = 0;
  private readonly startResolvers: (() => void)[] = [];
  private readonly startPromises: Promise<void>[] = [];
  private readonly gateResolvers: (() => void)[] = [];

  createSession(_options?: AgenticSessionOptions): AgenticSession {
    const index = this.created++;
    this.startPromises[index] = new Promise((resolve) => {
      this.startResolvers[index] = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      this.gateResolvers[index] = resolve;
    });
    const sessionId = `research-session-${index}`;
    const startResolvers = this.startResolvers;
    return {
      sessionId: undefined,
      usage: ZERO_USAGE,
      failedSessionIds: [],
      async *stream(): AsyncGenerator<AgenticStreamEvent, void, undefined> {
        startResolvers[index]?.();
        await gate; // held open until the test releases it
        const result: AgenticTurnResult = {
          text: "Nothing worth reporting this turn.",
          usage: ZERO_USAGE,
          sessionId,
          stopReason: "end_turn",
          isError: false,
          subagentsEnabled: false,
        };
        yield { type: "done", result };
      },
    };
  }

  /** Resolves once the index'th session's `stream()` has started — proof that call's underlying turn is genuinely in flight. */
  async waitForStart(index: number): Promise<void> {
    while (this.startPromises[index] === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await this.startPromises[index];
  }

  release(index: number): void {
    this.gateResolvers[index]?.();
  }

  async deleteStoredSession(): Promise<void> {}
}

async function makeThrowawayEvidenceStore(): Promise<FileSystemEvidenceStore> {
  // Never read from or written to in this test (no tool call ever fires —
  // see the module doc), but `WebResearchToolAgent`'s constructor requires
  // an `EvidenceStore` structurally. Process-lifetime tmp dir, like several
  // other throwaway harnesses in this suite — nothing is ever written into
  // it, so there is nothing worth tearing down.
  const root = await mkdtemp(join(tmpdir(), "shadow-t03-research-port-"));
  const volumeStore = new FileSystemVolumeStore(root);
  return new FileSystemEvidenceStore(volumeStore);
}

const RESEARCH_DIRECTIVE_A = [
  "Let me look into that.",
  "```shadow:research",
  JSON.stringify({ goal: "Session A's research goal", subjectDomains: ["a.test"] }),
  "```",
].join("\n");

const RESEARCH_DIRECTIVE_B = [
  "Let me look into that too.",
  "```shadow:research",
  JSON.stringify({ goal: "Session B's research goal", subjectDomains: ["b.test"] }),
  "```",
].join("\n");

describe("Chat — two sessions researching in overlapping turns share the server's one researchBriefPort without contention (T0.3)", () => {
  test("two POST /api/chat streams both complete; no research_agent_busy in either", async () => {
    const researchSessions = new ControllableResearchSessionPort();

    // The real T0.1 class, wired exactly as `composition.ts` wires it — see
    // this file's module doc for the revert-detection property this buys.
    const researchPort = new PerBriefResearchAgent({
      transport: unusedTransport,
      evidenceStore: await makeThrowawayEvidenceStore(),
      sessions: researchSessions,
    });

    // A single `FakeAgenticSessionPort` backs the whole harness (mirroring
    // one server, many conversations) — its one `respond` dispatches on the
    // operator's own message text, which each `ShadowConversation`'s prompt
    // carries verbatim (`conversation.ts` prefixes it with
    // `Operator (sourceId: ...):`, but never rewrites the message itself).
    // Each underlying `FakeAgenticSession` still tracks its own `turnIndex`
    // independently (`@shadow/model`'s `fake-agentic-session.ts`), so this
    // is exactly equivalent to two real, independently-scripted sessions.
    const respond: FakeAgenticTurnResponder = (prompt) => {
      if (prompt.includes("Operator turn A")) return { text: RESEARCH_DIRECTIVE_A };
      if (prompt.includes("Operator turn B")) return { text: RESEARCH_DIRECTIVE_B };
      // The follow-up turn after research settles, for either session.
      return { text: "Done." };
    };

    await withScriptedApi(
      { respond, researchBriefPort: researchPort },
      async ({ baseUrl, deps }) => {
        await seedVolume(deps, toVolumeSlug("volume-a"), "Volume A");
        await seedVolume(deps, toVolumeSlug("volume-b"), "Volume B");

        const resAPromise = fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ volumeSlug: "volume-a", message: "Operator turn A" }),
        });

        // Wait until session A's research() call has genuinely started its
        // underlying model turn before starting session B — otherwise "both
        // in flight" would be an accident of scheduling, not a proven
        // overlap.
        await researchSessions.waitForStart(0);

        const resBPromise = fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ volumeSlug: "volume-b", message: "Operator turn B" }),
        });

        // Session B's research() call must also start *before* session A's
        // is released — the actual overlap proof: two research() calls in
        // flight on the same researchBriefPort at once.
        await researchSessions.waitForStart(1);

        researchSessions.release(0);
        researchSessions.release(1);

        const [resA, resB] = await Promise.all([resAPromise, resBPromise]);
        expect(resA.status).toBe(200);
        expect(resB.status).toBe(200);

        const [eventsA, eventsB] = await Promise.all([
          readAllSseEvents(resA),
          readAllSseEvents(resB),
        ]);

        // --- both streams ran to completion --------------------------------
        expect(eventsA.at(-1)?.event).toBe("done");
        expect(eventsB.at(-1)?.event).toBe("done");

        // --- neither stream ever surfaced an `error` event at all — in
        // particular never `research_agent_busy`, the exact regression T0.1
        // fixed (see the module doc's revert-detection property) -----------
        expect(eventsA.some((e) => e.event === "error")).toBe(false);
        expect(eventsB.some((e) => e.event === "error")).toBe(false);
        const serialized = JSON.stringify([...eventsA, ...eventsB]);
        expect(serialized).not.toContain("research_agent_busy");
        expect(serialized.toLowerCase()).not.toContain("agent busy");

        // --- research genuinely ran (as research.failed, per this file's
        // module doc — no findings were ever submitted) on both sides, proof
        // this wasn't a no-op ------------------------------------------
        expect(eventsA.some((e) => e.event === "research.failed")).toBe(true);
        expect(eventsB.some((e) => e.event === "research.failed")).toBe(true);
      },
    );
  });
});
