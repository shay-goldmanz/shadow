/**
 * Sentence-level segmentation for C1b's check-worthiness sweep
 * (`checks/check-worthiness.ts`). Splits a chapter's Markdown body into
 * prose sentences and reports which already carry a footnote marker.
 *
 * **This is the "Tier 0 form-based exclusion" `docs/EVIDENCE.md` names as
 * the first of narrative's three bounds** ("headings, list scaffolding,
 * code blocks, attributed blockquotes"): headings, list items, fenced code
 * blocks, and blockquote lines never become candidate sentences at all —
 * they are markdown scaffolding or quoted material, not free-form prose a
 * writer could hide an unsupported assertion inside. (T1.3 defined the
 * *rule*; this file is where it's actually implemented — nothing upstream
 * of C1b had a sentence concept to exclude from yet.) Every blockquote line
 * is excluded, not only "attributed" ones — detecting attribution
 * specifically would mean guessing at citation-like trailing dashes, which
 * is more likely to leak an unattributed quote through than to correctly
 * admit a genuinely-narrative attributed one; excluding blockquotes
 * wholesale costs nothing but a slightly wider exemption, which the visible
 * `narrativeRatio` budget already covers.
 *
 * Deliberately simple: fixture/chapter-scale prose segmentation, not a
 * general-purpose NLP sentence-boundary detector. It handles terminal
 * `.`/`!`/`?`, decimal numbers (`4.5` does not split), and a footnote
 * marker immediately following terminal punctuation (kept attached to the
 * sentence it closes) — the shapes that actually occur in Shadow chapters.
 */

import { parseFootnoteMarkers } from "./footnotes.ts";

export interface Sentence {
  readonly text: string;
  /** The paragraph this sentence belongs to — surrounding context for the judge. */
  readonly context: string;
  /** `true` if this sentence already carries a `[^label]`/`[^=label]`/`[^~label]` marker. */
  readonly marked: boolean;
}

const FENCE_PATTERN = /^\s*(```|~~~)/;
const HEADING_PATTERN = /^\s{0,3}#{1,6}\s/;
const LIST_ITEM_PATTERN = /^\s*(?:[-*+]|\d+[.)])\s+/;
const BLOCKQUOTE_PATTERN = /^\s*>/;
const TERMINAL_CHARS = new Set([".", "!", "?"]);

function isFormExcludedLine(line: string): boolean {
  return (
    HEADING_PATTERN.test(line) || LIST_ITEM_PATTERN.test(line) || BLOCKQUOTE_PATTERN.test(line)
  );
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

/**
 * Split one paragraph of prose into sentences. A `.`/`!`/`?` flanked by
 * digits on both sides (`4.5`) is not a boundary. A footnote marker
 * immediately following terminal punctuation stays attached to the
 * sentence it closes, so `"...four.[^lin-4px]"` is one sentence, not two.
 */
export function splitSentences(paragraph: string): string[] {
  const sentences: string[] = [];
  const n = paragraph.length;
  let start = 0;
  let i = 0;

  while (i < n) {
    const ch = paragraph[i] as string;
    if (TERMINAL_CHARS.has(ch)) {
      if (ch === "." && isDigit(paragraph[i - 1]) && isDigit(paragraph[i + 1])) {
        i += 1;
        continue;
      }
      let j = i;
      while (j < n && TERMINAL_CHARS.has(paragraph[j] as string)) j += 1;
      let k = j;
      if (paragraph[k] === "[" && paragraph[k + 1] === "^") {
        const markerEnd = paragraph.indexOf("]", k);
        if (markerEnd !== -1) k = markerEnd + 1;
      }
      const text = paragraph.slice(start, k).trim();
      if (text.length > 0) sentences.push(text);
      start = k;
      i = k;
      continue;
    }
    i += 1;
  }

  const rest = paragraph.slice(start).trim();
  if (rest.length > 0) sentences.push(rest);
  return sentences;
}

/** Segment a full chapter body into prose sentences, excluding headings/lists/code/blockquotes. Pure — no filesystem. */
export function segmentChapterBody(chapterBody: string): Sentence[] {
  const sentences: Sentence[] = [];
  let paragraphLines: string[] = [];
  let inFence = false;

  function flushParagraph(): void {
    if (paragraphLines.length === 0) return;
    const paragraphText = paragraphLines.join(" ");
    paragraphLines = [];
    for (const text of splitSentences(paragraphText)) {
      const marked = parseFootnoteMarkers(text).markers.length > 0;
      sentences.push({ text, context: paragraphText, marked });
    }
  }

  for (const line of chapterBody.split("\n")) {
    if (FENCE_PATTERN.test(line)) {
      flushParagraph();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }
    if (isFormExcludedLine(line)) {
      flushParagraph();
      continue;
    }
    paragraphLines.push(line.trim());
  }
  flushParagraph();

  return sentences;
}
