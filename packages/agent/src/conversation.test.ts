/**
 * The critical path in miniature (`docs/ACCEPTANCE.md`): the operator
 * states a belief covering two topics -> Shadow forms research briefs ->
 * delegates them -> drafts two chapters with frontmatter and footnote-
 * marked claims, bound to the findings it was actually given -> both pass
 * the CoE audit -> the volume is indexed. This is the single most valuable
 * test in the package.
 *
 * Entirely offline and deterministic: `@shadow/model`'s
 * `FakeAgenticSessionPort` scripts Shadow's replies (keyed on turn index,
 * mirroring a real multi-turn exchange), and `FakeResearchBriefPort`
 * (`test-helpers.ts`) never touches the network but writes real, witnessed
 * sources into a real `FileSystemEvidenceStore` — so every `sourceId` the
 * scripted "model" cites is a real id that must actually resolve, exactly
 * as a live run would require.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toChapterSlug, toVolumeSlug, type VolumeSlug, type VolumeStore } from "@shadow/core";
import {
  type CheckWorthinessClassifier,
  type ClaimSidecar,
  FileSystemEvidenceStore,
  type SessionTranscriptWitness,
  type SourceMetadata,
  type SourceRecord,
} from "@shadow/evidence";
import type { BuildIndexResult, IndexDocument } from "@shadow/indexing";
import { StructuralIndexer } from "@shadow/indexing";
import type {
  AgenticSession,
  AgenticSessionOptions,
  AgenticSessionPort,
  FakeAgenticTurnResponder,
  RetryPolicy,
} from "@shadow/model";
import {
  AgenticSessionError,
  conservativeRetryPolicy,
  FakeAgenticSessionPort,
  failNTimesThenSucceed,
  isNoConversationFoundError,
  noConversationFoundError,
  RetryingAgenticSession,
} from "@shadow/model";
import type { Finding, ResearchBrief, ResearchBriefPort, ResearchResult } from "@shadow/research";
import { ShadowAgent, type ShadowAgentDeps, type ShadowEvent } from "./conversation.ts";
import { AutoTurnBudgetExceededError } from "./errors.ts";
import {
  alwaysNarrativeClassifier,
  expectRejection,
  FakeResearchBriefPort,
  freshIndexer,
  scriptedClaimRestater,
  scriptedEntailmentJudge,
  withVolumeHarness,
} from "./test-helpers.ts";

const OPERATOR_MESSAGE =
  "I believe in how Linear and Notion design their UI, and Epoch magazine are experts at " +
  "designing one-pagers.";

function fakeFindingsFor(brief: ResearchBrief) {
  if (brief.goal.includes("Linear and Notion")) {
    return [
      { text: "Linear renders its sidebar on a 4px spacing scale.", quote: "a 4px spacing scale" },
      {
        text: "Notion leans on generous whitespace rather than a strict grid.",
        quote: "generous whitespace rather than a strict grid",
      },
    ];
  }
  if (brief.goal.includes("Epoch")) {
    return [
      {
        text: "Epoch favors one big idea per page, set in large type.",
        quote: "one big idea per page, set in large type",
      },
    ];
  }
  throw new Error(`unexpected research goal in test: ${brief.goal}`);
}

function requireFinding(findings: readonly Finding[], index: number): Finding {
  const finding = findings[index];
  if (!finding) throw new Error(`expected finding at index ${index}`);
  return finding;
}

/**
 * Scripts Shadow's three-turn reply, reading real research results and the
 * real operator-turn sourceId back out of state captured on earlier turns —
 * exactly what a real model would do by reading its own context, just
 * without an actual model in the loop.
 */
function buildResponder(research: FakeResearchBriefPort): {
  readonly respond: FakeAgenticTurnResponder;
  operatorSourceId: string | undefined;
} {
  const state = { operatorSourceId: undefined as string | undefined };

  const respond: FakeAgenticTurnResponder = (prompt, context) => {
    if (context.turnIndex === 0) {
      const match = /Operator \(sourceId: (\S+)\):/.exec(prompt);
      state.operatorSourceId = match?.[1];
      return {
        text: [
          "Let me look into both of those before writing anything.",
          "```shadow:research",
          JSON.stringify({
            goal: "How do Linear and Notion design their UI?",
            subjectDomains: ["linear.app", "notion.so"],
            maxSources: 2,
          }),
          "```",
          "```shadow:research",
          JSON.stringify({
            goal: "How does Epoch magazine design one-pagers?",
            subjectDomains: ["epoch.com"],
            maxSources: 1,
          }),
          "```",
        ].join("\n"),
      };
    }

    if (context.turnIndex === 1) {
      const [uiResult, epochResult] = research.results as [ResearchResult, ResearchResult];
      const linFinding = requireFinding(uiResult.findings, 0);
      const notionFinding = requireFinding(uiResult.findings, 1);
      const epochFinding = requireFinding(epochResult.findings, 0);
      const operatorSourceId = state.operatorSourceId;
      if (!operatorSourceId) throw new Error("operator sourceId was never captured on turn 0");

      const uiChapter = {
        slug: "how-linear-and-notion-design-ui",
        title: "How Linear and Notion design their UI",
        body: [
          `${linFinding.text}[^lin-density]`,
          `${notionFinding.text}[^notion-ws]`,
          "Both treat spacing as a systemic constraint rather than a per-screen decision.[^=derived-systemic]",
          "The operator believes in how Linear and Notion design their UI.[^~op-belief]",
        ].join(" "),
        frontmatter: {
          when_to_use: "Designing dense, information-rich UI: dashboards, tables, list views.",
          not_for: "marketing pages, one-pagers",
          keywords: ["Linear", "Notion", "density", "UI"],
          confidence: "high",
        },
        claims: [
          {
            label: "lin-density",
            kind: "sourced",
            text: linFinding.text,
            evidence: [
              {
                sourceId: linFinding.citations[0]?.sourceId,
                quote: linFinding.citations[0]?.quote,
              },
            ],
          },
          {
            label: "notion-ws",
            kind: "sourced",
            text: notionFinding.text,
            evidence: [
              {
                sourceId: notionFinding.citations[0]?.sourceId,
                quote: notionFinding.citations[0]?.quote,
              },
            ],
          },
          {
            label: "derived-systemic",
            kind: "derived",
            text: "Both treat spacing as a systemic constraint rather than a per-screen decision.",
            supports: ["lin-density", "notion-ws"],
          },
          {
            label: "op-belief",
            kind: "operator",
            text: "The operator believes in how Linear and Notion design their UI.",
            evidence: [{ sourceId: operatorSourceId, quote: OPERATOR_MESSAGE }],
          },
        ],
      };

      const epochChapter = {
        slug: "epoch-one-pagers",
        title: "How Epoch designs one-pagers",
        body: `${epochFinding.text}[^epoch-onepager]`,
        frontmatter: {
          when_to_use: "Designing a one-pager: a single dense, high-impact page.",
          not_for: "multi-page documents, long-form writing",
          keywords: ["Epoch", "one-pager"],
          confidence: "high",
        },
        claims: [
          {
            label: "epoch-onepager",
            kind: "sourced",
            text: epochFinding.text,
            evidence: [
              {
                sourceId: epochFinding.citations[0]?.sourceId,
                quote: epochFinding.citations[0]?.quote,
              },
            ],
          },
        ],
      };

      return {
        text: [
          "Drafting both chapters now.",
          "```shadow:chapter",
          JSON.stringify(uiChapter),
          "```",
          "```shadow:chapter",
          JSON.stringify(epochChapter),
          "```",
        ].join("\n"),
      };
    }

    return { text: "Done — I've added two chapters to the volume." };
  };

  return {
    respond,
    get operatorSourceId() {
      return state.operatorSourceId;
    },
  };
}

