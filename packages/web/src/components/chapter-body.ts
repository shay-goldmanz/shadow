/**
 * Pure parsing of a chapter's Markdown body (D18: sentences marked with
 * ordinary reference footnotes, `[^label]`) into renderable blocks. No
 * domain logic — this only recognizes headings, paragraphs, and citation
 * markers well enough to render prose with clickable citations. Footnote
 * *definition* lines are skipped: the sidecar `claims[]` from the API is
 * the authoritative source for what a citation means, not the inline
 * definition text.
 */

export type InlineSegment =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "citation"; readonly label: string };

export type ChapterBlock =
  | {
      readonly type: "heading";
      readonly level: number;
      readonly segments: readonly InlineSegment[];
    }
  | { readonly type: "paragraph"; readonly segments: readonly InlineSegment[] };

const CITATION_PATTERN = /\[\^([a-zA-Z0-9_-]+)\]/g;
const FOOTNOTE_DEFINITION_PATTERN = /^\[\^[a-zA-Z0-9_-]+\]:/;
const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;

export function parseChapterBody(body: string): readonly ChapterBlock[] {
  const lines = body.split("\n").filter((line) => !FOOTNOTE_DEFINITION_PATTERN.test(line));

  const blocks: ChapterBlock[] = [];
  let currentParagraphLines: string[] = [];

  const flushParagraph = () => {
    if (currentParagraphLines.length === 0) return;
    const text = currentParagraphLines.join(" ").trim();
    currentParagraphLines = [];
    if (text.length > 0) blocks.push({ type: "paragraph", segments: parseInline(text) });
  };

  for (const line of lines) {
    const headingMatch = HEADING_PATTERN.exec(line);
    if (headingMatch) {
      flushParagraph();
      const [, hashes, text] = headingMatch;
      blocks.push({
        type: "heading",
        level: (hashes as string).length,
        segments: parseInline((text as string).trim()),
      });
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      continue;
    }

    currentParagraphLines.push(line.trim());
  }
  flushParagraph();

  return blocks;
}

function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(CITATION_PATTERN)) {
    const index = match.index;
    if (index > lastIndex) {
      segments.push({ type: "text", text: text.slice(lastIndex, index) });
    }
    segments.push({ type: "citation", label: match[1] as string });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", text: text.slice(lastIndex) });
  }
  return segments;
}
