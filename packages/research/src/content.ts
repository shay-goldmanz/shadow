/**
 * Content extraction and the `nfc-ws-v1` normalization algorithm
 * (`docs/EVIDENCE.md`, "Normalization and anchoring"; `docs/DECISIONS.md`
 * D16). Pure functions: no filesystem, no network, no LLM — everything
 * here is unit-testable on plain strings.
 *
 * The five-step algorithm, split across two functions:
 *
 *   1. extract main content (readability-style)      -> extractMainContent
 *   2. Unicode NFC normalize                          \
 *   3. collapse whitespace runs; line endings to \n    > normalizeNfcWs
 *   4. trim                                           /
 *   5. UTF-8 encode; SHA-256                          -> hashing.ts / computeSnapshotDigests
 */

import { formatHash, sha256Hex } from "./hashing.ts";

export const NORMALIZATION_ALGORITHM = "nfc-ws-v1" as const;

// ---------------------------------------------------------------------------
// step 1: extraction
// ---------------------------------------------------------------------------

/**
 * A pragmatic, dependency-free HTML-to-text pass. This is deliberately not
 * a full readability implementation — it does not need to be perfect, it
 * needs to be **deterministic and stable**, because its output feeds a
 * content hash (D16). Given the same HTML, it always produces the same
 * text, in document order.
 *
 * What it strips, in order:
 *   1. HTML comments (`<!-- ... -->`)
 *   2. `<script>` and `<style>` elements, tag and content both
 *   3. `<head>` and its content (metadata, not page content)
 *   4. `<nav>` and `<footer>` elements, tag and content both — the
 *      boilerplate `docs/EVIDENCE.md` names explicitly
 *   5. every remaining tag (replaced with a single space, so adjacent
 *      block elements don't glue their text together — e.g.
 *      `<p>Hello</p><p>World</p>` becomes `Hello World`, not `HelloWorld`)
 *
 * What it keeps: all remaining text content, in the order it appears in
 * the document, with named and numeric HTML entities decoded.
 *
 * Known limitation, accepted deliberately: the regex-based stripping of
 * `<head>`, `<nav>`, `<footer>`, `<script>`, and `<style>` is non-greedy
 * and does not handle *nested* elements of the same tag name (which is
 * not valid HTML for any of these five tags anyway) or unbalanced/broken
 * markup. A real parser would handle those; a real parser is also a
 * dependency and a much larger determinism surface. This is fine for the
 * fixture corpus and for real pages, which are well-formed in exactly the
 * way that matters here.
 */
export function extractMainContent(html: string): string {
  let text = html;

  // 1. comments
  text = text.replace(/<!--[\s\S]*?-->/g, " ");

  // 2. script/style, tag + content
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");

  // 3. head, tag + content
  text = text.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ");

  // 4. nav/footer, tag + content
  text = text.replace(/<(nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");

  // 5. every remaining tag -> single space
  text = text.replace(/<[^>]+>/g, " ");

  return decodeHtmlEntities(text);
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  times: "×",
  divide: "÷",
  deg: "°",
};

/** Decode named and numeric (`&#123;`, `&#x1F600;`) HTML entities. Unknown named entities are left as-is. */
function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const codePoint = Number.parseInt(body.slice(2), 16);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }
    if (body.startsWith("#")) {
      const codePoint = Number.parseInt(body.slice(1), 10);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

// ---------------------------------------------------------------------------
// steps 2-4: normalize
// ---------------------------------------------------------------------------

/**
 * `nfc-ws-v1` steps 2-4: Unicode NFC normalize, collapse whitespace runs
 * (including line endings) to a single space, trim.
 *
 * The CRLF/CR -> LF replacement is applied explicitly, ahead of the
 * whitespace-collapse regex, purely for fidelity to `docs/EVIDENCE.md`'s
 * listed steps ("collapse whitespace runs to a single space; line endings
 * to \n") — the collapse regex (`\s+`) already matches `\r`, `\n`, and
 * `\r\n` alike, so CRLF- and LF-sourced text collapse to an identical
 * single space either way. There is no literal `\n` left in the output:
 * every whitespace run, including multi-line ones, becomes one `" "`.
 */
export function normalizeNfcWs(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\r\n|\r/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// step 5 (partial): digests over raw bytes and normalized text
// ---------------------------------------------------------------------------

export interface SnapshotDigests {
  /** Over the raw fetched bytes — exact-reproduction identity, forensic only, never alerts (D16). */
  readonly payloadSha256: string;
  /** The text this digest was computed over (steps 1-4 applied). */
  readonly normalizedText: string;
  /** Over the normalized text — the sole staleness/re-verification trigger (D16). */
  readonly normalizedTextSha256: string;
  readonly normalization: typeof NORMALIZATION_ALGORITHM;
  readonly chars: number;
}

/**
 * Run the full `nfc-ws-v1` pipeline: extract main content from `html`,
 * normalize it, and hash both the raw payload bytes and the normalized
 * text. This is the function whose output the D16 property test exercises
 * directly — see `content.test.ts`.
 */
export function computeSnapshotDigests(payloadBytes: Uint8Array, html: string): SnapshotDigests {
  const payloadSha256 = formatHash(sha256Hex(payloadBytes));
  const extracted = extractMainContent(html);
  const normalizedText = normalizeNfcWs(extracted);
  const normalizedTextSha256 = formatHash(sha256Hex(normalizedText));
  return {
    payloadSha256,
    normalizedText,
    normalizedTextSha256,
    normalization: NORMALIZATION_ALGORITHM,
    chars: normalizedText.length,
  };
}