async function withSessionCwd<T>(fn: (sessionCwd: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "shadow-agent-session-cwd-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A `ResearchBriefPort` a test drives by hand: `research()` never resolves
 * on its own — each call's outcome is settled later via `resolveCall`/
 * `rejectCall`, by call index (0-based, in the order `research()` was
 * actually invoked). `waitForCall` lets a test await "this call has
 * happened" without guessing at microtask timing, so tests can pin down
 * settle order (T0.2) precisely: resolve/reject calls in whatever order the
 * test wants, independent of call order.
 */
class ControllableResearchBriefPort implements ResearchBriefPort {
  readonly calls: ResearchBrief[] = [];
  private readonly deferreds: {
    resolve: (result: ResearchResult) => void;
    reject: (error: unknown) => void;
  }[] = [];
  private readonly callSignals: (() => void)[] = [];

  research(brief: ResearchBrief): Promise<ResearchResult> {
    const index = this.calls.length;
    this.calls.push(brief);
    const promise = new Promise<ResearchResult>((resolve, reject) => {
      this.deferreds[index] = { resolve, reject };
    });
    this.callSignals[index]?.();
    return promise;
  }

  async waitForCall(index: number): Promise<void> {
    if (this.calls[index]) return;
    await new Promise<void>((resolve) => {
      this.callSignals[index] = resolve;
    });
  }

  resolveCall(index: number, result: ResearchResult): void {
    this.deferreds[index]?.resolve(result);
  }

  rejectCall(index: number, error: unknown): void {
    this.deferreds[index]?.reject(error);
  }
}

function emptyResult(): ResearchResult {
  return { findings: [], sources: [] };
}

describe("ShadowConversation — critical path", () => {
  test("operator states a two-topic belief -> Shadow researches, drafts two chapters, both pass audit, volume is indexed", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume, root }) => {
      await withSessionCwd(async (sessionCwd) => {
        const research = new FakeResearchBriefPort(evidenceStore, (brief) =>
          fakeFindingsFor(brief),
        );
        const { respond } = buildResponder(research);
        const sessions = new FakeAgenticSessionPort(respond);

        const deps: ShadowAgentDeps = {
          agenticSessionPort: sessions,
          researchBriefPort: research,
          volumeStore,
          evidenceStore,
          indexer: freshIndexer(root),
          checkWorthinessClassifier: alwaysNarrativeClassifier,
          entailmentRelevanceJudge: scriptedEntailmentJudge(),
          claimRestater: scriptedClaimRestater(() => {
            throw new Error("no claim should need repair on the happy path");
          }),
          sessionCwd,
        };

        const agent = new ShadowAgent(deps);
        const conversation = agent.startConversation(volume);

        const events: ShadowEvent[] = [];
        for await (const event of conversation.sendMessage(OPERATOR_MESSAGE)) {
          events.push(event);
        }

        // --- delegation, not fetching ------------------------------------
        expect(research.briefs).toHaveLength(2);
        expect(research.briefs[0]?.goal).toContain("Linear and Notion");
        expect(research.briefs[1]?.goal).toContain("Epoch");

        const researchStarted = events.filter((e) => e.type === "research-started");
        const researchCompleted = events.filter((e) => e.type === "research-completed");
        expect(researchStarted).toHaveLength(2);
        expect(researchCompleted).toHaveLength(2);

        // --- both chapters drafted, audited, and published ----------------
        const published = events.filter((e) => e.type === "chapter-published");
        expect(published).toHaveLength(2);
        expect(published.map((e) => (e as { chapter: string }).chapter).toSorted()).toEqual(
          ["epoch-one-pagers", "how-linear-and-notion-design-ui"].toSorted(),
        );
        expect(events.some((e) => e.type === "chapter-rejected")).toBe(false);
        expect(events.some((e) => e.type === "error")).toBe(false);

        // --- frontmatter + footnote-marked claims persisted ----------------
        const uiChapter = await volumeStore.getChapter(
          volume,
          toChapterSlug("how-linear-and-notion-design-ui"),
        );
        expect(uiChapter.frontmatter.when_to_use).toContain("Designing dense");
        expect(uiChapter.body).toContain("[^lin-density]");
        expect(uiChapter.body).toContain("[^=derived-systemic]");
        expect(uiChapter.body).toContain("[^~op-belief]");

        const uiSidecar = await evidenceStore.getClaims(
          volume,
          toChapterSlug("how-linear-and-notion-design-ui"),
        );
        expect(uiSidecar?.claims).toHaveLength(4);

        // --- operator belief cites the transcript (D19) --------------------
        const operatorClaim = uiSidecar?.claims.find((c) => c.kind === "operator");
        expect(operatorClaim).toBeDefined();
        const operatorEvidence = operatorClaim?.evidence[0];
        expect(operatorEvidence).toBeDefined();
        const operatorSource = await evidenceStore.getSource(volume, operatorEvidence!.sourceId);
        expect(operatorSource.retrieval.transport).toBe("session");
        expect(operatorSource.url).toContain("session:");

        // --- audit actually ran and passed ----------------------------------
        const uiAudit = await evidenceStore.getAudit(
          volume,
          toChapterSlug("how-linear-and-notion-design-ui"),
        );
        expect(uiAudit?.verdict.passed).toBe(true);
        const epochAudit = await evidenceStore.getAudit(volume, toChapterSlug("epoch-one-pagers"));
        expect(epochAudit?.verdict.passed).toBe(true);

        // --- reindexed: both chapters visible in the corpus index ----------
        const corpusIndex = (await volumeStore.readCorpusIndex()) as IndexDocument | undefined;
        expect(corpusIndex).toBeDefined();
        const chapterSlugs = corpusIndex?.volumes
          .flatMap((v) => v.chapters)
          .map((c) => c.slug)
          .toSorted();
        expect(chapterSlugs).toEqual(["epoch-one-pagers", "how-linear-and-notion-design-ui"]);

        // --- session reuse across turns (D6) --------------------------------
        expect(sessions.sessions).toHaveLength(1);
        expect(sessions.sessions[0]?.prompts.length).toBeGreaterThanOrEqual(3);
        expect(conversation.sessionId).toBe(sessions.sessions[0]?.sessionId);

        // --- session configuration: no tools, skill-guided (see module docs) --
        const options = sessions.sessions[0]?.options as AgenticSessionOptions;
        expect(options.allowedTools).toEqual(["Skill"]);
        expect(options.disallowedTools).toContain("WebFetch");
        expect(options.disallowedTools).toContain("WebSearch");
        expect(options.disallowedTools).toContain("Bash");
        expect(options.skills).toEqual(["shadow-write-volumes"]);
        expect(options.settingSources).toEqual(["project"]);
        expect(options.cwd).toBe(sessionCwd);
      });
    });
  });
});

describe("ShadowConversation — a conversational reply with no directives ends the exchange", () => {
  test("no research/chapter directives -> a single turn, no auto-continuation", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume, root }) => {
      await withSessionCwd(async (sessionCwd) => {
        const research = new FakeResearchBriefPort(evidenceStore, () => {
          throw new Error("should not be called");
        });
        const sessions = new FakeAgenticSessionPort(() => ({ text: "Nice to meet you too!" }));

        const deps: ShadowAgentDeps = {
          agenticSessionPort: sessions,
          researchBriefPort: research,
          volumeStore,
          evidenceStore,
          indexer: freshIndexer(root),
          checkWorthinessClassifier: alwaysNarrativeClassifier,
          entailmentRelevanceJudge: scriptedEntailmentJudge(),
          claimRestater: scriptedClaimRestater(() => {
            throw new Error("should not be called");
          }),
          sessionCwd,
        };

        const agent = new ShadowAgent(deps);
        const conversation = agent.startConversation(volume);

        const events: ShadowEvent[] = [];
        for await (const event of conversation.sendMessage("Hello Shadow!")) {
          events.push(event);
        }

        expect(sessions.sessions).toHaveLength(1);
        expect(sessions.sessions[0]?.prompts).toHaveLength(1);
        expect(events.some((e) => e.type === "chapter-published")).toBe(false);
        expect(events.some((e) => e.type === "research-started")).toBe(false);
      });
    });
  });
});

describe("ShadowConversation — a second sendMessage reuses the same session (D6)", () => {
  test("two operator turns share one AgenticSession handle", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume, root }) => {
      await withSessionCwd(async (sessionCwd) => {
        const research = new FakeResearchBriefPort(evidenceStore, () => []);
        const sessions = new FakeAgenticSessionPort(() => ({ text: "Got it." }));

        const deps: ShadowAgentDeps = {
          agenticSessionPort: sessions,
          researchBriefPort: research,
          volumeStore,
          evidenceStore,
          indexer: freshIndexer(root),
          checkWorthinessClassifier: alwaysNarrativeClassifier,
          entailmentRelevanceJudge: scriptedEntailmentJudge(),
          claimRestater: scriptedClaimRestater(() => {
            throw new Error("should not be called");
          }),
          sessionCwd,
        };

        const agent = new ShadowAgent(deps);
        const conversation = agent.startConversation(volume);

        const firstTurnEvents: ShadowEvent[] = [];
        for await (const event of conversation.sendMessage("First message.")) {
          firstTurnEvents.push(event);
        }
        const secondTurnEvents: ShadowEvent[] = [];
        for await (const event of conversation.sendMessage("Second message.")) {
          secondTurnEvents.push(event);
        }
        expect(firstTurnEvents.length).toBeGreaterThan(0);
        expect(secondTurnEvents.length).toBeGreaterThan(0);

        expect(sessions.sessions).toHaveLength(1);
        expect(sessions.sessions[0]?.prompts).toHaveLength(2);
        // The regression this guards: a session created with
        // `persistSession: false` cannot be resumed at all — `@shadow/model`'s
        // `FakeAgenticSessionPort` now throws on a second turn through such a
        // handle (mirroring the real adapter/SDK), so this whole test would
        // fail with an uncaught rejection if `getOrCreateSession` ever
        // reintroduces that flag. Assert the intent directly too.
        expect(sessions.sessions[0]?.options.persistSession).not.toBe(false);

        // T2.4: release() drops the handle but must not delete the SDK
        // transcript — the regression this guards is the old `dispose()`
        // behavior (called `AgenticSession.close()`, which deletes) coming
        // back under the new name. `isClosed` staying `false` proves
        // `close()` was never reached; `sessionId` going back to
        // `undefined` proves the underlying handle really was dropped, not
        // just left alone.
        expect(conversation.sessionId).toBe(sessions.sessions[0]?.sessionId);
        await conversation.release();
        expect(sessions.sessions[0]?.isClosed).toBe(false);
        expect(conversation.sessionId).toBeUndefined();
      });
    });
  });
});

// -----------------------------------------------------------------------
// F7 review fix (T3.1) — a failed FIRST turn's SDK session id surfaces via
// `failedSdkSessionIds`, not just silently latched-and-lost.
// -----------------------------------------------------------------------

describe("ShadowConversation — failedSdkSessionIds surfaces a failed first turn's id (F7 review fix, T3.1)", () => {
  test("a first turn that fails via an isError result exposes its (unlatched) session id via failedSdkSessionIds", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume, root }) => {
      await withSessionCwd(async (sessionCwd) => {
        const research = new FakeResearchBriefPort(evidenceStore, () => []);
        const sessions = new FakeAgenticSessionPort(() => ({
          isError: true,
          stopReason: "overloaded",
        }));

        const deps: ShadowAgentDeps = {
          agenticSessionPort: sessions,
          researchBriefPort: research,
          volumeStore,
          evidenceStore,
          indexer: freshIndexer(root),
          checkWorthinessClassifier: alwaysNarrativeClassifier,
          entailmentRelevanceJudge: scriptedEntailmentJudge(),
          claimRestater: scriptedClaimRestater(() => {
            throw new Error("should not be called");
          }),
          sessionCwd,
        };

        const agent = new ShadowAgent(deps);
        const conversation = agent.startConversation(volume);

        // Nothing yet — no turn has run.
        expect(conversation.failedSdkSessionIds).toEqual([]);

        const events: ShadowEvent[] = [];
        for await (const event of conversation.sendMessage("First message.")) {
          events.push(event);
        }
        expect(events.some((e) => e.type === "error")).toBe(true);

        // `sessionId` (the successful-turn id) stays undefined — T1.1's
        // first-turn derivation — but the failed turn's id is still
        // reachable through this getter, mirroring the underlying fake
        // session's own `failedSessionIds`.
        expect(conversation.sessionId).toBeUndefined();
        const underlying = sessions.sessions[0];
        if (!underlying) throw new Error("expected a fake session to have been created");
        expect(underlying.failedSessionIds).toHaveLength(1);
        expect(conversation.failedSdkSessionIds).toEqual(underlying.failedSessionIds);
      });
    });
  });
});

