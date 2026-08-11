/**
 * Content extraction — step 1 of the `nfc-ws-v1` normalization algorithm
 * (`docs/EVIDENCE.md`, "Normalization and anchoring"; `docs/DECISIONS.md`
 * D16). Pure functions: no filesystem, no network, no LLM — everything
 * here is unit-testable on plain strings.
 *
 * Steps 2-5 (Unicode NFC normalize, whitespace collapse, trim, and the two
 * digests) are owned exclusively by `@shadow/evidence` (`docs/EVIDENCE.md`
 * amendment 4) — this package imports `normalizeNfcWs` and
 * `computeSnapshotDigests` from there rather than reimplementing them, so
 * the two packages can never drift apart on what `"nfc-ws-v1"` means. See
 * `content.test.ts` for the end-to-end D16 property test that exercises
 * this module's extraction together with evidence's digest computation.
 *
 * **Known limitation against D16's claim.** D16's justification for the
 * two-digest split is that a raw digest "churns on every ad rotation,
 * session token, and rendered timestamp". This module's extraction only
 * strips `<script>`, `<style>`, `<head>`, `<nav>`, `<footer>`, `<aside>`,
 * and HTML comments — boilerplate *outside* those containers (an ad `<div>`
 * or cookie-banner sitting directly in `<body>`, a "related articles"
 * widget, a rendered timestamp printed inline in an article's own markup)
 * is not recognized as boilerplate and survives into the normalized text,
 * so it **will** still churn `normalizedTextSha256`. A real
 * readability/boilerplate-removal algorithm (content-density heuristics,
 * DOM-depth scoring) could catch more of this, but is not deterministic
 * and dependency-free in the way this module deliberately stays — see the
 * `extractMainContent` doc comment below. This is a real, accepted gap,
 * not a claim that extraction solves D16's churn problem in general.
 */

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
 *   4. `<nav>`, `<footer>`, and `<aside>` elements, tag and content both —
 *      the boilerplate/complementary-content containers `docs/EVIDENCE.md`
 *      and HTML5 semantics name explicitly
 *   5. every remaining tag (replaced with a single space, so adjacent
 *      block elements don't glue their text together — e.g.
 *      `<p>Hello</p><p>World</p>` becomes `Hello World`, not `HelloWorld`)
 *
 * What it keeps: all remaining text content, in the order it appears in
 * the document, with named and numeric HTML entities decoded.
 *
 * **What it does NOT catch (see the module doc for the D16 implication):**
 * an ad block, cookie banner, "related articles" widget, or rendered
 * timestamp that is *not* wrapped in `<nav>`, `<footer>`, or `<aside>` —
 * e.g. `<div class="ad-slot">…</div>` sitting directly in `<body>` or
 * inside `<main>` next to real content. Recognizing those would require
 * either a fixed (and inevitably incomplete) list of class-name/id
 * conventions, or content-density heuristics — both add non-determinism
 * or false positives that would themselves threaten the content hash this
 * feeds. Staying deterministic and dependency-free was chosen over
 * completeness.
 *
 * Known limitation, accepted deliberately: the regex-based stripping of
 * `<head>`, `<nav>`, `<footer>`, `<aside>`, `<script>`, and `<style>` is
 * non-greedy and does not handle *nested* elements of the same tag name
 * (which is not valid HTML for any of these six tags anyway) or
 * unbalanced/broken markup. A real parser would handle those; a real
 * parser is also a dependency and a much larger determinism surface. This
 * is fine for the fixture corpus and for real pages, which are
 * well-formed in exactly the way that matters here.
 */
export function extractMainContent(html: string): string {
  let text = html;

  // 1. comments
  text = text.replace(/<!--[\s\S]*?-->/g, " ");

  // 2. script/style, tag + content
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");

  // 3. head, tag + content
  text = text.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ");

  // 4. nav/footer/aside, tag + content
  text = text.replace(/<(nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");

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
// steps 2-5 (normalize + digest) live in @shadow/evidence — see the module
// doc above and `docs/EVIDENCE.md` amendment 4. Import `normalizeNfcWs`,
// `computeSnapshotDigests`, `SnapshotDigests`, and `NORMALIZATION_ALGORITHM`
// from "@shadow/evidence" rather than looking for them here.
// ---------------------------------------------------------------------------
