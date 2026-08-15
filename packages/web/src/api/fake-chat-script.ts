/**
 * The scripted chat turn `FakeApiClient` replays. Narrated to match
 * `docs/ACCEPTANCE.md`'s critical path: the operator states two beliefs,
 * Shadow researches both, drafts two chapters, softens an overreaching
 * claim (D9's restatement, surfaced rather than swallowed), and one
 * chapter still fails its audit — shown, not hidden.
 *
 * Event shapes match `@shadow/api`'s real `handlers/chat.ts` mapping
 * (`../api/types.ts`'s `ChatStreamEvent`), not `docs/API.md`'s table
 * verbatim — in particular, `research.started`'s `brief` is a
 * `ResearchBrief` object, `research.finished`'s `findings` is `Finding[]`,
 * `audit` carries `{ passed, repairs }` rather than `{ verdict, findings }`,
 * and there is no `indexed` event (never emitted for chat — see that
 * handler's module doc).
 */

import type { ChatInput, ChatStreamEvent } from "./types.ts";

export function defaultChatScript(sessionId: string): ChatStreamEvent[] {
  return [
    { event: "session", data: { sessionId } },
    { event: "text", data: { delta: "Got it — I'll look into both." } },
    { event: "text", data: { delta: " Starting with Linear and Notion's UI patterns." } },
    {
      event: "research.started",
      data: {
        briefId: "brief-1",
        brief: {
          volume: "design-inspiration",
          goal: "How do Linear and Notion design their UI chrome?",
        },
      },
    },
    {
      event: "research.source",
      data: {
        sourceId: "src_linear_docs",
        url: "https://linear.app/method/writing-things-down",
        title: "Linear Method — Writing things down",
      },
    },
    {
      event: "research.source",
      data: {
        sourceId: "src_notion_design",
        url: "https://www.notion.so/blog/inside-the-design",
        title: "Inside the design of Notion",
      },
    },
    {
      event: "research.finished",
      data: {
        briefId: "brief-1",
        findings: [
          {
            text: "Linear: 4px scale, borders over shadows.",
            citations: [{ sourceId: "src_linear_docs", quote: "a 4px spacing scale" }],
          },
          {
            text: "Notion: whitespace, near-monochrome.",
            citations: [{ sourceId: "src_notion_design", quote: "generous whitespace" }],
          },
        ],
      },
    },
    { event: "text", data: { delta: " Drafting the first chapter now." } },
    {
      event: "chapter.drafted",
      data: { volume: "design-inspiration", chapter: "linear-and-notion-ui" },
    },
    {
      event: "audit",
      data: {
        volume: "design-inspiration",
        chapter: "linear-and-notion-ui",
        passed: true,
        repairs: [],
      },
    },
    {
      event: "chapter.published",
      data: { volume: "design-inspiration", chapter: "linear-and-notion-ui" },
    },
    { event: "text", data: { delta: " Now Epoch's one-pager craft." } },
    {
      event: "research.started",
      data: {
        briefId: "brief-2",
        brief: {
          volume: "design-inspiration",
          goal: "How does Epoch magazine design one-pagers?",
        },
      },
    },
    {
      event: "research.source",
      data: {
        sourceId: "src_epoch_onepager",
        url: "https://epoch.example/journal/one-pager-craft",
        title: "Epoch — the craft of the one-pager",
      },
    },
    {
      event: "research.finished",
      data: {
        briefId: "brief-2",
        findings: [
          {
            text: "Single dominant image, restrained three-colour palette this issue.",
            citations: [{ sourceId: "src_epoch_onepager", quote: "three colours" }],
          },
        ],
      },
    },
    {
      event: "chapter.restated",
      data: {
        claim: "epoch-three-colours",
        from: "Epoch magazine always uses exactly three colours in every one-pager they have ever made.",
        to: "Every one-pager Epoch has ever published uses exactly three colours.",
        reason:
          "Original phrasing overstated the source, which describes only the current issue's palette.",
        outcome: "applied",
      },
    },
    {
      event: "chapter.drafted",
      data: { volume: "design-inspiration", chapter: "epoch-one-pagers" },
    },
    {
      event: "audit",
      data: {
        volume: "design-inspiration",
        chapter: "epoch-one-pagers",
        passed: false,
        repairs: [
          {
            claimId: "clm_epoch_colours",
            label: "epoch-three-colours",
            chapter: "epoch-one-pagers",
            from: "Epoch magazine always uses exactly three colours in every one-pager they have ever made.",
            to: "Every one-pager Epoch has ever published uses exactly three colours.",
            reason:
              "Original phrasing overstated the source, which describes only the current issue's palette.",
            levenshtein: 42,
            bound: 80,
            outcome: "applied",
          },
        ],
      },
    },
    {
      event: "chapter.rejected",
      data: {
        volume: "design-inspiration",
        chapter: "epoch-one-pagers",
        issues: [
          {
            code: "span-entailment",
            label: "epoch-three-colours",
            message:
              "Cited span describes only the current issue; the claim generalizes to every one-pager Epoch has ever published.",
          },
        ],
      },
    },
    { event: "done", data: {} },
  ];
}

