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
import { toChapterSlug } from "@shadow/core";
import type { IndexDocument } from "@shadow/indexing";
import type { AgenticSessionOptions, FakeAgenticTurnResponder } from "@shadow/model";
import { FakeAgenticSessionPort } from "@shadow/model";
import type { Finding, ResearchBrief, ResearchResult } from "@shadow/research";
import { ShadowAgent, type ShadowAgentDeps, type ShadowEvent } from "./conversation.ts";
import {
  alwaysNarrativeClassifier,
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

describe("ShadowConversation — critical path", () => {
  test("operator states a two-topic belief -> Shadow researches, drafts two chapters, both pass audit, volume is indexed", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume }) => {
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
          indexer: freshIndexer(),
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
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume }) => {
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
          indexer: freshIndexer(),
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
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume }) => {
      await withSessionCwd(async (sessionCwd) => {
        const research = new FakeResearchBriefPort(evidenceStore, () => []);
        const sessions = new FakeAgenticSessionPort(() => ({ text: "Got it." }));

        const deps: ShadowAgentDeps = {
          agenticSessionPort: sessions,
          researchBriefPort: research,
          volumeStore,
          evidenceStore,
          indexer: freshIndexer(),
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
