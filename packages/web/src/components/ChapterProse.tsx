import type { Claim } from "../api/types.ts";
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
 *   - neutral: a `derived` claim (D19) — a synthesis of other claims in
 *     this chapter, not its own source snapshot. Rendering it as clay (the
 *     "sourced" colour) made every derived citation a dead click that
 *     looked identical to a working one: same tone, same cursor, same
 *     "opens evidence snapshot" label, `claim.evidence` just empty, so
 *     `onCiteClick`'s `if (span)` guard silently no-opped. Distinct tone
 *     here; `ChapterPage.tsx` gives it a distinct dialog instead of a
 *     silent no-op.
 */
export function ChapterProse({
  body,
  claims,
  failingLabels,
  onCiteClick,
}: {
  readonly body: string;
  readonly claims: readonly Claim[];
  /** Labels named in a failing `CheckOutcome`'s issues — the caller derives this from whichever audit shape it has (`ChapterPage`'s `AuditRecord`), so this component stays independent of that shape. */
  readonly failingLabels: ReadonlySet<string>;
  readonly onCiteClick: (claim: Claim) => void;
}) {
  const blocks = parseChapterBody(body);
  const claimsByLabel = new Map(claims.map((claim) => [claim.label, claim]));
  const numberByLabel = numberCitations(blocks);

  return (
    <div className="chapter-prose">
      {blocks.map((block, i) => (
        <Block
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks are a static parse of immutable prose, never reordered
          key={i}
          block={block}
          claimsByLabel={claimsByLabel}
          numberByLabel={numberByLabel}
          failingLabels={failingLabels}
          onCiteClick={onCiteClick}
        />
      ))}
    </div>
  );
}

/** Assigns each distinct `[^label]` a 1-based number in first-appearance order, so the mark rendered inline is a short numeral rather than the raw label text — repeats of the same label reuse its first number. */
function numberCitations(blocks: readonly ChapterBlock[]): ReadonlyMap<string, number> {
  const numberByLabel = new Map<string, number>();
  for (const block of blocks) {
    for (const segment of block.segments) {
      if (segment.type === "citation" && !numberByLabel.has(segment.label)) {
        numberByLabel.set(segment.label, numberByLabel.size + 1);
      }
    }
  }
  return numberByLabel;
}

function Block({
  block,
  claimsByLabel,
  numberByLabel,
  failingLabels,
  onCiteClick,
}: {
  readonly block: ChapterBlock;
  readonly claimsByLabel: Map<string, Claim>;
  readonly numberByLabel: ReadonlyMap<string, number>;
  readonly failingLabels: ReadonlySet<string>;
  readonly onCiteClick: (claim: Claim) => void;
}) {
  const content = groupSegments(block.segments).map((group, i) => (
    <SegmentGroup
      // biome-ignore lint/suspicious/noArrayIndexKey: groups are a static parse of immutable prose, never reordered
      key={i}
      group={group}
      claimsByLabel={claimsByLabel}
      numberByLabel={numberByLabel}
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

type SegmentGroup =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "citation"; readonly label: string; readonly precedingText: string | undefined };

/**
 * `parseInline` emits a text segment immediately before the citation it
 * footnotes (every text segment but a trailing one is followed by exactly
 * one citation) — pairing them here is what lets hovering the mark
 * highlight the exact prose it's citing, rather than the whole paragraph.
 */
function groupSegments(segments: readonly InlineSegment[]): readonly SegmentGroup[] {
  const groups: SegmentGroup[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] as InlineSegment;
    if (segment.type === "text") {
      const next = segments[i + 1];
      if (next?.type === "citation") continue;
      groups.push({ type: "text", text: segment.text });
      continue;
    }
    const prev = segments[i - 1];
    groups.push({
      type: "citation",
      label: segment.label,
      precedingText: prev?.type === "text" ? prev.text : undefined,
    });
  }
  return groups;
}

function SegmentGroup({
  group,
  claimsByLabel,
  numberByLabel,
  failingLabels,
  onCiteClick,
}: {
  readonly group: SegmentGroup;
  readonly claimsByLabel: Map<string, Claim>;
  readonly numberByLabel: ReadonlyMap<string, number>;
  readonly failingLabels: ReadonlySet<string>;
  readonly onCiteClick: (claim: Claim) => void;
}) {
  if (group.type === "text") return <>{group.text}</>;

  const claim = claimsByLabel.get(group.label);
  const tone = citationTone(group.label, claim, failingLabels);

  return (
    <span id={`claim-${group.label}`} className="cited-span">
      {group.precedingText !== undefined && (
        <span className="cited-span__text">{group.precedingText}</span>
      )}
      <CitationMark
        label={group.label}
        number={numberByLabel.get(group.label) ?? 0}
        tone={tone}
        onClick={() => {
          if (claim) onCiteClick(claim);
        }}
      />
    </span>
  );
}

function citationTone(
  label: string,
  claim: Claim | undefined,
  failingLabels: ReadonlySet<string>,
): Tone {
  if (failingLabels.has(label)) return "red";
  if (claim?.evidence.some((span) => span.anchorStatus === "orphaned")) return "amber";
  if (claim?.kind === "operator") return "sage";
  if (claim?.kind === "derived") return "neutral";
  return "clay";
}