/**
 * A rule-book run, narrated the same way: `rulebook.chunk` fires four times
 * to demonstrate the coalescing progress row (`chat-transcript.ts`'s
 * `rulebook.progress` case collapses these into one growing line rather
 * than four), with one cached extraction and one failed chunk along the
 * way, then two `rulebook.group.audited` events — one pass, one fail —
 * mirroring `seedRulebook()`'s own fixture (`fake-data.ts`) so a demo run
 * through this narration and a direct visit to the Rule books pages tell
 * the same story about `loan-agreement-rules`.
 */
export function rulebookChatScript(sessionId: string): ChatStreamEvent[] {
  return [
    { event: "session", data: { sessionId } },
    { event: "text", data: { delta: "On it — building a rule book from the loan agreement." } },
    {
      event: "rulebook.started",
      data: { slug: "loan-agreement-rules", docPath: "/rnb_loan.pdf" },
    },
    {
      event: "rulebook.planned",
      data: {
        slug: "loan-agreement-rules",
        chunkCount: 4,
        groups: ["Interest & Fees", "Default & Remedies"],
      },
    },
    {
      event: "rulebook.chunk",
      data: {
        slug: "loan-agreement-rules",
        completed: 1,
        total: 4,
        rulesSoFar: 2,
        cached: false,
        failed: false,
      },
    },
    {
      event: "rulebook.chunk",
      data: {
        slug: "loan-agreement-rules",
        completed: 2,
        total: 4,
        rulesSoFar: 5,
        cached: true,
        failed: false,
      },
    },
    {
      event: "rulebook.chunk",
      data: {
        slug: "loan-agreement-rules",
        completed: 3,
        total: 4,
        rulesSoFar: 7,
        cached: false,
        failed: true,
      },
    },
    {
      event: "rulebook.chunk",
      data: {
        slug: "loan-agreement-rules",
        completed: 4,
        total: 4,
        rulesSoFar: 9,
        cached: false,
        failed: false,
      },
    },
    { event: "text", data: { delta: " Consolidating rules and auditing each group." } },
    {
      event: "rulebook.merged",
      data: { slug: "loan-agreement-rules", ruleCount: 8, droppedQuotes: 1, consolidated: 1 },
    },
    {
      event: "rulebook.group.audited",
      data: {
        slug: "loan-agreement-rules",
        group: "interest-and-fees",
        passed: true,
        repairs: 0,
        issues: [],
      },
    },
    {
      event: "rulebook.group.audited",
      data: {
        slug: "loan-agreement-rules",
        group: "default-and-remedies",
        passed: false,
        repairs: 1,
        issues: [
          "Cited clause describes suspending refinancing on this one event of default; the rule generalizes to permanent forfeiture on every default under the agreement.",
        ],
      },
    },
    {
      event: "rulebook.completed",
      data: {
        slug: "loan-agreement-rules",
        result: {
          slug: "loan-agreement-rules",
          sourceId: "src_rnb_loan",
          ruleCount: 8,
          groupCount: 2,
          publishedGroups: ["interest-and-fees"],
          rejectedGroups: ["default-and-remedies"],
          failedChunks: 1,
          status: "draft",
          assemblyDroppedQuotes: 1,
          assemblyDroppedRules: 0,
          usage: {
            inputTokens: 18234,
            outputTokens: 2210,
            cacheReadTokens: 4096,
            cacheWriteTokens: 512,
          },
        },
      },
    },
    { event: "done", data: {} },
  ];
}

/** `FakeApiClient`'s default chat script: picks the rule-book narration when the operator's message is actually about building one, the design-inspiration critical path otherwise — so `bun run dev` can demo either flow from the same running app. */
export function chooseChatScript(sessionId: string, input: ChatInput): ChatStreamEvent[] {
  return /rule\s*book/i.test(input.message)
    ? rulebookChatScript(sessionId)
    : defaultChatScript(sessionId);
}
