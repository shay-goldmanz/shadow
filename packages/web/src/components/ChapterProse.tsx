import type { AuditResult, Claim } from "../api/types.ts";
import type { Tone } from "./Badge.tsx";
import { CitationMark } from "./CitationMark.tsx";
import { type ChapterBlock, type InlineSegment, parseChapterBody } from "./chapter-body.ts";

const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

/**
 * The chapter rendered as prose (serif body per D10), with every citation
 * coloured by what it means rather than decoratively (D9/D22, and the
 * task's semantic colour rule):
 *   - clay, the default: this claim is sourced.
 *   - red: this specific claim is named in a failing audit finding.
 *   - amber: this claim's evidence has drifted (orphaned, D22) — a warning.
 *   - sage: the claim cites the operator's own words (D19 `operator` kind)
 *     rather than an external source — "this is yours".
 */
export function ChapterProse({
  body,
  claims,
  audit,
  onCiteClick,
}: {
  readonly body: string;
  readonly claims: readonly Claim[];
  readonly audit: AuditResult | undefined;
  readonly onCiteClick: (claim: Claim) => void;
}) {
  const blocks = parseChapterBody(body);
  const claimsByLabel = new Map(claims.map((claim) => [claim.label, claim]));
  const failingLabels = new Set((audit?.findings ?? []).map((f) => f.claim));

  return (
    <div className="chapter-prose">
      {blocks.map((block, i) => (
        <Block
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks are a static parse of immutable prose, never reordered
          key={i}
          block={block}
          claimsByLabel={claimsByLabel}
          failingLabels={failingLabels}
          onCiteClick={onCiteClick}
        />
      ))}
    </div>
  );
}

function Block({
  block,
  claimsByLabel,
  failingLabels,
  onCiteClick,
}: {
  readonly block: ChapterBlock;
  readonly claimsByLabel: Map<string, Claim>;
  readonly failingLabels: Set<string>;
  readonly onCiteClick: (claim: Claim) => void;
}) {
  const content = block.segments.map((segment, i) => (
    <Segment
      // biome-ignore lint/suspicious/noArrayIndexKey: segments are a static parse of immutable prose, never reordered
      key={i}
      segment={segment}
      claimsByLabel={claimsByLabel}
      failingLabels={failingLabels}
      onCiteClick={onCiteClick}
    />
  ));

  if (block.type === "heading") {
    const Tag = HEADING_TAGS[Math.min(block.level, 6) - 1] as (typeof HEADING_TAGS)[number];
    return <Tag>{content}</Tag>;
  }
  return <p>{content}</p>;
}

function Segment({
  segment,
  claimsByLabel,
  failingLabels,
  onCiteClick,
}: {
  readonly segment: InlineSegment;
  readonly claimsByLabel: Map<string, Claim>;
  readonly failingLabels: Set<string>;
  readonly onCiteClick: (claim: Claim) => void;
}) {
  if (segment.type === "text") return <>{segment.text}</>;

  const claim = claimsByLabel.get(segment.label);
  const tone = citationTone(segment.label, claim, failingLabels);

  return (
    <span id={`claim-${segment.label}`}>
      <CitationMark
        label={segment.label}
        tone={tone}
        onClick={() => {
          if (claim) onCiteClick(claim);
        }}
      />
    </span>
  );
}

function citationTone(label: string, claim: Claim | undefined, failingLabels: Set<string>): Tone {
  if (failingLabels.has(label)) return "red";
  if (claim?.evidence.some((span) => span.anchorStatus === "orphaned")) return "amber";
  if (claim?.kind === "operator") return "sage";
  return "clay";
}
