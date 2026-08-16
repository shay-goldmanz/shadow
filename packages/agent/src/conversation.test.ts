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
import { toChapterSlug, toVolumeSlug, type VolumeSlug } from "@shadow/core";
import { type ClaimSidecar, FileSystemEvidenceStore } from "@shadow/evidence";
import type { IndexDocument } from "@shadow/indexing";
import type { AgenticSessionOptions, FakeAgenticTurnResponder } from "@shadow/model";
import { FakeAgenticSessionPort } from "@shadow/model";
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

        await conversation.dispose();
        expect(sessions.sessions[0]?.isClosed).toBe(true);
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
  private readonly gates = new Map<string, GateSpec>();

  /**
   * The next `putClaims` call for `chapter` fires `spec.onEnter` (if given)
   * — proof this store has actually been reached — then awaits `spec.gate`
   * before the real write happens. One-shot: consumed on first match.
   */
  gateNextPutClaims(chapter: string, spec: GateSpec): void {
    this.gates.set(chapter, spec);
  }

  override async putClaims(volume: VolumeSlug, sidecar: ClaimSidecar): Promise<void> {
    const chapter = sidecar.chapter;
    this.events.push({ chapter, phase: "enter", ts: Date.now() });
    const spec = this.gates.get(chapter);
    if (spec) {
      this.gates.delete(chapter);
      spec.onEnter?.();
      await spec.gate;
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