// -----------------------------------------------------------------------
// T0.2 — research directives run concurrently within a turn.
// -----------------------------------------------------------------------

const TWO_DIRECTIVE_REPLY = [
  "Looking into both.",
  "```shadow:research",
  JSON.stringify({ goal: "Directive A goal", subjectDomains: ["a.test"] }),
  "```",
  "```shadow:research",
  JSON.stringify({ goal: "Directive B goal", subjectDomains: ["b.test"] }),
  "```",
].join("\n");

describe("ShadowConversation — parallel research briefs (T0.2)", () => {
  test("brief B settling before brief A -> completion events yield in settle order, but followUps stay in directive order", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume, root }) => {
      await withSessionCwd(async (sessionCwd) => {
        const research = new ControllableResearchBriefPort();

        const respond: FakeAgenticTurnResponder = (_prompt, context) =>
          context.turnIndex === 0
            ? { text: TWO_DIRECTIVE_REPLY }
            : { text: "Both findings look good, nothing more to research." };
        const sessions = new FakeAgenticSessionPort(respond);

        const deps: ShadowAgentDeps = {
          agenticSessionPort: sessions,
          researchBriefPort: research,
          volumeStore,
          evidenceStore,
          indexer: freshIndexer(root),
          checkWorthinessClassifier: alwaysNarrativeClassifier,
          entailmentRelevanceJudge: scriptedEntailmentJudge(),
          claimRestater: scriptedClaimRestater(() => {
            throw new Error("should not be called");
          }),
          sessionCwd,
        };

        const agent = new ShadowAgent(deps);
        const conversation = agent.startConversation(volume);

        const events: ShadowEvent[] = [];
        const drained = (async () => {
          for await (const event of conversation.sendMessage("Look into A and B.")) {
            events.push(event);
          }
        })();

        // Both `research()` calls happen before either settles — proof the
        // two briefs are genuinely in flight together, not one waiting on
        // the other.
        await research.waitForCall(0);
        await research.waitForCall(1);
        expect(research.calls[0]?.goal).toBe("Directive A goal");
        expect(research.calls[1]?.goal).toBe("Directive B goal");

        // Settle brief B (directive index 1) before brief A (directive
        // index 0) — the opposite of directive order.
        research.resolveCall(1, emptyResult());
        research.resolveCall(0, emptyResult());

        await drained;

        // --- research-started fires for both, up front, in directive order
        const started = events.filter((e) => e.type === "research-started");
        expect(started.map((e) => (e as { brief: ResearchBrief }).brief.goal)).toEqual([
          "Directive A goal",
          "Directive B goal",
        ]);

        // --- completion events observed in *settle* order: B, then A -----
        const completed = events.filter((e) => e.type === "research-completed");
        expect(completed.map((e) => (e as { brief: ResearchBrief }).brief.goal)).toEqual([
          "Directive B goal",
          "Directive A goal",
        ]);

        // --- but the next turn's prompt (followUps) is in *directive*
        // order: A's findings text appears before B's, regardless of which
        // settled first -----------------------------------------------------
        const followUpPrompt = sessions.sessions[0]?.prompts[1] ?? "";
        const indexOfA = followUpPrompt.indexOf("Directive A goal");
        const indexOfB = followUpPrompt.indexOf("Directive B goal");
        expect(indexOfA).toBeGreaterThanOrEqual(0);
        expect(indexOfB).toBeGreaterThanOrEqual(0);
        expect(indexOfA).toBeLessThan(indexOfB);
      });
    });
  });

  test("one brief failing does not sink the other — it gets its own research-failed event/followUp, siblings complete normally", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume, root }) => {
      await withSessionCwd(async (sessionCwd) => {
        const research = new ControllableResearchBriefPort();

        const respond: FakeAgenticTurnResponder = (_prompt, context) =>
          context.turnIndex === 0
            ? { text: TWO_DIRECTIVE_REPLY }
            : { text: "Noted — one failed, one didn't." };
        const sessions = new FakeAgenticSessionPort(respond);

        const deps: ShadowAgentDeps = {
          agenticSessionPort: sessions,
          researchBriefPort: research,
          volumeStore,
          evidenceStore,
          indexer: freshIndexer(root),
          checkWorthinessClassifier: alwaysNarrativeClassifier,
          entailmentRelevanceJudge: scriptedEntailmentJudge(),
          claimRestater: scriptedClaimRestater(() => {
            throw new Error("should not be called");
          }),
          sessionCwd,
        };

        const agent = new ShadowAgent(deps);
        const conversation = agent.startConversation(volume);

        const events: ShadowEvent[] = [];
        const drained = (async () => {
          for await (const event of conversation.sendMessage("Look into A and B.")) {
            events.push(event);
          }
        })();

        await research.waitForCall(0);
        await research.waitForCall(1);

        // Directive A's brief fails; directive B's succeeds.
        research.rejectCall(0, new Error("the web is down"));
        research.resolveCall(1, emptyResult());

        await drained;

        expect(events.some((e) => e.type === "error")).toBe(false);

        const failed = events.filter((e) => e.type === "research-failed");
        expect(failed).toHaveLength(1);
        expect((failed[0] as { brief: ResearchBrief }).brief.goal).toBe("Directive A goal");
        expect((failed[0] as { error: string }).error).toBe("the web is down");

        const completed = events.filter((e) => e.type === "research-completed");
        expect(completed).toHaveLength(1);
        expect((completed[0] as { brief: ResearchBrief }).brief.goal).toBe("Directive B goal");

        // followUps for both, in directive order: A's failure text first,
        // then B's findings text.
        const followUpPrompt = sessions.sessions[0]?.prompts[1] ?? "";
        expect(followUpPrompt).toContain(
          'Research brief "Directive A goal" failed: the web is down',
        );
        expect(followUpPrompt).toContain('Research findings for "Directive B goal"');
        expect(followUpPrompt.indexOf("Directive A goal")).toBeLessThan(
          followUpPrompt.indexOf("Directive B goal"),
        );
      });
    });
  });
});

describe("ShadowConversation — maxAutoTurns budget is unchanged by parallel research (T0.2)", () => {
  test("a model that keeps issuing a research directive every turn exhausts the budget and throws", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume, root }) => {
      await withSessionCwd(async (sessionCwd) => {
        const research = new FakeResearchBriefPort(evidenceStore, () => []);
        const respond: FakeAgenticTurnResponder = () => ({
          text: [
            "Still looking.",
            "```shadow:research",
            JSON.stringify({ goal: "Keep researching forever", subjectDomains: ["loop.test"] }),
            "```",
          ].join("\n"),
        });
        const sessions = new FakeAgenticSessionPort(respond);

        const deps: ShadowAgentDeps = {
          agenticSessionPort: sessions,
          researchBriefPort: research,
          volumeStore,
          evidenceStore,
          indexer: freshIndexer(root),
          checkWorthinessClassifier: alwaysNarrativeClassifier,
          entailmentRelevanceJudge: scriptedEntailmentJudge(),
          claimRestater: scriptedClaimRestater(() => {
            throw new Error("should not be called");
          }),
          sessionCwd,
          maxAutoTurns: 2,
        };

        const agent = new ShadowAgent(deps);
        const conversation = agent.startConversation(volume);

        await expectRejection(
          (async () => {
            for await (const _event of conversation.sendMessage("Investigate forever.")) {
              // drain — the budget-exceeded error is thrown out of the generator
            }
          })(),
          AutoTurnBudgetExceededError,
        );

        // One prompt per turn, exactly `maxAutoTurns` of them, before the
        // loop gives up rather than continuing indefinitely.
        expect(sessions.sessions[0]?.prompts).toHaveLength(2);
      });
    });
  });
});

// -----------------------------------------------------------------------
// T0.6 — per-volume chapter publication is serialized across conversations
// minted by the same `ShadowAgent`; different volumes are not.
// -----------------------------------------------------------------------

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface ProbeEvent {
  readonly chapter: string;
  readonly phase: "enter" | "exit";
  readonly ts: number;
}

interface GateSpec {
  readonly onEnter?: () => void;
  readonly gate: Promise<void>;
}

/**
 * Wraps a real `FileSystemEvidenceStore`'s `putClaims` — the sidecar
 * read-modify-write + retirement-append hotspot both `chapter-draft.ts` and
 * `publish.ts` write through (`@shadow/evidence`'s `store.ts`, roughly
 * `:258-290`) — with an events log and an optional one-shot gate per chapter
 * slug. This is the "instrumented fake store" T0.6's plan entry calls for,
 * built by subclassing the real store so every recorded write is a genuine
 * filesystem write, not a stand-in for one.
 */
class ProbeEvidenceStore extends FileSystemEvidenceStore {
  readonly events: ProbeEvent[] = [];
  private readonly gates = new Map<
    string,
    { readonly callIndex: number; readonly spec: GateSpec }
  >();
  private readonly callCounts = new Map<string, number>();

