/**
 * Splits raw document text (PDF-extracted or Markdown) into
 * extraction-sized chunks — the one stage of the pipeline that runs on the
 * document's **raw** text rather than its `normalizeNfcWs`-flattened
 * snapshot. Heading/paragraph structure only exists in the raw text; the
 * flattened snapshot (single-line, whitespace-collapsed) is what
 * `validate.ts` and `@shadow/evidence`'s `buildSpanFromQuote` bind quotes
 * against later. Chunking and validation deliberately look at two different
 * texts for two different reasons — this module never normalizes anything.
 *
 * **Real inputs are PDF-extracted text, most of which carries no Markdown
 * headings at all** — the paragraph-packing path (`packText`) is the main
 * path in practice, not a fallback. Heading-aware chunking
 * (`extractSections`/`packSections`) only engages when the document
 * actually has heading structure worth preserving (3+ headings found);
 * below that, a stray `#` or two doesn't fragment otherwise-flat prose into
 * spurious sections.
 */

export interface DocumentChunk {
  readonly index: number;
  /** The heading stack active at this chunk's start, outermost first. Empty for paragraph-packed (no-heading) documents. */
  readonly headingPath: readonly string[];
  readonly text: string;
  /** Rough token estimate: `Math.ceil(text.length / 4)`. */
  readonly tokens: number;
  /** sha256 hex (no `sha256:` prefix) of `text`, for extraction-cache keys. */
  readonly contentHash: string;
}

export interface ChunkOptions {
  readonly targetTokens?: number;
  readonly maxTokens?: number;
}

export const DEFAULT_TARGET_TOKENS = 2000;
export const DEFAULT_MAX_TOKENS = 4000;

/** Chars-per-token estimate shared by every size decision in this module. */
const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

const FENCE_PATTERN = /^\s*(```|~~~)/;
const HEADING_PATTERN = /^ {0,3}(#{1,6})\s+(.*)$/;

interface Section {
  readonly headingPath: readonly string[];
  readonly text: string;
}

/**
 * A fenced-code-block-aware line scan for ATX headings (`#` through
 * `######`). Returns the flat sequence of sections between headings (each
 * tagged with the heading stack active at that point) and the total number
 * of headings found, which callers use to decide whether the document has
 * enough structure to chunk by heading at all.
 */
function extractSections(rawText: string): { sections: Section[]; headingCount: number } {
  const lines = rawText.split("\n");
  const sections: Section[] = [];
  const stack: string[] = [];
  let currentLines: string[] = [];
  let inFence = false;
  let headingCount = 0;

  function flush(headingPath: readonly string[]): void {
    const text = currentLines.join("\n").trim();
    currentLines = [];
    if (text.length > 0) sections.push({ headingPath, text });
  }

  for (const line of lines) {
    if (FENCE_PATTERN.test(line)) {
      inFence = !inFence;
      currentLines.push(line);
      continue;
    }
    if (!inFence) {
      const match = HEADING_PATTERN.exec(line);
      if (match) {
        flush(stack.slice());
        const level = (match[1] as string).length;
        const title = (match[2] as string).trim();
        while (stack.length < level - 1) stack.push("");
        stack.length = level - 1;
        stack.push(title);
        headingCount += 1;
        continue;
      }
    }
    currentLines.push(line);
  }
  flush(stack.slice());

  return { sections, headingCount };
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

/**
 * Last-resort split for a paragraph (or a whole no-heading document) too
 * big to fit in one chunk: sentence boundaries first, then bare word
 * boundaries if even a single sentence overflows `maxTokens`. This is what
 * keeps a giant, unbroken block of PDF-extracted text — no blank lines, no
 * headings — from ever producing a chunk over `maxTokens`.
 */
function splitOversizedParagraph(paragraph: string, maxChars: number): string[] {
  if (paragraph.length <= maxChars) return [paragraph];

  const pieces: string[] = [];
  let current = "";

  function pushCurrent(next: string): void {
    if (current.length > 0) pieces.push(current);
    current = next;
  }

  const sentences = paragraph.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.length > 0);
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      pushCurrent("");
      const words = sentence.split(/\s+/);
      let wordChunk = "";
      for (const word of words) {
        const candidate = wordChunk.length > 0 ? `${wordChunk} ${word}` : word;
        if (candidate.length > maxChars && wordChunk.length > 0) {
          pieces.push(wordChunk);
          wordChunk = word;
        } else {
          wordChunk = candidate;
        }
      }
      if (wordChunk.length > 0) pieces.push(wordChunk);
      continue;
    }
    const candidate = current.length > 0 ? `${current} ${sentence}` : sentence;
    if (candidate.length > maxChars && current.length > 0) {
      pushCurrent(sentence);
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) pieces.push(current);

  return pieces;
}

