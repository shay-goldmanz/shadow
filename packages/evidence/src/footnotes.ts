/**
 * Footnote marker parsing (D18): extracts `[^label]` / `[^=label]` /
 * `[^~label]` markers from chapter Markdown, mapping to
 * `sourced` / `derived` / `operator` respectively.
 *
 * Only *reference* markers are extracted — the inline `[^label]` a sentence
 * ends with — not Markdown footnote *definitions* (`[^label]: text at the
 * bottom of the file`), which this package has no need to parse: a claim's
 * evidence lives in the sidecar JSON, not in the definition line's prose.
 * A definition is syntactically identical apart from the trailing `:`, so
 * that's exactly what distinguishes the two (a definition only appears at
 * the start of a line, per CommonMark's footnote extension, so this also
 * requires the marker begin a line to be treated as a definition).
 *
 * Labels are validated against D18's rule (lowercase kebab-case) at parse
 * time; a marker whose label doesn't match is reported as an issue rather
 * than silently dropped, since a malformed label is exactly the kind of
 * thing C1a needs to catch.
 *
 * **Fenced code blocks are masked before scanning (Wave 2 review, minor
 * item).** `sentence-segmentation.ts` already excludes fenced code from
 * prose segmentation, but this file used to scan the raw chapter body
 * unconditionally — a literal `[^example]` inside a fenced code sample
 * (documenting the footnote syntax itself, say) parsed as a real reference
 * marker with no claim record, failing C1a as an `orphan-marker`.
 * `maskFencedCode` blanks fenced-block content with same-length whitespace
 * before the marker regex runs, so `FootnoteMarker.index`/`raw` offsets
 * into the *original* text stay correct for anything found outside a fence.
 */

export type FootnoteKind = "sourced" | "derived" | "operator";

const FENCE_PATTERN = /^\s*(```|~~~)/;

/**
 * Replace the content of every fenced code block (```/~~~ delimited) with
 * whitespace of the same length, line by line — preserving every other
 * character's offset and the total string length so callers can keep using
 * plain string indices into the original text. The fence delimiter lines
 * themselves are left untouched (they essentially never contain a footnote
 * marker, and keeping them intact is simpler than special-casing them).
 */
function maskFencedCode(text: string): string {
  const lines = text.split("\n");
  let inFence = false;
  const masked = lines.map((line) => {
    if (FENCE_PATTERN.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return " ".repeat(line.length);
    return line;
  });
  return masked.join("\n");
}

/** D18's label shape: lowercase kebab-case. Exported for reuse by the structural completeness check. */
export const KEBAB_LABEL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LABEL_PATTERN = KEBAB_LABEL_PATTERN;

/** One `[^...]` reference marker found in chapter body text. */
export interface FootnoteMarker {
  readonly label: string;
  readonly kind: FootnoteKind;
  /** Character offset of the marker's opening `[` in the source text. */
  readonly index: number;
  /** The raw matched text, e.g. `[^=lin-4px]`. */
  readonly raw: string;
}

/** A marker-shaped token whose label failed D18's lowercase-kebab-case rule. */
export interface MalformedFootnote {
  readonly raw: string;
  readonly index: number;
  readonly reason: string;
}

export interface ParsedFootnotes {
  readonly markers: readonly FootnoteMarker[];
  readonly malformed: readonly MalformedFootnote[];
}

function kindForPrefix(prefix: string | undefined): FootnoteKind {
  if (prefix === "=") return "derived";
  if (prefix === "~") return "operator";
  return "sourced";
}

// Reference markers: `[^label]`, `[^=label]`, `[^~label]`, not immediately
// followed by `:` (which marks a definition line instead). The label body
// is matched permissively (no whitespace/brackets) so malformed labels
// still surface as `malformed` rather than silently not matching at all.
const MARKER_PATTERN = /\[\^(=|~)?([^\]\s]+)\](?!:)/g;

/**
 * Parse every inline footnote reference marker out of a chapter's Markdown
 * body. Pure — no filesystem, no Markdown rendering, just regex over text.
 */
export function parseFootnoteMarkers(chapterBody: string): ParsedFootnotes {
  const markers: FootnoteMarker[] = [];
  const malformed: MalformedFootnote[] = [];

  // Mask fenced code before scanning — see module doc. `maskFencedCode`
  // preserves length and non-fence content exactly, so `match.index`/`raw`
  // below still refer correctly into `chapterBody`.
  const scanText = maskFencedCode(chapterBody);

  for (const match of scanText.matchAll(MARKER_PATTERN)) {
    const index = match.index;
    const raw = match[0];
    const prefix = match[1];
    const label = match[2] ?? "";

    // A definition line starts (module-level, ignoring leading whitespace)
    // with the exact marker text this regex matched. We already excluded
    // markers immediately followed by `:`, but a definition can also be
    // written as `[^label]:` at the very start of a line with nothing
    // before it — that's already covered by the `(?!:)` exclusion above,
    // so no further check is needed here.

    if (!LABEL_PATTERN.test(label)) {
      malformed.push({
        raw,
        index,
        reason: `label ${JSON.stringify(label)} must be lowercase kebab-case`,
      });
      continue;
    }

    markers.push({ label, kind: kindForPrefix(prefix), index, raw });
  }

  return { markers, malformed };
}