  /**
   * Gates the `callIndex`-th `putClaims` call for `chapter` (0-based;
   * `callIndex` 0 is `draftChapter`'s persist, `callIndex` 1 is
   * `publishChapter`'s post-audit persist on the happy path with no
   * repairs). Fires `spec.onEnter` (if given) — proof this store has
   * actually reached that call — then awaits `spec.gate` before the real
   * write happens. One-shot per `chapter`: consumed once its call is
   * reached.
   */
  gatePutClaims(chapter: string, spec: GateSpec, callIndex = 0): void {
    this.gates.set(chapter, { callIndex, spec });
  }

  /** Back-compat alias for `gatePutClaims(chapter, spec, 0)` — the very next call. */
  gateNextPutClaims(chapter: string, spec: GateSpec): void {
    this.gatePutClaims(chapter, spec, 0);
  }

  override async putClaims(volume: VolumeSlug, sidecar: ClaimSidecar): Promise<void> {
    const chapter = sidecar.chapter;
    this.events.push({ chapter, phase: "enter", ts: Date.now() });
    const seen = this.callCounts.get(chapter) ?? 0;
    this.callCounts.set(chapter, seen + 1);
    const pending = this.gates.get(chapter);
    if (pending && pending.callIndex === seen) {
      this.gates.delete(chapter);
      pending.spec.onEnter?.();
      await pending.spec.gate;
    }
    await super.putClaims(volume, sidecar);
    this.events.push({ chapter, phase: "exit", ts: Date.now() });
  }
}

interface ChapterMarkerSpec {
  readonly marker: string;
  readonly slug: string;
  readonly operatorText: string;
}

/**
 * Scripts a one-turn chapter-directive reply for whichever `spec` in
 * `specs` has its `marker` in the prompt, citing the operator's own
 * recorded turn (extracted from the prompt, same trick `buildResponder`
 * above uses) as a single `operator`-kind claim. A prompt matching no spec
 * — i.e. the follow-up turn after a chapter directive already ran — gets a
 * plain no-directive reply, ending that conversation's auto-continuation.
 */
function chapterOnMarkerResponder(specs: readonly ChapterMarkerSpec[]): FakeAgenticTurnResponder {
  return (prompt) => {
    for (const spec of specs) {
      if (!prompt.includes(spec.marker)) continue;
      const match = /Operator \(sourceId: (\S+)\):/.exec(prompt);
      const sourceId = match?.[1];
      if (!sourceId) throw new Error(`operator sourceId missing from prompt for "${spec.slug}"`);
      const chapter = {
        slug: spec.slug,
        title: `Chapter about ${spec.slug}`,
        // `[^~label]` (not bare `[^label]`) is the operator-kind marker
        // (`system-prompt.ts`) — a bare marker implies `kind: "sourced"` and
        // fails C1a's marker/kind cross-check for an `"operator"` claim.
        body: `This chapter is about ${spec.slug}.[^~belief]`,
        claims: [
          {
            label: "belief",
            kind: "operator",
            text: `This chapter is about ${spec.slug}.`,
            evidence: [{ sourceId, quote: spec.operatorText }],
          },
        ],
      };
      return {
        text: ["Drafting.", "```shadow:chapter", JSON.stringify(chapter), "```"].join("\n"),
      };
    }
    return { text: "Done." };
  };
}

const LOCK_TEST_ALPHA: ChapterMarkerSpec = {
  marker: "ALPHA-DIRECTIVE",
  slug: "chapter-alpha",
  operatorText: "ALPHA-DIRECTIVE: the operator's belief about alpha.",
};
const LOCK_TEST_BETA: ChapterMarkerSpec = {
  marker: "BETA-DIRECTIVE",
  slug: "chapter-beta",
  operatorText: "BETA-DIRECTIVE: the operator's belief about beta.",
};

describe("ShadowConversation — same-volume chapter publication is serialized across conversations (T0.6)", () => {
  test("two conversations from one ShadowAgent submit chapter directives on the same volume concurrently -> publications never overlap", async () => {
    await withVolumeHarness(async ({ volumeStore, volume, root }) => {
      await withSessionCwd(async (sessionCwd) => {
        const probeStore = new ProbeEvidenceStore(volumeStore);
        const research = new FakeResearchBriefPort(probeStore, () => {
          throw new Error("no research directive expected in this test");
        });
        const sessions = new FakeAgenticSessionPort(
          chapterOnMarkerResponder([LOCK_TEST_ALPHA, LOCK_TEST_BETA]),
        );

        const deps: ShadowAgentDeps = {
          agenticSessionPort: sessions,
          researchBriefPort: research,
          volumeStore,
          evidenceStore: probeStore,
          indexer: freshIndexer(root),
          checkWorthinessClassifier: alwaysNarrativeClassifier,
          entailmentRelevanceJudge: scriptedEntailmentJudge(),
          claimRestater: scriptedClaimRestater(() => {
            throw new Error("no claim should need repair in this test");
          }),
          sessionCwd,
        };

        // ONE ShadowAgent, two conversations -- exactly the seam T0.6 fixes:
        // both conversations share this agent's one VolumeLocks instance.
        const agent = new ShadowAgent(deps);
        const convA = agent.startConversation(volume);
        const convB = agent.startConversation(volume);

        const entered = deferred();
        const release = deferred();
        // Gate conv A's *draft-time* putClaims write -- the first call for
        // its slug -- so conv A is provably still holding the volume lock
        // (mid-publish) while we try to run conv B against the same volume.
        probeStore.gateNextPutClaims(LOCK_TEST_ALPHA.slug, {
          onEnter: () => entered.resolve(),
          gate: release.promise,
        });

        const eventsA: ShadowEvent[] = [];
        const drainedA = (async () => {
          for await (const event of convA.sendMessage(LOCK_TEST_ALPHA.operatorText)) {
            eventsA.push(event);
          }
        })();

        await entered.promise; // conv A is now inside its gated write, lock held

        const eventsB: ShadowEvent[] = [];
        const drainedB = (async () => {
          for await (const event of convB.sendMessage(LOCK_TEST_BETA.operatorText)) {
            eventsB.push(event);
          }
        })();

        // Give conv B every real opportunity to run if it weren't actually
        // locked out -- these are small local filesystem writes, they
        // settle in well under this window if nothing is blocking them.
        await Bun.sleep(50);
        expect(probeStore.events.some((e) => e.chapter === LOCK_TEST_BETA.slug)).toBe(false);

        release.resolve();
        await Promise.all([drainedA, drainedB]);

        expect(eventsA.some((e) => e.type === "chapter-published")).toBe(true);
        expect(eventsB.some((e) => e.type === "chapter-published")).toBe(true);
        expect(eventsA.some((e) => e.type === "error" || e.type === "chapter-rejected")).toBe(
          false,
        );
        expect(eventsB.some((e) => e.type === "error" || e.type === "chapter-rejected")).toBe(
          false,
        );

        // Belt-and-suspenders on the recorded log itself: every one of conv
        // A's putClaims calls (draft + publish) finished before conv B's
        // first one started -- the two publications' critical sections
        // never overlap.
        const aExits = probeStore.events.filter(
          (e) => e.chapter === LOCK_TEST_ALPHA.slug && e.phase === "exit",
        );
        const bEnters = probeStore.events.filter(
          (e) => e.chapter === LOCK_TEST_BETA.slug && e.phase === "enter",
        );
        expect(aExits.length).toBeGreaterThan(0);
        expect(bEnters.length).toBeGreaterThan(0);
        const lastAExit = Math.max(...aExits.map((e) => e.ts));
        const firstBEnter = Math.min(...bEnters.map((e) => e.ts));
        expect(firstBEnter).toBeGreaterThanOrEqual(lastAExit);
      });
    });
  });
});

describe("ShadowConversation — different volumes are not serialized against each other (T0.6)", () => {
  test("a conversation on volume two publishes without waiting on volume one's in-flight publication", async () => {
    await withVolumeHarness(async ({ volumeStore, volume: volumeOne, root }) => {
      await withSessionCwd(async (sessionCwd) => {
        const volumeTwo = toVolumeSlug("second-volume");
        await volumeStore.createVolume({ slug: volumeTwo, title: "Second Volume" });

        const probeStore = new ProbeEvidenceStore(volumeStore);
        const research = new FakeResearchBriefPort(probeStore, () => {
          throw new Error("no research directive expected in this test");
        });
        const sessions = new FakeAgenticSessionPort(
          chapterOnMarkerResponder([LOCK_TEST_ALPHA, LOCK_TEST_BETA]),
        );

        const deps: ShadowAgentDeps = {
          agenticSessionPort: sessions,
          researchBriefPort: research,
          volumeStore,
          evidenceStore: probeStore,
          indexer: freshIndexer(root),
          checkWorthinessClassifier: alwaysNarrativeClassifier,
          entailmentRelevanceJudge: scriptedEntailmentJudge(),
          claimRestater: scriptedClaimRestater(() => {
            throw new Error("no claim should need repair in this test");
          }),
          sessionCwd,
        };

        const agent = new ShadowAgent(deps);
        const convOne = agent.startConversation(volumeOne);
        const convTwo = agent.startConversation(volumeTwo);

        const entered = deferred();
        const release = deferred();
        // Gate volume one's publication mid-flight and deliberately do NOT
        // release it until after volume two's has already finished -- if
        // the lock were global instead of per-volume, volume two's
        // `sendMessage` below would never resolve and this test would time
        // out rather than false-pass.
        probeStore.gateNextPutClaims(LOCK_TEST_ALPHA.slug, {
          onEnter: () => entered.resolve(),
          gate: release.promise,
        });

        const eventsOne: ShadowEvent[] = [];
        const drainedOne = (async () => {
          for await (const event of convOne.sendMessage(LOCK_TEST_ALPHA.operatorText)) {
            eventsOne.push(event);
          }
        })();

        await entered.promise; // volume one's publication is now blocked mid-flight

        const eventsTwo: ShadowEvent[] = [];
        for await (const event of convTwo.sendMessage(LOCK_TEST_BETA.operatorText)) {
          eventsTwo.push(event);
        }

        expect(eventsTwo.some((e) => e.type === "chapter-published")).toBe(true);
        // Proof it's real, not incidental: volume two's write already
        // happened while volume one is still parked on its unreleased gate.
        expect(
          probeStore.events.some((e) => e.chapter === LOCK_TEST_BETA.slug && e.phase === "exit"),
        ).toBe(true);

        release.resolve();
        await drainedOne;
        expect(eventsOne.some((e) => e.type === "chapter-published")).toBe(true);
      });
    });
  });
});