/**
 * Greedy paragraph packing toward `targetTokens`, never exceeding
 * `maxTokens`: paragraphs are joined with a blank line until the next one
 * would push the running chunk past the target, at which point the chunk
 * closes and a new one starts. Any paragraph that alone exceeds
 * `maxTokens` is pre-split (`splitOversizedParagraph`) before packing, so
 * every piece handed to the greedy loop already fits.
 */
function packText(text: string, targetTokens: number, maxTokens: number): string[] {
  const targetChars = targetTokens * CHARS_PER_TOKEN;
  const maxChars = maxTokens * CHARS_PER_TOKEN;

  const paragraphs = splitParagraphs(text).flatMap((paragraph) =>
    paragraph.length > maxChars ? splitOversizedParagraph(paragraph, maxChars) : [paragraph],
  );

  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current.length > 0 ? `${current}\n\n${paragraph}` : paragraph;
    if (current.length > 0 && candidate.length > targetChars) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);

  return chunks;
}

/**
 * Greedy *sibling* packing over sections: consecutive sections are combined
 * into one chunk (taking the first section's heading path) until the next
 * one would push past `targetTokens`. A section never splits below its
 * heading unless it alone exceeds `maxTokens`, in which case it's split at
 * paragraph boundaries via `packText`, with every resulting piece keeping
 * that section's heading path.
 */
function packSections(
  sections: readonly Section[],
  targetTokens: number,
  maxTokens: number,
): Section[] {
  const targetChars = targetTokens * CHARS_PER_TOKEN;
  const maxChars = maxTokens * CHARS_PER_TOKEN;

  const packed: Section[] = [];
  let currentTexts: string[] = [];
  let currentHeadingPath: readonly string[] = [];

  function flush(): void {
    if (currentTexts.length === 0) return;
    packed.push({ headingPath: currentHeadingPath, text: currentTexts.join("\n\n") });
    currentTexts = [];
  }

  for (const section of sections) {
    if (section.text.length > maxChars) {
      flush();
      for (const piece of packText(section.text, targetTokens, maxTokens)) {
        packed.push({ headingPath: section.headingPath, text: piece });
      }
      continue;
    }

    const prospective =
      currentTexts.length > 0 ? `${currentTexts.join("\n\n")}\n\n${section.text}` : section.text;
    if (currentTexts.length > 0 && prospective.length > targetChars) {
      flush();
    }
    if (currentTexts.length === 0) currentHeadingPath = section.headingPath;
    currentTexts.push(section.text);
  }
  flush();

  return packed;
}

/** Documents with fewer headings than this are treated as unstructured — pure paragraph packing, no heading path. */
const MIN_HEADINGS_FOR_STRUCTURE = 3;

/**
 * Split `rawText` into extraction-sized chunks. Heading-aware when the
 * document has at least {@link MIN_HEADINGS_FOR_STRUCTURE} ATX headings;
 * pure paragraph packing otherwise (the common case for PDF-extracted
 * text). Pure — no I/O, no LLM.
 */
export function chunkDocument(rawText: string, opts: ChunkOptions = {}): DocumentChunk[] {
  const targetTokens = opts.targetTokens ?? DEFAULT_TARGET_TOKENS;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  const trimmed = rawText.trim();
  if (trimmed.length === 0) return [];

  const { sections, headingCount } = extractSections(trimmed);
  const packed =
    headingCount >= MIN_HEADINGS_FOR_STRUCTURE
      ? packSections(sections, targetTokens, maxTokens)
      : packText(trimmed, targetTokens, maxTokens).map((text) => ({
          headingPath: [] as readonly string[],
          text,
        }));

  return packed.map((section, index) => ({
    index,
    headingPath: section.headingPath,
    text: section.text,
    tokens: estimateTokens(section.text),
    contentHash: sha256Hex(section.text),
  }));
}
