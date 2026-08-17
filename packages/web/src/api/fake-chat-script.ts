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
 *
 * `operator` (F7 review fix) is emitted right after `session`, before any
 * agent event — matching the real handler's position — carrying the
 * operator's actual sent text via `input.message`. Both research
 * `briefId`s use the real `"<turnId>/brief-<n>"` format
 * (`../../api/src/event-mapping.ts`'s `StoredEventStamper`) under one
 * simulated turnId, since (per that handler's doc) a single HTTP
 * `POST /api/chat` mints exactly one `turnId` for its whole auto-turn
 * sequence, however many `research.started` directives fire across however
 * many auto-turns happen underneath it — not one `turnId` per directive.
 */

import type { ChatInput, ChatStreamEvent } from "./types.ts";

const FAKE_TURN_ID = "fake-turn-1";

export function defaultChatScript(sessionId: string, input: ChatInput): ChatStreamEvent[] {
  return [
    { event: "session", data: { sessionId } },
    { event: "operator", data: { text: input.message } },
    { event: "text", data: { delta: "Got it — I'll look into both." } },
    { event: "text", data: { delta: " Starting with Linear and Notion's UI patterns." } },
    {
      event: "research.started",
      data: {
        briefId: `${FAKE_TURN_ID}/brief-1`,
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
        briefId: `${FAKE_TURN_ID}/brief-1`,
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
        briefId: `${FAKE_TURN_ID}/brief-2`,
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
        briefId: `${FAKE_TURN_ID}/brief-2`,
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