// -----------------------------------------------------------------------
// F1 — reindex is serialized corpus-wide across different volumes; draft
// and audit for those same volumes still run in parallel.
// -----------------------------------------------------------------------

interface IndexerProbeEvent {
  readonly phase: "enter" | "exit";
  readonly call: number;
  readonly ts: number;
}

/**
 * Wraps a real `StructuralIndexer`'s `reindex` with an events log and an
 * optional one-shot gate on a specific call index (0-based, in call order).
 * `reindex` is corpus-wide (it doesn't know which volume "caused" it), so
 * gating by call order — rather than by volume, as `ProbeEvidenceStore`
 * does for `putClaims` — is the only way to pin down "this particular
 * publish's reindex is the one in flight."
 */
class ProbeIndexer extends StructuralIndexer {
  readonly events: IndexerProbeEvent[] = [];
  private callCount = 0;
  private gate: { readonly callIndex: number; readonly spec: GateSpec } | undefined;

  gateReindexCall(callIndex: number, spec: GateSpec): void {
    this.gate = { callIndex, spec };
  }

  override async reindex(store: VolumeStore): Promise<BuildIndexResult> {
    const call = this.callCount++;
    this.events.push({ phase: "enter", call, ts: Date.now() });
    if (this.gate?.callIndex === call) {
      const spec = this.gate.spec;
      this.gate = undefined;
      spec.onEnter?.();
      await spec.gate;
    }
    const result = await super.reindex(store);
    this.events.push({ phase: "exit", call, ts: Date.now() });
    return result;
  }
}

describe("ShadowConversation — the reindex step is serialized corpus-wide across different volumes, even though draft/audit stay parallel (F1 review fix)", () => {
  test("volume two's audit-phase persist completes while volume one's reindex is still in flight, but volume two's own reindex does not start until volume one's is done", async () => {
    await withVolumeHarness(async ({ volumeStore, volume: volumeOne, root }) => {
      await withSessionCwd(async (sessionCwd) => {
        const volumeTwo = toVolumeSlug("second-volume-f1");
        await volumeStore.createVolume({ slug: volumeTwo, title: "Second Volume (F1)" });

        const probeStore = new ProbeEvidenceStore(volumeStore);
        const probeIndexer = new ProbeIndexer({ rootDir: root });
        const research = new FakeResearchBriefPort(probeStore, () => {
          throw new Error("no research directive expected in this test");
        });
        const sessions = new FakeAgenticSessionPort(
          chapterOnMarkerResponder([LOCK_TEST_ALPHA, LOCK_TEST_BETA]),
        );

        const deps: ShadowAgentDeps = {
          agenticSessionPort: sessions,
          researchBriefPort: research,
          volumeStore,
          evidenceStore: probeStore,
          indexer: probeIndexer,
          checkWorthinessClassifier: alwaysNarrativeClassifier,
          entailmentRelevanceJudge: scriptedEntailmentJudge(),
          claimRestater: scriptedClaimRestater(() => {
            throw new Error("no claim should need repair in this test");
          }),
          sessionCwd,
        };

        const agent = new ShadowAgent(deps);
        const convOne = agent.startConversation(volumeOne);
        const convTwo = agent.startConversation(volumeTwo);

        // Gate the very first `reindex` call -- volume one's, since volume
        // two hasn't even started drafting yet -- open, so the corpus lock
        // stays held for as long as the test wants.
        const oneEntered = deferred();
        const oneRelease = deferred();
        probeIndexer.gateReindexCall(0, {
          onEnter: () => oneEntered.resolve(),
          gate: oneRelease.promise,
        });

        const eventsOne: ShadowEvent[] = [];
        const drainedOne = (async () => {
          for await (const event of convOne.sendMessage(LOCK_TEST_ALPHA.operatorText)) {
            eventsOne.push(event);
          }
        })();

        await oneEntered.promise; // volume one now holds the corpus-wide reindex lock

        // Start volume two's publish now. Its draft and Tier 0/2 audit run
        // fully in parallel with volume one's still-gated reindex -- proven
        // below by its post-audit `putClaims` (the call immediately before
        // its own reindex attempt) completing before volume one's reindex
        // exits.
        const eventsTwo: ShadowEvent[] = [];
        const drainedTwo = (async () => {
          for await (const event of convTwo.sendMessage(LOCK_TEST_BETA.operatorText)) {
            eventsTwo.push(event);
          }
        })();

        // Poll (bounded) for volume two's audit-phase persist -- its second
        // `putClaims` call for its chapter -- to complete. This is real
        // filesystem work with no gate of its own, so it settles quickly if
        // (and only if) it isn't blocked on anything.
        const deadline = Date.now() + 2000;
        while (
          probeStore.events.filter((e) => e.chapter === LOCK_TEST_BETA.slug && e.phase === "exit")
            .length < 2 &&
          Date.now() < deadline
        ) {
          await Bun.sleep(1);
        }
        const betaAuditPersisted =
          probeStore.events.filter((e) => e.chapter === LOCK_TEST_BETA.slug && e.phase === "exit")
            .length >= 2;
        expect(betaAuditPersisted).toBe(true); // draft/audit overlap: proven while volume one's reindex is still gated open

        // Volume one's reindex must still be the only one that has entered —
        // volume two's own reindex call cannot even be attempted yet,
        // because it needs the same corpus-wide lock volume one is holding.
        expect(probeIndexer.events.filter((e) => e.phase === "enter")).toHaveLength(1);

        oneRelease.resolve();
        await Promise.all([drainedOne, drainedTwo]);

        expect(eventsOne.some((e) => e.type === "chapter-published")).toBe(true);
        expect(eventsTwo.some((e) => e.type === "chapter-published")).toBe(true);

        // Now that both are done: exactly two reindex calls happened, and
        // they never overlapped -- volume two's reindex only entered after
        // volume one's had already exited.
        const enters = probeIndexer.events.filter((e) => e.phase === "enter");
        const exits = probeIndexer.events.filter((e) => e.phase === "exit");
        expect(enters).toHaveLength(2);
        expect(exits).toHaveLength(2);
        const call0Exit = exits.find((e) => e.call === 0)?.ts;
        const call1Enter = enters.find((e) => e.call === 1)?.ts;
        expect(call0Exit).toBeDefined();
        expect(call1Enter).toBeDefined();
        // biome-ignore lint/style/noNonNullAssertion: presence asserted immediately above
        expect(call1Enter!).toBeGreaterThanOrEqual(call0Exit!);
      });
    });
  });

  test("same-volume publications are unaffected: still fully serialized, corpus lock or not", async () => {
    // The existing T0.6 "same-volume" test above (unmodified by this fix)
    // already pins this: two conversations on one volume never let their
    // `putClaims` critical sections overlap, corpus-wide reindex lock now
    // threaded through publishChapter or not. This test adds a direct
    // reindex-level check with the same instrumented indexer used above, so
    // the F1 fix's effect on same-volume behavior is asserted at the same
    // granularity as its cross-volume behavior.
    await withVolumeHarness(async ({ volumeStore, volume, root }) => {
      await withSessionCwd(async (sessionCwd) => {
        const probeStore = new ProbeEvidenceStore(volumeStore);
        const probeIndexer = new ProbeIndexer({ rootDir: root });
        const research = new FakeResearchBriefPort(probeStore, () => {
          throw new Error("no research directive expected in this test");
        });
        const sessions = new FakeAgenticSessionPort(
          chapterOnMarkerResponder([LOCK_TEST_ALPHA, LOCK_TEST_BETA]),
        );

        const deps: ShadowAgentDeps = {
          agenticSessionPort: sessions,
          researchBriefPort: research,
          volumeStore,
          evidenceStore: probeStore,
          indexer: probeIndexer,
          checkWorthinessClassifier: alwaysNarrativeClassifier,
          entailmentRelevanceJudge: scriptedEntailmentJudge(),
          claimRestater: scriptedClaimRestater(() => {
            throw new Error("no claim should need repair in this test");
          }),
          sessionCwd,
        };

        const agent = new ShadowAgent(deps);
        const convA = agent.startConversation(volume);
        const convB = agent.startConversation(volume);

        const entered = deferred();
        const release = deferred();
        probeStore.gateNextPutClaims(LOCK_TEST_ALPHA.slug, {
          onEnter: () => entered.resolve(),
          gate: release.promise,
        });

        const eventsA: ShadowEvent[] = [];
        const drainedA = (async () => {
          for await (const event of convA.sendMessage(LOCK_TEST_ALPHA.operatorText)) {
            eventsA.push(event);
          }
        })();

        await entered.promise; // conv A holds the volume lock, mid-draft

        const eventsB: ShadowEvent[] = [];
        const drainedB = (async () => {
          for await (const event of convB.sendMessage(LOCK_TEST_BETA.operatorText)) {
            eventsB.push(event);
          }
        })();

        await Bun.sleep(50);
        // Same-volume: conv B cannot even reach its own reindex attempt while
        // conv A holds the volume lock -- unchanged from before this fix.
        expect(probeIndexer.events).toHaveLength(0);

        release.resolve();
        await Promise.all([drainedA, drainedB]);

        expect(eventsA.some((e) => e.type === "chapter-published")).toBe(true);
        expect(eventsB.some((e) => e.type === "chapter-published")).toBe(true);
        expect(probeIndexer.events.filter((e) => e.phase === "enter")).toHaveLength(2);
      });
    });
  });
});

