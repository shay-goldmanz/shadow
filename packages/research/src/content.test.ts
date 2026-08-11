import { describe, expect, test } from "bun:test";
import { computeSnapshotDigests } from "@shadow/evidence";
import { extractMainContent } from "./content.ts";

// `normalizeNfcWs` itself (Unicode NFC, whitespace collapse, trim) is
// `@shadow/evidence`'s to own and test (`docs/EVIDENCE.md` amendment 4) --
// see `packages/evidence/src/normalize.test.ts`. This file only tests
// `extractMainContent` (research's job) and the end-to-end composition of
// the two packages across a full HTML document, which is the actual D16
// property -- see the `describe("D16 ...")` block at the bottom of this
// file.

describe("extractMainContent", () => {
  test("strips script and style elements, tag and content", () => {
    const html = `<html><body><p>Keep me</p><script>alert("drop me")</script><style>.x{color:red}</style></body></html>`;
    const text = extractMainContent(html);
    expect(text).toContain("Keep me");
    expect(text).not.toContain("drop me");
    expect(text).not.toContain("color:red");
  });

  test("strips head content entirely", () => {
    const html = `<html><head><title>Not content</title><meta name="x" content="y"></head><body><p>Body text</p></body></html>`;
    const text = extractMainContent(html);
    expect(text).toContain("Body text");
    expect(text).not.toContain("Not content");
  });

  test("strips nav and footer elements, tag and content", () => {
    const html = `<body><nav><a href="/">Home</a></nav><main><p>Article body</p></main><footer>Copyright 2026</footer></body>`;
    const text = extractMainContent(html);
    expect(text).toContain("Article body");
    expect(text).not.toContain("Home");
    expect(text).not.toContain("Copyright 2026");
  });

  test("strips aside elements, tag and content (Fix 2, Wave 1 review)", () => {
    const html = `<body><main><p>Article body</p></main><aside class="related-articles"><h3>Related</h3><a href="/x">Some other post</a></aside></body>`;
    const text = extractMainContent(html);
    expect(text).toContain("Article body");
    expect(text).not.toContain("Related");
    expect(text).not.toContain("Some other post");
  });

  test("known limitation: an ad div or cookie banner sitting directly in <body>/<main> (not wrapped in nav/footer/aside) is NOT stripped", () => {
    // Documented explicitly in this module's doc comment as a known,
    // deliberate gap against D16's "churns on every ad rotation" claim —
    // this test pins that the gap is real rather than accidentally fixed
    // (which would make the doc comment a stale overstatement in the other
    // direction).
    const html = `<body><main><div class="ad-slot">BUY NOW - campaign 4471</div><p>Article body</p></main></body>`;
    const text = extractMainContent(html);
    expect(text).toContain("Article body");
    expect(text).toContain("BUY NOW - campaign 4471");
  });

  test("decodes common named and numeric entities", () => {
    const html = `<p>Fish &amp; chips &mdash; caf&#233; &#x2014; &lt;tag&gt; &nbsp; done</p>`;
    const text = extractMainContent(html);
    expect(text).toContain("Fish & chips");
    expect(text).toContain("café");
    expect(text).toContain("<tag>");
  });

  test("preserves text order and separates adjacent block elements with whitespace", () => {
    const html = `<div><p>First</p><p>Second</p><p>Third</p></div>`;
    const text = extractMainContent(html);
    const normalized = text.replace(/\s+/g, " ").trim();
    expect(normalized).toBe("First Second Third");
    // Order matters, not just presence.
    expect(normalized.indexOf("First")).toBeLessThan(normalized.indexOf("Second"));
    expect(normalized.indexOf("Second")).toBeLessThan(normalized.indexOf("Third"));
  });

  test("strips HTML comments", () => {
    const html = `<p>Visible</p><!-- this is a comment with <p>fake tags</p> --><p>Also visible</p>`;
    const text = extractMainContent(html).replace(/\s+/g, " ").trim();
    expect(text).toBe("Visible Also visible");
  });

  test("is deterministic across repeated runs on the same input", () => {
    const html = `<html><head><title>T</title></head><body><nav>N</nav><p>Body &amp; more</p><footer>F</footer></body></html>`;
    const results = Array.from({ length: 5 }, () => extractMainContent(html));
    const [first] = results;
    if (first === undefined)
      throw new Error("unreachable: Array.from({ length: 5 }) is never empty");
    for (const result of results) {
      expect(result).toBe(first);
    }
  });

  test("unknown named entities are left untouched rather than guessed at", () => {
    const html = `<p>&unknownentity; stays literal</p>`;
    expect(extractMainContent(html)).toContain("&unknownentity; stays literal");
  });
});

