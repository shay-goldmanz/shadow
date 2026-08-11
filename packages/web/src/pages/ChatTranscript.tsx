import { AuditBanner } from "../components/AuditBanner.tsx";
import { Badge } from "../components/Badge.tsx";
import { RestatementNotice } from "../components/RestatementNotice.tsx";
import type { TranscriptItem } from "./chat-transcript.ts";

/**
 * Renders the transcript in order. Research and indexing events get their
 * own visible rows rather than being folded into prose, so slow work reads
 * as progress instead of a hang — and `chapter.restated` gets the same
 * prominent treatment as anywhere else it appears (D9).
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

    case "assistant":
      return (
        <div className="chat-message chat-message--assistant">
          <span className="chat-message__author">Shadow</span>
          <p>{item.text}</p>
        </div>
      );

    case "research.started":
      return (
        <div className="research-event">
          <Badge tone="clay">Researching</Badge> <span>{item.brief}</span>
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
      return (
        <div className="research-event">
          <Badge tone="sage">Research complete</Badge> <span>{item.findings}</span>
        </div>
      );

    case "chapter.drafted":
      return (
        <div className="research-event">
          <Badge tone="sage">Chapter drafted</Badge> <span>{item.chapter}</span>
        </div>
      );

    case "audit":
      return (
        <AuditBanner
          audit={{
            verdict: item.verdict,
            findings: item.findings,
          }}
        />
      );

    case "chapter.restated":
      return <RestatementNotice restatement={item} />;

    case "indexed":
      return (
        <div className="research-event">
          <Badge tone="sage">Indexed</Badge>{" "}
          <span>
            {item.stats.chapters} chapter{item.stats.chapters === 1 ? "" : "s"}, {item.stats.tokens}{" "}
            tokens
          </span>
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