// -----------------------------------------------------------------------
// F3 — a `publishChapter` throw after a successful draft no longer
// discards the already-observed `chapter-drafted` event.
// -----------------------------------------------------------------------

describe("ShadowConversation — chapter-drafted survives a publishChapter throw (F3 review fix)", () => {
  test("the draft is persisted and chapter-drafted is observed by the caller even though publishChapter itself throws afterward", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume, root }) => {
      await withSessionCwd(async (sessionCwd) => {
        const slug = "chapter-that-throws";
        const marker = "THROW-DIRECTIVE";
        // Must match verbatim what's actually passed to `sendMessage` below —
        // `buildEvidenceSpan` requires the claim's quote to be a real
        // substring of the recorded operator-turn transcript.
        const operatorText = `${marker}: the operator's belief about the throwing case.`;

        const respond: FakeAgenticTurnResponder = (prompt) => {
          if (!prompt.includes(marker)) return { text: "Done." };
          const match = /Operator \(sourceId: (\S+)\):/.exec(prompt);
          const sourceId = match?.[1];
          if (!sourceId) throw new Error("operator sourceId missing from prompt");
          const chapter = {
            slug,
            title: "A chapter whose publish blows up",
            body: [
              `This chapter is about the throwing case.[^~belief]`,
              // Deliberately unmarked -- forces the C1b check-worthiness
              // sweep to actually call `checkWorthinessClassifier.classify`,
              // which is what this test makes throw.
              "This sentence has no footnote at all.",
            ].join(" "),
            claims: [
              {
                label: "belief",
                kind: "operator",
                text: "This chapter is about the throwing case.",
                evidence: [{ sourceId, quote: operatorText }],
              },
            ],
          };
          return {
            text: ["Drafting.", "```shadow:chapter", JSON.stringify(chapter), "```"].join("\n"),
          };
        };

        const research = new FakeResearchBriefPort(evidenceStore, () => {
          throw new Error("no research directive expected in this test");
        });
        const sessions = new FakeAgenticSessionPort(respond);

        const boom = new Error("checkWorthinessClassifier exploded");
        const throwingClassifier: CheckWorthinessClassifier = {
          classify: async () => {
            throw boom;
          },
        };

        const deps: ShadowAgentDeps = {
          agenticSessionPort: sessions,
          researchBriefPort: research,
          volumeStore,
          evidenceStore,
          indexer: freshIndexer(root),
          checkWorthinessClassifier: throwingClassifier,
          entailmentRelevanceJudge: scriptedEntailmentJudge(),
          claimRestater: scriptedClaimRestater(() => {
            throw new Error("should not be called");
          }),
          sessionCwd,
        };

        const agent = new ShadowAgent(deps);
        const conversation = agent.startConversation(volume);

        const events: ShadowEvent[] = [];
        const rejection = await expectRejection(
          (async () => {
            for await (const event of conversation.sendMessage(operatorText)) {
              events.push(event);
            }
          })(),
          Error,
        );
        expect(rejection).toBe(boom);

        // The regression this guards against: with the old "collect during
        // the lock, yield only after release" shape, this throw discarded
        // the already-collected `chapter-drafted` event entirely -- the
        // operator got no signal a draft had landed on disk.
        expect(events.some((e) => e.type === "chapter-drafted" && e.chapter === slug)).toBe(true);

        // And the draft really is on disk -- `draftChapter` did complete
        // before `publishChapter` blew up.
        const persisted = await volumeStore.getChapter(volume, toChapterSlug(slug));
        expect(persisted.title).toBe("A chapter whose publish blows up");

        // Never got as far as chapter-audit/chapter-published/chapter-rejected
        // -- publishChapter threw before producing a verdict.
        expect(events.some((e) => e.type === "chapter-audit")).toBe(false);
        expect(events.some((e) => e.type === "chapter-published")).toBe(false);
        expect(events.some((e) => e.type === "chapter-rejected")).toBe(false);
      });
    });
  });
});

// -----------------------------------------------------------------------
// F4 — chapter events stream to the caller while the volume lock is still
// held, not only after the whole draft-then-publish unit releases it.
// -----------------------------------------------------------------------

describe("ShadowConversation — chapter events stream out while the volume lock is still held (F4 review fix)", () => {
  test("chapter-drafted reaches the consumer before publishChapter's post-audit persist, and the lock is provably still held at that point", async () => {
    await withVolumeHarness(async ({ volumeStore, volume, root }) => {
      await withSessionCwd(async (sessionCwd) => {
        const spec: ChapterMarkerSpec = {
          marker: "STREAM-DIRECTIVE",
          slug: "chapter-stream",
          operatorText: "STREAM-DIRECTIVE: the operator's belief about streaming.",
        };
        const probeStore = new ProbeEvidenceStore(volumeStore);
        const research = new FakeResearchBriefPort(probeStore, () => {
          throw new Error("no research directive expected in this test");
        });
        const sessions = new FakeAgenticSessionPort(chapterOnMarkerResponder([spec]));

        const deps: ShadowAgentDeps = {
          agenticSessionPort: sessions,
          researchBriefPort: research,
          volumeStore,
          evidenceStore: probeStore,
          indexer: freshIndexer(root),
          checkWorthinessClassifier: alwaysNarrativeClassifier,
          entailmentRelevanceJudge: scriptedEntailmentJudge(),
          claimRestater: scriptedClaimRestater(() => {
            throw new Error("no claim should need repair in this test");
          }),
          sessionCwd,
        };

        const agent = new ShadowAgent(deps);
        const conversation = agent.startConversation(volume);

        const entered = deferred();
        const release = deferred();
        // Gate the *second* `putClaims` call for this chapter --
        // `publishChapter`'s post-audit persist, which happens after
        // `chapter-drafted` was already pushed but before the corpus is
        // reindexed -- so the volume lock is provably still held once we
        // observe the event below.
        probeStore.gatePutClaims(
          spec.slug,
          { onEnter: () => entered.resolve(), gate: release.promise },
          1,
        );

        const iterator = conversation.sendMessage(spec.operatorText)[Symbol.asyncIterator]();
        const events: ShadowEvent[] = [];

        let next = await iterator.next();
        while (!next.done && next.value.type !== "chapter-drafted") {
          events.push(next.value);
          next = await iterator.next();
        }
        if (next.done) throw new Error("stream ended before chapter-drafted was observed");
        events.push(next.value);

        // The consumer has now observed `chapter-drafted`. Confirm the
        // producer really is sitting at the gate (not merely that we got
        // lucky with scheduling) before checking the lock.
        await entered.promise;

        // Prove the lock is STILL held: a fresh attempt to acquire the same
        // volume's lock must not run until the gate above is released. If
        // events were still only yielded after the whole locked section
        // released (the pre-F4 shape), this race would be untestable this
        // way -- the generator wouldn't have produced anything yet for the
        // consumer to observe in the first place while the lock was held.
        let raced = false;
        const racer = agent.withVolumeLock(volume, async () => {
          raced = true;
        });

        await Bun.sleep(30);
        expect(raced).toBe(false); // still queued behind the in-flight publish

        release.resolve();
        await racer;
        expect(raced).toBe(true);

        // Drain the rest of the stream so the conversation finishes cleanly
        // -- `next` still holds the already-pushed `chapter-drafted` result,
        // so advance past it first before continuing the loop.
        next = await iterator.next();
        while (!next.done) {
          events.push(next.value);
          next = await iterator.next();
        }

        expect(events.some((e) => e.type === "chapter-published")).toBe(true);
        expect(events.some((e) => e.type === "error" || e.type === "chapter-rejected")).toBe(false);
      });
    });
  });
});

// -----------------------------------------------------------------------
// T2.3 — resume pass-through + in-conversation fallback.
// -----------------------------------------------------------------------

/**
 * Wraps a real `FileSystemEvidenceStore`'s `putSourceFromTranscript` — the
 * one and only seam `recordSessionTranscriptSource` (D19/D23) writes
 * through — with a call log, so a test can assert it fired exactly once and
 * inspect exactly what text it recorded, without a hand-rolled fake
 * `EvidenceStore` that would have to reimplement every other method these
 * tests' `draftChapter`/`publishChapter` calls also need.
 */
class ProbeTranscriptEvidenceStore extends FileSystemEvidenceStore {
  readonly transcriptCalls: SessionTranscriptWitness[] = [];

  override async putSourceFromTranscript(
    volume: VolumeSlug,
    witness: SessionTranscriptWitness,
    metadata: SourceMetadata,
  ): Promise<SourceRecord> {
    this.transcriptCalls.push(witness);
    return super.putSourceFromTranscript(volume, witness, metadata);
  }
}

/**
 * Mirrors `@shadow/model`'s `factory.ts#withRetrying`: wraps every session
 * an `AgenticSessionPort` hands out in `RetryingAgenticSession`, governed by
 * `policy`. Built here rather than imported because `withRetrying` itself
 * isn't part of `@shadow/model`'s public surface (only its effect,
 * `createModel`, is) — this is the same composition `@shadow/agent`'s real
 * callers get for free via `createModel()`, reproduced for a test that
 * specifically wants to prove T1.1/T1.2/T1.3 compose with T2.3's `resume`
 * pass-through (test 6 below). `sleep` defaults to instant so retry-delay
 * tests don't actually wait ~1s/~4s.
 */
function withRetrying(
  port: AgenticSessionPort,
  policy: RetryPolicy = conservativeRetryPolicy,
): AgenticSessionPort {
  const instantSleep = async () => {};
  return {
    createSession(options?: AgenticSessionOptions): AgenticSession {
      return new RetryingAgenticSession(port.createSession(options), policy, instantSleep);
    },
    deleteStoredSession(sdkSessionId: string): Promise<void> {
      return port.deleteStoredSession(sdkSessionId);
    },
  };
}

