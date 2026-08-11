/**
 * Sentence-level segmentation for C1b's check-worthiness sweep
 * (`checks/check-worthiness.ts`). Splits a chapter's Markdown body into
 * prose sentences and reports which already carry a footnote marker.
 *
 * **This is the "Tier 0 form-based exclusion" `docs/EVIDENCE.md` names as
 * the first of narrative's three bounds** ("headings, list scaffolding,
 * code blocks, attributed blockquotes"). Headings and fenced code blocks
 * never become candidate sentences at all. **List items are different, per
 * D25 (Wave 2 review, C-2):** the spec authorized excluding list
 * *scaffolding* — the `- ` / `1. ` marker — not list *content*. The first
 * implementation excluded the whole line, which made a hallucinated
 * uncited bullet invisible to C1b's sweep *and* invisible to
 * `narrativeRatio`'s denominator — the visible-budget backstop D19 relies
 * on cannot see abuse it never counts, and design-guidance chapters (the
 * genre Shadow exists to write) are the most bullet-heavy prose there is.
 * So only the leading marker is stripped; the remaining text of a list item
 * is segmented into sentences exactly like ordinary paragraph prose,
 * including footnote-marker detection.
 *
 * **Blockquotes remain wholesale-excluded from segmentation** — detecting
 * "attributed" specifically would mean guessing at citation-like trailing
 * dashes, which is more likely to leak an unattributed quote through than
 * to correctly admit a genuinely-narrative attributed one. But per D25,
 * wholesale exclusion is only defensible if the exemption stays *visible*:
 * blockquote text is still segmented into sentence-equivalents and returned
 * here (tagged `formExcluded: true`), so `checkCheckWorthiness` can fold
 * them into `narrativeRatio`'s numerator and denominator without ever
 * sending them to the check-worthiness classifier. A chapter that dodges
 * citations by stuffing content into blockquotes now visibly inflates its
 * narrative ratio instead of vanishing from the metric entirely.
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
  /** The paragraph (or blockquote) this sentence belongs to — surrounding context for the judge. */
  readonly context: string;
  /** `true` if this sentence already carries a `[^label]`/`[^=label]`/`[^~label]` marker. */
  readonly marked: boolean;
  /**
   * `true` for a sentence found inside a wholesale-excluded form
   * (currently: blockquotes). Never sent to the check-worthiness classifier
   * — the exclusion still stands — but counted toward `narrativeRatio`'s
   * numerator and denominator (D25) so the exemption stays visible instead
   * of invisible. Omitted (falsy) for ordinary prose and list-item
   * sentences, which are audited normally.
   */
  readonly formExcluded?: boolean;
}

const FENCE_PATTERN = /^\s*(```|~~~)/;
const HEADING_PATTERN = /^\s{0,3}#{1,6}\s/;
/** List *scaffolding* only (D25) — stripped from a list-item line before its remaining text is treated as ordinary prose. */
const LIST_ITEM_PATTERN = /^\s*(?:[-*+]|\d+[.)])\s+/;
const BLOCKQUOTE_PATTERN = /^\s*>/;
/** Strips one level of `>` blockquote prefix (and the single space that conventionally follows it), for whatever text is kept as sentence-equivalents under D25. */
const BLOCKQUOTE_STRIP_PATTERN = /^\s*>+\s?/;
const TERMINAL_CHARS = new Set([".", "!", "?"]);

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

/**
 * Segment a full chapter body into sentences. Headings and fenced code are
 * excluded entirely. List-item *content* is segmented as ordinary prose,
 * with only its leading marker stripped (D25). Blockquote content is
 * segmented separately and returned tagged `formExcluded: true` (D25) — see
 * module doc. Pure — no filesystem.
 */
export function segmentChapterBody(chapterBody: string): Sentence[] {
  const sentences: Sentence[] = [];
  let paragraphLines: string[] = [];
  let blockquoteLines: string[] = [];
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

  function flushBlockquote(): void {
    if (blockquoteLines.length === 0) return;
    const quoteText = blockquoteLines.join(" ");
    blockquoteLines = [];
    for (const text of splitSentences(quoteText)) {
      sentences.push({ text, context: quoteText, marked: false, formExcluded: true });
    }
  }

  for (const line of chapterBody.split("\n")) {
    if (FENCE_PATTERN.test(line)) {
      flushParagraph();
      flushBlockquote();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.trim() === "") {
      flushParagraph();
      flushBlockquote();
      continue;
    }
    if (HEADING_PATTERN.test(line)) {
      flushParagraph();
      flushBlockquote();
      continue;
    }
    if (BLOCKQUOTE_PATTERN.test(line)) {
      flushParagraph();
      const stripped = line.replace(BLOCKQUOTE_STRIP_PATTERN, "").trim();
      if (stripped.length > 0) blockquoteLines.push(stripped);
      continue;
    }
    // Ordinary prose or a list item — D25: only the list marker (if any) is
    // scaffolding. `LIST_ITEM_PATTERN` matches nothing on a non-list line,
    // so `replace` is a no-op there and this handles both cases uniformly.
    flushBlockquote();
    const stripped = line.replace(LIST_ITEM_PATTERN, "").trim();
    if (stripped.length > 0) paragraphLines.push(stripped);
  }
  flushParagraph();
  flushBlockquote();

  return sentences;
}
