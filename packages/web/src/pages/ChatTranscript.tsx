import { AuditBanner, type AuditSummary } from "../components/AuditBanner.tsx";
import { Badge } from "../components/Badge.tsx";
import { RestatementNotice } from "../components/RestatementNotice.tsx";
import type { TranscriptItem } from "./chat-transcript.ts";

/**
 * A ` ```shadow:research {...}``` ` or ` ```shadow:chapter {...}``` ` fenced
 * block (the two directive tags `@shadow/agent`'s `directives.ts` parses)
 * is the model narrating its own tool call as text rather than a distinct
 * event — the started/finished events already render that progress as
 * their own rows below, and `shadow:chapter`'s block in particular embeds
 * an entire draft chapter body as one long escaped JSON string, which is
 * the "goes on and on" case. Left in, it reads as a raw JSON dump in the
 * middle of the operator's answer. Matched generically on `shadow:<tag>`
 * (not just today's two known tags) so a future directive doesn't leak the
 * same way before this gets updated. Stripped here rather than upstream so
 * this stays a rendering concern, not a change to the SSE contract or the
 * reducer in `chat-transcript.ts`.
 */
const TOOL_CALL_BLOCK = /```shadow:[a-z]+[\s\S]*?```/gi;

function visibleAssistantText(text: string): string {
  return text.replace(TOOL_CALL_BLOCK, "").trim();
}

/**
 * Renders the transcript in order. Research and publication events get
 * their own visible rows rather than being folded into prose, so slow work
 * reads as progress instead of a hang — and `chapter.restated` gets the
 * same prominent treatment as anywhere else it appears (D9).
 */
export function ChatTranscript({ items }: { readonly items: readonly TranscriptItem[] }) {
  return (
    <ol className="chat-transcript" aria-label="Conversation with Shadow">
      {items.map((item) => (
        <li key={item.id} className={`chat-transcript__item chat-transcript__item--${item.type}`}>
          <TranscriptItemView item={item} />
        </li>
      ))}
    </ol>
  );
}

function TranscriptItemView({ item }: { readonly item: TranscriptItem }) {
  switch (item.type) {
    case "user":
      return (
        <div className="chat-message chat-message--user">
          <span className="chat-message__author">Operator</span>
          <p>{item.text}</p>
        </div>
      );

    case "assistant": {
      const text = visibleAssistantText(item.text);
      if (!text) return null;
      return (
        <div className="chat-message chat-message--assistant">
          <span className="chat-message__author">Shadow</span>
          <p>{text}</p>
        </div>
      );
    }

    case "research.started":
      // `brief` is a `ResearchBrief` object (`{ goal, volume, ... }`), not a
      // string — `goal` is the prose an operator actually reads.
      return (
        <div className="research-event">
          <Badge tone="clay">Researching</Badge> <span>{item.brief.goal}</span>
        </div>
      );

    case "research.source":
      return (
        <div className="research-event">
          <Badge tone="clay">Source found</Badge>{" "}
          <a href={item.url} target="_blank" rel="noreferrer">
            {item.title}
          </a>
        </div>
      );

    case "research.finished":
      // `findings` is `Finding[]` (`{ text, citations }[]`), not a string.
      return (
        <div className="research-event">
          <Badge tone="sage">Research complete</Badge>
          <ul className="research-event__findings">
            {item.findings.map((finding) => (
              <li key={finding.text}>{finding.text}</li>
            ))}
          </ul>
        </div>
      );

    case "research.failed":
      return (
        <div className="research-event research-event--error" role="alert">
          <Badge tone="red">Research failed</Badge> <span>{item.brief.goal}</span>
          <p className="research-event__error">{item.error}</p>
        </div>
      );

    case "chapter.drafted":
      return (
        <div className="research-event">
          <Badge tone="sage">Chapter drafted</Badge> <span>{item.chapter}</span>
        </div>
      );

    case "audit": {
      // The chat `audit` event only carries `passed`/`repairs` — no
      // per-claim issue list (that arrives separately, below, on
      // `chapter.rejected`, if the audit failed). Repairs already get their
      // own visible `chapter.restated` rows, so this banner is deliberately
      // just the pass/fail headline here.
      const audit: AuditSummary = { passed: item.passed };
      return <AuditBanner audit={audit} />;
    }

    case "chapter.restated":
      return <RestatementNotice restatement={item} />;

    case "chapter.published":
      return (
        <div className="research-event">
          <Badge tone="sage">Chapter published</Badge> <span>{item.chapter}</span>
        </div>
      );

    case "chapter.rejected":
      return (
        <div className="research-event research-event--error" role="alert">
          <Badge tone="red">Chapter rejected</Badge> <span>{item.chapter}</span>
          {item.issues.length > 0 && (
            <ul className="research-event__findings">
              {item.issues.map((issue) => (
                <li key={`${issue.label ?? "chapter"}-${issue.code}`}>{issue.message}</li>
              ))}
            </ul>
          )}
        </div>
      );

    case "error":
      return (
        <div className="research-event research-event--error" role="alert">
          <Badge tone="red">Error</Badge> <span>{item.message}</span>
        </div>
      );
  }
}