/**
 * D16's actual claim (`docs/DECISIONS.md`): a raw digest "churns on every ad
 * rotation, session token, and rendered timestamp, so it fires constantly
 * and gets ignored" — that is the entire justification for the two-digest
 * split. Testing that claim requires the FULL pipeline end to end: real
 * HTML documents through `extractMainContent` (this package) AND
 * `computeSnapshotDigests` (`@shadow/evidence`) together, varying the kind
 * of churn D16 names and asserting `normalizedTextSha256` is unaffected
 * while `payloadSha256` is.
 *
 * This is deliberately a stronger test than `@shadow/evidence`'s own D16
 * test (`normalize.test.ts`), which hand-supplies already-extracted text
 * for both sides and so never exercises extraction at all — it cannot
 * catch a churn source that extraction fails to strip (which is exactly
 * this module's documented limitation; see the module doc comment and the
 * "known limitation" test above).
 */
describe("D16: extraction + normalization end to end (Wave 1 review, Fix 2)", () => {
  function page({
    adSlot,
    cookieBannerText,
    timestamp,
    trackingParam,
  }: {
    adSlot: string;
    cookieBannerText: string;
    timestamp: string;
    trackingParam: string;
  }): string {
    // Boilerplate is placed the way it's actually stripped: an ad slot
    // rendered into an in-page `<aside>` ad rail (a common real-world
    // pattern — Fix 2 adds `<aside>` stripping specifically to catch this),
    // plus a `<footer>`-anchored cookie notice and rendered timestamp
    // (also a common real pattern), plus the pre-existing nav-tracking-param
    // and script-injected-ad-slot churn sources. This deliberately does
    // NOT include a bare `<div class="ad-slot">` sitting directly in
    // `<body>`/`<main>` outside any of those containers — that case is the
    // documented, still-open limitation covered by the "known limitation"
    // test above, not this one.
    return `<html>
<head><title>How Linear designs its UI</title></head>
<body>
  <!-- cache-buster: ${trackingParam} -->
  <nav><a href="/?utm_source=${trackingParam}">Home</a></nav>
  <script>window.__ads = { slot: "${adSlot}" };</script>
  <aside class="ad-rail"><div class="ad-slot">${adSlot}</div></aside>
  <main>
    <p>Linear renders its sidebar on a 4px spacing scale.</p>
    <p>Every measurement is a multiple of four, which removes a whole
    class of alignment bugs from the design system.</p>
  </main>
  <footer>
    <div class="cookie-banner">${cookieBannerText}</div>
    Rendered at ${timestamp}. Copyright Linear.
  </footer>
</body>
</html>`;
  }

  test("an in-body ad div, cookie banner, and rendered timestamp differing between two fetches produce the SAME normalizedTextSha256 but a DIFFERENT payloadSha256", () => {
    const htmlA = page({
      adSlot: "AD-CAMPAIGN-4471",
      cookieBannerText: "We use cookies. Accept all cookies?",
      timestamp: "2026-08-11T09:14:22Z",
      trackingParam: "newsletter_aug",
    });
    const htmlB = page({
      adSlot: "AD-CAMPAIGN-9902-SUMMER-SALE",
      cookieBannerText: "This site uses cookies for a better experience. Got it!",
      timestamp: "2026-08-11T11:47:03Z",
      trackingParam: "twitter_promo_2",
    });

    expect(htmlA).not.toBe(htmlB);

    const bytesA = new TextEncoder().encode(htmlA);
    const bytesB = new TextEncoder().encode(htmlB);

    const digestsA = computeSnapshotDigests(bytesA, extractMainContent(htmlA));
    const digestsB = computeSnapshotDigests(bytesB, extractMainContent(htmlB));

    // The D16 property: the alert trigger is identical. The ad slot,
    // cookie banner, tracking param, and timestamp all live in a
    // <script>, a <div> outside <aside>/<nav>/<footer> that this test
    // deliberately ALSO wraps in <aside> (so it's stripped), a nav
    // <a href>, an HTML comment, and a <footer> — every one of which
    // extraction strips — so none of that churn reaches the normalized
    // text.
    expect(digestsA.normalizedTextSha256).toBe(digestsB.normalizedTextSha256);
    expect(digestsA.normalizedText).toBe(digestsB.normalizedText);

    // The forensic-only digest: different, because the raw bytes differ.
    expect(digestsA.payloadSha256).not.toBe(digestsB.payloadSha256);
  });

  test("normalizedText contains only the durable prose, none of the churny boilerplate this extraction can strip", () => {
    const html = page({
      adSlot: "AD-1",
      cookieBannerText: "We use cookies.",
      timestamp: "2026-08-11T09:14:22Z",
      trackingParam: "x",
    });
    const digests = computeSnapshotDigests(
      new TextEncoder().encode(html),
      extractMainContent(html),
    );
    expect(digests.normalizedText).toContain("Linear renders its sidebar on a 4px spacing scale.");
    expect(digests.normalizedText).not.toContain("2026-08-11T09:14:22Z");
    expect(digests.normalizedText).not.toContain("Home");
    expect(digests.normalizedText).not.toContain("We use cookies.");
    expect(digests.normalizedText).not.toContain("AD-1");
  });
});