async function drain(
  conversation: {
    sendMessage(text: string): AsyncGenerator<ShadowEvent, void, undefined>;
  },
  text: string,
): Promise<ShadowEvent[]> {
  const events: ShadowEvent[] = [];
  for await (const event of conversation.sendMessage(text)) {
    events.push(event);
  }
  return events;
}

function buildFallbackDeps(
  agenticSessionPort: AgenticSessionPort,
  research: ResearchBriefPort,
  evidenceStore: ShadowAgentDeps["evidenceStore"],
  volumeStore: VolumeStore,
  root: string,
  sessionCwd: string,
): ShadowAgentDeps {
  return {
    agenticSessionPort,
    researchBriefPort: research,
    volumeStore,
    evidenceStore,
    indexer: freshIndexer(root),
    checkWorthinessClassifier: alwaysNarrativeClassifier,
    entailmentRelevanceJudge: scriptedEntailmentJudge(),
    claimRestater: scriptedClaimRestater(() => {
      throw new Error("should not be called in T2.3 fallback tests");
    }),
    sessionCwd,
  };
}

describe("ShadowConversation — resume pass-through (T2.3)", () => {
  test("StartConversationOptions.resume is forwarded to the session port as options.resume", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume, root }) => {
      await withSessionCwd(async (sessionCwd) => {
        const research = new FakeResearchBriefPort(evidenceStore, () => []);
        const sessions = new FakeAgenticSessionPort(() => ({ text: "Hello again." }));
        const deps = buildFallbackDeps(
          sessions,
          research,
          evidenceStore,
          volumeStore,
          root,
          sessionCwd,
        );

        const agent = new ShadowAgent(deps);
        const conversation = agent.startConversation(volume, {
          resume: { sdkSessionId: "sdk-session-abc" },
        });

        await drain(conversation, "Continuing from before.");

        expect(sessions.sessions).toHaveLength(1);
        expect(sessions.sessions[0]?.options.resume).toEqual({ sessionId: "sdk-session-abc" });
      });
    });
  });
});

describe("ShadowConversation — in-conversation resume fallback (T2.3)", () => {
  test("resumed first turn hits no-conversation-found -> a second session is created without resume, the fallback summary reaches the model prompt with non-citable framing, and the turn completes", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume, root }) => {
      await withSessionCwd(async (sessionCwd) => {
        const research = new FakeResearchBriefPort(evidenceStore, () => []);
        const respond = failNTimesThenSucceed(1, noConversationFoundError("dead-sdk-id"), {
          text: "Picking up where we left off.",
        });
        const sessions = new FakeAgenticSessionPort(respond);
        const deps = buildFallbackDeps(
          sessions,
          research,
          evidenceStore,
          volumeStore,
          root,
          sessionCwd,
        );

        const agent = new ShadowAgent(deps);
        const conversation = agent.startConversation(volume, {
          resume: {
            sdkSessionId: "dead-sdk-id",
            fallbackSummary: "Operator previously asked about density in list views.",
          },
        });

        const events = await drain(conversation, "What did we cover last time?");

        // --- a second session, without resume ------------------------------
        expect(sessions.sessions).toHaveLength(2);
        expect(sessions.sessions[0]?.options.resume).toEqual({ sessionId: "dead-sdk-id" });
        expect(sessions.sessions[1]?.options.resume).toBeUndefined();

        // --- the re-issued turn's prompt carries the summary, framed as
        // recovered context, never operator speech ---------------------------
        const fallbackPrompt = sessions.sessions[1]?.prompts[0] ?? "";
        expect(fallbackPrompt).toContain(
          "Context recovered from a previous conversation — not operator speech; " +
            "never cite it as an operator source.",
        );
        expect(fallbackPrompt).toContain("Operator previously asked about density in list views.");
        // ...and the operator's actual turn is still in there too (same
        // prompt that would have been sent had resume worked).
        expect(fallbackPrompt).toContain("What did we cover last time?");

        // --- the turn completes normally, no error surfaced ------------------
        expect(events.some((e) => e.type === "error")).toBe(false);
        expect(events.some((e) => e.type === "assistant-message")).toBe(true);
      });
    });
  });

  test("the operator source is recorded exactly once, and never contains the fallback summary text (D19/D23)", async () => {
    await withVolumeHarness(async ({ volumeStore, volume, root }) => {
      await withSessionCwd(async (sessionCwd) => {
        const probeStore = new ProbeTranscriptEvidenceStore(volumeStore);
        const research = new FakeResearchBriefPort(probeStore, () => []);
        const respond = failNTimesThenSucceed(1, noConversationFoundError("dead-sdk-id"), {
          text: "Understood.",
        });
        const sessions = new FakeAgenticSessionPort(respond);
        const deps = buildFallbackDeps(
          sessions,
          research,
          probeStore,
          volumeStore,
          root,
          sessionCwd,
        );

        const agent = new ShadowAgent(deps);
        const conversation = agent.startConversation(volume, {
          resume: {
            sdkSessionId: "dead-sdk-id",
            fallbackSummary: "SECRET-SUMMARY-TEXT-must-not-be-recorded",
          },
        });

        const operatorText = "The operator's real turn text.";
        await drain(conversation, operatorText);

        expect(probeStore.transcriptCalls).toHaveLength(1);
        expect(probeStore.transcriptCalls[0]?.transcriptText).toBe(operatorText);
        expect(probeStore.transcriptCalls[0]?.transcriptText).not.toContain(
          "SECRET-SUMMARY-TEXT-must-not-be-recorded",
        );
      });
    });
  });

  test("a non-no-conversation-found error on the resumed first turn is not handled by the fallback -- it propagates, and resume is never dropped", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume, root }) => {
      await withSessionCwd(async (sessionCwd) => {
        const research = new FakeResearchBriefPort(evidenceStore, () => []);
        const boom = new AgenticSessionError("some unrelated transport failure");
        const sessions = new FakeAgenticSessionPort(() => ({ throws: boom }));
        const deps = buildFallbackDeps(
          sessions,
          research,
          evidenceStore,
          volumeStore,
          root,
          sessionCwd,
        );

        const agent = new ShadowAgent(deps);
        const conversation = agent.startConversation(volume, {
          resume: {
            sdkSessionId: "dead-sdk-id",
            fallbackSummary: "should never be used",
          },
        });

        const rejection = await expectRejection(drain(conversation, "Hello?"), AgenticSessionError);
        expect(rejection).toBe(boom);

        // No fallback: exactly one session was ever created, still carrying
        // its original resume target.
        expect(sessions.sessions).toHaveLength(1);
        expect(sessions.sessions[0]?.options.resume).toEqual({ sessionId: "dead-sdk-id" });
      });
    });
  });

  test("no-conversation-found with no fallbackSummary provided propagates -- no fallback possible", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume, root }) => {
      await withSessionCwd(async (sessionCwd) => {
        const research = new FakeResearchBriefPort(evidenceStore, () => []);
        const sessions = new FakeAgenticSessionPort(() => ({
          throws: noConversationFoundError("dead-sdk-id"),
        }));
        const deps = buildFallbackDeps(
          sessions,
          research,
          evidenceStore,
          volumeStore,
          root,
          sessionCwd,
        );

        const agent = new ShadowAgent(deps);
        // resume set, but no fallbackSummary.
        const conversation = agent.startConversation(volume, {
          resume: { sdkSessionId: "dead-sdk-id" },
        });

        const rejection = await expectRejection(drain(conversation, "Hello?"), AgenticSessionError);
        expect(isNoConversationFoundError(rejection)).toBe(true);

        expect(sessions.sessions).toHaveLength(1);
      });
    });
  });

  test("composition guard: a transient 529-style thrown error on the resumed first turn is retried by the decorator with resume intact, then succeeds -- no fallback triggered", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume, root }) => {
      await withSessionCwd(async (sessionCwd) => {
        const research = new FakeResearchBriefPort(evidenceStore, () => []);
        const transientFailure = new AgenticSessionError("529 overloaded, please retry");
        const respond = failNTimesThenSucceed(1, transientFailure, {
          text: "Made it through after the retry.",
        });
        const rawSessions = new FakeAgenticSessionPort(respond);
        const sessions = withRetrying(rawSessions);
        const deps = buildFallbackDeps(
          sessions,
          research,
          evidenceStore,
          volumeStore,
          root,
          sessionCwd,
        );

        const agent = new ShadowAgent(deps);
        const conversation = agent.startConversation(volume, {
          resume: {
            sdkSessionId: "sdk-session-still-alive",
            fallbackSummary: "should never be used -- this is not a no-conversation-found error",
          },
        });

        const events = await drain(conversation, "Are you still there?");

        // Exactly one underlying session -- the retry decorator re-issues
        // the same handle, it never asks the port for a second one, so
        // T2.3's fallback (which *would* create a second session) never
        // fired.
        expect(rawSessions.sessions).toHaveLength(1);
        expect(rawSessions.sessions[0]?.options.resume).toEqual({
          sessionId: "sdk-session-still-alive",
        });
        expect(
          rawSessions.sessions[0]?.prompts.some((p) =>
            p.includes("Context recovered from a previous conversation"),
          ),
        ).toBe(false);

        expect(events.some((e) => e.type === "error")).toBe(false);
        expect(events.some((e) => e.type === "assistant-message")).toBe(true);
      });
    });
  });
});

// -----------------------------------------------------------------------
// F2 — release() during a running turn defers instead of amputating the
// auto-continuation loop's context.
// -----------------------------------------------------------------------

