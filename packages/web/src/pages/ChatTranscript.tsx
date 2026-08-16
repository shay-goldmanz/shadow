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

/**
 * While a turn is still streaming, `text-delta`s arrive one token at a
 * time — a `` ```shadow:research `` fence's *opening* reaches the client
 * well before its closing `` ``` `` does, so `TOOL_CALL_BLOCK` (which
 * needs both ends) has nothing to match yet and the raw, in-progress
 * block renders for however long the model takes to finish writing it,
 * then vanishes the instant it closes. An odd number of `` ``` `` markers
 * left after stripping every *complete* block means exactly one is still
 * open — cut from there to the end rather than show a directive mid-write.
 * Shadow never leaves a fence open in a finished reply (a directive always
 * closes), so this never touches settled text, only an in-flight tail.
 */
export function visibleAssistantText(text: string): string {
  const stripped = text.replace(TOOL_CALL_BLOCK, "");
  const openFenceIndex = stripped.lastIndexOf("```");
  const settled =
    openFenceIndex >= 0 && countOccurrences(stripped, "```") % 2 === 1
      ? stripped.slice(0, openFenceIndex)
      : stripped;
  return settled.trim();
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count++;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Shadow's prose (and the research pipeline's own goals/findings/issue
 * messages) routinely uses `` `inline code` `` when talking about an
 * identifier or syntax — natural for a model discussing code, but this
 * transcript has no markdown rendering at all, so every backtick showed up
 * as a literal character instead of a styled code span. Handles just this
 * one construct rather than adding a full markdown parser: it's the one
 * that's actually shown up unrendered, and everything else Shadow writes
 * here is plain sentences.
 */
const INLINE_CODE = /`([^`\n]+)`/g;

function withInlineCode(text: string): Array<string | { readonly code: string }> {
  const parts: Array<string | { readonly code: string }> = [];
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_CODE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push(text.slice(lastIndex, index));
    parts.push({ code: match[1] ?? "" });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length || parts.length === 0) parts.push(text.slice(lastIndex));
  return parts;
}

function Prose({ text }: { readonly text: string }) {
  return (
    <>
      {withInlineCode(text).map((part, i) =>
        typeof part === "string" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a static split of one immutable string, never reordered
          <span key={i}>{part}</span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: a static split of one immutable string, never reordered
          <code key={i}>{part.code}</code>
        ),
      )}
    </>
  );
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
          <p>
            <Prose text={item.text} />
          </p>
        </div>
      );

    case "assistant": {
      const text = visibleAssistantText(item.text);
      if (!text) return null;
      return (
        <div className="chat-message chat-message--assistant">
          <span className="chat-message__author">Shadow</span>
          <p>
            <Prose text={text} />
          </p>
        </div>
      );
    }

    case "research.started":
      // `brief` is a `ResearchBrief` object (`{ goal, volume, ... }`), not a
      // string — `goal` is the prose an operator actually reads.
      return (
        <div className="research-event">
          <Badge tone="clay">Researching</Badge>{" "}
          <span>
            <Prose text={item.brief.goal} />
          </span>
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
              <li key={finding.text}>
                <Prose text={finding.text} />
              </li>
            ))}
          </ul>
        </div>
      );

    case "research.failed":
      return (
        <div className="research-event research-event--error" role="alert">
          <Badge tone="red">Research failed</Badge>{" "}
          <span>
            <Prose text={item.brief.goal} />
          </span>
          <p className="research-event__error">
            <Prose text={item.error} />
          </p>
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
                <li key={`${issue.label ?? "chapter"}-${issue.code}`}>
                  <Prose text={issue.message} />
                </li>
              ))}
            </ul>
          )}
        </div>
      );

    case "rulebook.started":
      return (
        <div className="research-event">
          <Badge tone="clay">Rule book started</Badge>{" "}
          <span>
            Building <code>{item.slug}</code> from <code>{item.docPath}</code>
          </span>
        </div>
      );

    case "rulebook.planned":
      return (
        <div className="research-event">
          <Badge tone="clay">Planned</Badge>{" "}
          <span>
            {item.chunkCount} section{item.chunkCount === 1 ? "" : "s"} across {item.groups.length}{" "}
            group{item.groups.length === 1 ? "" : "s"}
            {item.groups.length > 0 && <>: {item.groups.join(", ")}</>}
          </span>
        </div>
      );

    case "rulebook.progress":
      // A live, coalesced row (`chat-transcript.ts`'s `rulebook.chunk`
      // case) — one per run, updated in place as chunks stream in, rather
      // than a growing list of dozens of near-identical rows.
      return (
        <div className="research-event" aria-live="polite">
          <Badge tone="neutral">Extracting rules</Badge>{" "}
          <span>
            {item.completed}/{item.total} sections · {item.rulesSoFar} rules so far
            {item.cachedCount > 0 && ` · ${item.cachedCount} cached`}
            {item.failedCount > 0 && ` · ${item.failedCount} failed`}
          </span>
        </div>
      );

    case "rulebook.merged":
      return (
        <div className="research-event">
          <Badge tone="sage">Rules merged</Badge>{" "}
          <span>
            {item.ruleCount} rules after consolidation
            {item.consolidated > 0 && ` (${item.consolidated} duplicates merged)`}
            {item.droppedQuotes > 0 && ` · ${item.droppedQuotes} quotes dropped`}
          </span>
        </div>
      );

    case "rulebook.group.audited":
      return (
        <div
          className={`research-event${item.passed ? "" : " research-event--error"}`}
          role={item.passed ? undefined : "alert"}
        >
          <Badge tone={item.passed ? "sage" : "red"}>
            {item.passed ? "Group passed" : "Group failed"}
          </Badge>{" "}
          <span>
            {item.group}
            {item.repairs > 0 &&
              ` · ${item.repairs} repair${item.repairs === 1 ? "" : "s"} applied`}
          </span>
          {!item.passed && item.issues.length > 0 && (
            <ul className="research-event__findings">
              {item.issues.map((issue) => (
                <li key={issue}>
                  <Prose text={issue} />
                </li>
              ))}
            </ul>
          )}
        </div>
      );

    case "rulebook.completed": {
      const { result } = item;
      // `result.status` is the single source of truth for stable/draft
      // (computed once in `RulebookToolAgent.create` from the same
      // expression that drives the store's own status) — read it directly
      // rather than re-deriving it from counts.
      const stable = result.status === "stable";
      return (
        <div className="research-event">
          <Badge tone={stable ? "sage" : "amber"}>{stable ? "Stable" : "Needs review"}</Badge>{" "}
          <span>
            {result.ruleCount} rules in {result.groupCount} group
            {result.groupCount === 1 ? "" : "s"} · {result.publishedGroups.length} published
            {result.rejectedGroups.length > 0 && `, ${result.rejectedGroups.length} rejected`}
            {result.failedChunks > 0 &&
              ` · ${result.failedChunks} chunk${result.failedChunks === 1 ? "" : "s"} failed to extract`}
          </span>
        </div>
      );
    }

    case "rulebook.failed":
      return (
        <div className="research-event research-event--error" role="alert">
          <Badge tone="red">Rule book failed</Badge>{" "}
          <span>
            <Prose text={item.error} />
          </span>
        </div>
      );

    case "error":
      return (
        <div className="research-event research-event--error" role="alert">
          <Badge tone="red">Error</Badge>{" "}
          <span>
            <Prose text={item.message} />
          </span>
        </div>
      );
  }
}
