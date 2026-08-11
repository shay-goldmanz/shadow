/**
 * The scripted chat turn `FakeApiClient` replays. Narrated to match
 * `docs/ACCEPTANCE.md`'s critical path: the operator states two beliefs,
 * Shadow researches both, drafts two chapters, softens an overreaching
 * claim (D9's restatement, surfaced rather than swallowed), and one
 * chapter still fails its audit — shown, not hidden.
 */

import type { ChatStreamEvent } from "./types.ts";

export function defaultChatScript(sessionId: string): ChatStreamEvent[] {
  return [
    { event: "session", data: { sessionId } },
    { event: "text", data: { delta: "Got it — I'll look into both." } },
    { event: "text", data: { delta: " Starting with Linear and Notion's UI patterns." } },
    {
      event: "research.started",
      data: { brief: "How do Linear and Notion design their UI chrome?" },
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
        briefId: "brief_linear_notion",
        findings: "Linear: 4px scale, borders over shadows. Notion: whitespace, near-monochrome.",
      },
    },
    { event: "text", data: { delta: " Drafting the first chapter now." } },
    {
      event: "chapter.drafted",
      data: { volume: "design-inspiration", chapter: "linear-and-notion-ui" },
    },
    {
      event: "audit",
      data: { chapter: "linear-and-notion-ui", verdict: "pass", findings: [] },
    },
    { event: "text", data: { delta: " Now Epoch's one-pager craft." } },
    {
      event: "research.started",
      data: { brief: "How does Epoch magazine design one-pagers?" },
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
        briefId: "brief_epoch",
        findings: "Single dominant image, restrained three-colour palette this issue.",
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
        chapter: "epoch-one-pagers",
        verdict: "fail",
        findings: [
          {
            claim: "epoch-three-colours",
            check: "span-entailment",
            message:
              "Cited span describes only the current issue; the claim generalizes to every one-pager Epoch has ever published.",
          },
        ],
      },
    },
    {
      event: "indexed",
      data: { volume: "design-inspiration", stats: { volumes: 1, chapters: 2, tokens: 640 } },
    },
    { event: "done", data: {} },
  ];
}