describe("ShadowConversation — release() during an in-flight sendMessage defers instead of amputating context (F2 review fix)", () => {
  test("release() called between two auto-turns of ONE sendMessage does not force a new session for the second turn, and only takes effect once the whole call completes", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume, root }) => {
      await withSessionCwd(async (sessionCwd) => {
        const research = new ControllableResearchBriefPort();
        const respond: FakeAgenticTurnResponder = (_prompt, context) =>
          context.turnIndex === 0
            ? {
                text: [
                  "Looking into it.",
                  "```shadow:research",
                  JSON.stringify({ goal: "F2 gated goal", subjectDomains: ["f2.test"] }),
                  "```",
                ].join("\n"),
              }
            : { text: "All done." };
        const sessions = new FakeAgenticSessionPort(respond);

        const deps: ShadowAgentDeps = {
          agenticSessionPort: sessions,
          researchBriefPort: research,
          volumeStore,
          evidenceStore,
          indexer: freshIndexer(root),
          checkWorthinessClassifier: alwaysNarrativeClassifier,
          entailmentRelevanceJudge: scriptedEntailmentJudge(),
          claimRestater: scriptedClaimRestater(() => {
            throw new Error("should not be called");
          }),
          sessionCwd,
        };

        const agent = new ShadowAgent(deps);
        const conversation = agent.startConversation(volume);

        const events: ShadowEvent[] = [];
        const drained = (async () => {
          for await (const event of conversation.sendMessage("Look into F2.")) {
            events.push(event);
          }
        })();

        // Turn 0 has completed (its research directive was parsed) and the
        // loop is now awaiting the gated research call before turn 1 can
        // run -- i.e. this is genuinely BETWEEN this one sendMessage call's
        // two auto-turns, still inside the generator the whole time.
        await research.waitForCall(0);

        // release() while the call is still in flight must defer, not
        // amputate -- `this.session` (and therefore turn 1's ability to
        // reuse it) must survive until sendMessage actually finishes.
        await conversation.release();
        // Proof release hasn't taken effect yet: the session handle turn 0
        // completed on is still there.
        expect(conversation.sessionId).toBeDefined();

        research.resolveCall(0, { findings: [], sources: [] });
        await drained;

        // Exactly one underlying AgenticSession -- turn 1 (the
        // auto-continuation after the research directive) reused the same
        // handle turn 0 used; the regression this guards is a second
        // `createSession` call happening because release() had already
        // torn `this.session` down mid-call.
        expect(sessions.sessions).toHaveLength(1);
        expect(sessions.sessions[0]?.prompts).toHaveLength(2);

        expect(events.some((e) => e.type === "error")).toBe(false);

        // release() has now taken effect: the whole sendMessage call
        // (including its deferred release) has completed.
        expect(conversation.sessionId).toBeUndefined();
      });
    });
  });
});

// -----------------------------------------------------------------------
// F3 — pendingResume does not survive a successful resumed first turn, or
// release(), so a recycled handle cannot resume a stale sdk id.
// -----------------------------------------------------------------------

describe("ShadowConversation — pendingResume is cleared once the resumed first turn succeeds (F3 review fix)", () => {
  test("release() after a successful resumed turn 1, then reuse, does not re-resume the original (now stale) sdk id", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume, root }) => {
      await withSessionCwd(async (sessionCwd) => {
        const research = new FakeResearchBriefPort(evidenceStore, () => []);
        const sessions = new FakeAgenticSessionPort(() => ({ text: "Picking up." }));
        const deps = buildFallbackDeps(
          sessions,
          research,
          evidenceStore,
          volumeStore,
          root,
          sessionCwd,
        );

        const agent = new ShadowAgent(deps);
        const conversation = agent.startConversation(volume, {
          resume: {
            sdkSessionId: "original-sdk-id",
            fallbackSummary: "should never be needed -- this turn succeeds",
          },
        });

        await drain(conversation, "Continuing.");
        expect(sessions.sessions).toHaveLength(1);
        expect(sessions.sessions[0]?.options.resume).toEqual({ sessionId: "original-sdk-id" });

        await conversation.release();
        expect(conversation.sessionId).toBeUndefined();

        // Reuse the SAME handle for a second sendMessage. If `pendingResume`
        // had survived turn 1's success (the bug), this second call would
        // try to resume "original-sdk-id" again -- exactly the stale id the
        // real SDK has already moved past once a new one latched after turn
        // 1. The fix means this second session is created with NO resume
        // at all.
        await drain(conversation, "Second message after release.");

        expect(sessions.sessions).toHaveLength(2);
        expect(sessions.sessions[1]?.options.resume).toBeUndefined();
      });
    });
  });
});

// -----------------------------------------------------------------------
// F4 — the no-conversation-found fallback never re-issues a turn that
// already emitted output to the caller.
// -----------------------------------------------------------------------

describe("ShadowConversation — the fallback never re-issues a turn that already yielded output (F4 review fix)", () => {
  test("a scripted delta then a no-conversation-found throw on the resumed first turn propagates -- no fallback, no duplicate deltas", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume, root }) => {
      await withSessionCwd(async (sessionCwd) => {
        const research = new FakeResearchBriefPort(evidenceStore, () => []);
        const sessions = new FakeAgenticSessionPort(() => ({
          events: [{ type: "text-delta", text: "partial output before the crash" }],
          throws: noConversationFoundError("dead-sdk-id"),
        }));
        const deps = buildFallbackDeps(
          sessions,
          research,
          evidenceStore,
          volumeStore,
          root,
          sessionCwd,
        );

        const agent = new ShadowAgent(deps);
        const conversation = agent.startConversation(volume, {
          resume: {
            sdkSessionId: "dead-sdk-id",
            fallbackSummary: "should never be used -- output already reached the caller",
          },
        });

        const events: ShadowEvent[] = [];
        const rejection = await expectRejection(
          (async () => {
            for await (const event of conversation.sendMessage("Hello?")) {
              events.push(event);
            }
          })(),
          AgenticSessionError,
        );
        expect(isNoConversationFoundError(rejection)).toBe(true);

        // No fallback: exactly one session was ever created.
        expect(sessions.sessions).toHaveLength(1);

        const deltas = events.filter((e) => e.type === "text-delta");
        expect(deltas).toHaveLength(1);
        expect((deltas[0] as { text: string }).text).toBe("partial output before the crash");
      });
    });
  });
});

// -----------------------------------------------------------------------
// Review #11 — three cheap conversation tests.
// -----------------------------------------------------------------------

describe("ShadowConversation — T2.3 fallback edge cases (review #11)", () => {
  test("a no-conversation-found error on a LATER auto-turn (not the resumed first) propagates -- no fallback fires", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume, root }) => {
      await withSessionCwd(async (sessionCwd) => {
        const research = new FakeResearchBriefPort(evidenceStore, () => []);
        const respond: FakeAgenticTurnResponder = (_prompt, context) =>
          context.turnIndex === 0
            ? {
                text: [
                  "```shadow:research",
                  JSON.stringify({ goal: "later-turn goal", subjectDomains: ["later.test"] }),
                  "```",
                ].join("\n"),
              }
            : { throws: noConversationFoundError("some-id") };
        const sessions = new FakeAgenticSessionPort(respond);
        const deps = buildFallbackDeps(
          sessions,
          research,
          evidenceStore,
          volumeStore,
          root,
          sessionCwd,
        );

        const agent = new ShadowAgent(deps);
        const conversation = agent.startConversation(volume, {
          resume: { sdkSessionId: "sdk-alive", fallbackSummary: "should never be used" },
        });

        const rejection = await expectRejection(drain(conversation, "Go."), AgenticSessionError);
        expect(isNoConversationFoundError(rejection)).toBe(true);

        // Only one session ever created -- the fallback only ever applies
        // to the resumed FIRST turn, never a later auto-continuation turn
        // on the same (already-latched) handle.
        expect(sessions.sessions).toHaveLength(1);
      });
    });
  });

  test("the fallback cannot fire twice -- if the fallback session ALSO throws no-conversation-found, it propagates rather than trying a third session", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume, root }) => {
      await withSessionCwd(async (sessionCwd) => {
        const research = new FakeResearchBriefPort(evidenceStore, () => []);
        const sessions = new FakeAgenticSessionPort(() => ({
          throws: noConversationFoundError("always-dead"),
        }));
        const deps = buildFallbackDeps(
          sessions,
          research,
          evidenceStore,
          volumeStore,
          root,
          sessionCwd,
        );

        const agent = new ShadowAgent(deps);
        const conversation = agent.startConversation(volume, {
          resume: { sdkSessionId: "dead-sdk-id", fallbackSummary: "recovered context" },
        });

        const rejection = await expectRejection(drain(conversation, "Hello?"), AgenticSessionError);
        expect(isNoConversationFoundError(rejection)).toBe(true);

        // Exactly two sessions: the doomed resumed one, and the one
        // fallback attempt -- never a third.
        expect(sessions.sessions).toHaveLength(2);
        expect(sessions.sessions[0]?.options.resume).toEqual({ sessionId: "dead-sdk-id" });
        expect(sessions.sessions[1]?.options.resume).toBeUndefined();
      });
    });
  });

  test("conversation.sessionId reflects the NEW session's id after a fallback rebuild, not the dead resumed id", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume, root }) => {
      await withSessionCwd(async (sessionCwd) => {
        const research = new FakeResearchBriefPort(evidenceStore, () => []);
        const respond = failNTimesThenSucceed(1, noConversationFoundError("dead-sdk-id"), {
          text: "Rebuilt and running.",
        });
        const sessions = new FakeAgenticSessionPort(respond);
        const deps = buildFallbackDeps(
          sessions,
          research,
          evidenceStore,
          volumeStore,
          root,
          sessionCwd,
        );

        const agent = new ShadowAgent(deps);
        const conversation = agent.startConversation(volume, {
          resume: { sdkSessionId: "dead-sdk-id", fallbackSummary: "recovered context" },
        });

        await drain(conversation, "Hello?");

        expect(sessions.sessions).toHaveLength(2);
        expect(conversation.sessionId).toBe(sessions.sessions[1]?.sessionId);
        expect(conversation.sessionId).not.toBe("dead-sdk-id");
      });
    });
  });
});
