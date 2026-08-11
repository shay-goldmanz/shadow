import { describe, expect, test } from "bun:test";
import { computeSnapshotDigests } from "./content.ts";
import { formatHash, hashOf, sha256Hex } from "./hashing.ts";

describe("sha256Hex / formatHash", () => {
  test("hashes a string and formats it with the sha256: prefix", () => {
    const hex = sha256Hex("hello world");
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(formatHash(hex)).toBe(`sha256:${hex}`);
    expect(hashOf("hello world")).toBe(`sha256:${hex}`);
  });

  test("hashes raw bytes the same way it hashes the equivalent UTF-8 string", () => {
    const text = "hello world";
    const bytes = new TextEncoder().encode(text);
    expect(sha256Hex(bytes)).toBe(sha256Hex(text));
  });

  test("is deterministic", () => {
    expect(sha256Hex("shadow")).toBe(sha256Hex("shadow"));
  });
});

/**
 * The single most important test in this package (D16 / docs/EVIDENCE.md).
 *
 * `payloadSha256` is over raw bytes and MUST churn on cosmetic differences
 * like an ad slot, a rendered timestamp, or a tracking parameter — that is
 * exactly what makes it forensic-only and unsuitable for alerting.
 * `normalizedTextSha256` is over extracted-and-normalized text and MUST
 * stay stable across those same cosmetic differences — that is what makes
 * it the sole staleness trigger. If this test ever fails, the split that
 * the entire chain-of-evidence staleness story depends on is broken.
 */
describe("D16: payload vs normalized-text digest split", () => {
  // The three "churny" fields all live inside regions extraction actually
  // strips (a script-injected ad slot, a nav-link tracking param, a footer
  // timestamp) — exactly where real-world ad rotation, tracking params, and
  // rendered timestamps live on real pages. The prose in <main> never
  // changes between A and B.
  function page({
    adSlot,
    timestamp,
    trackingParam,
  }: {
    adSlot: string;
    timestamp: string;
    trackingParam: string;
  }): string {
    return `<html>
<head><title>How Linear designs its UI</title></head>
<body>
  <!-- cache-buster: ${trackingParam} -->
  <nav><a href="/?utm_source=${trackingParam}">Home</a></nav>
  <script>window.__ads = { slot: "${adSlot}" };</script>
  <main>
    <p>Linear renders its sidebar on a 4px spacing scale.</p>
    <p>Every measurement is a multiple of four, which removes a whole
    class of alignment bugs from the design system.</p>
  </main>
  <footer>Rendered at ${timestamp}. Copyright Linear.</footer>
</body>
</html>`;
  }

  test("same core content, different ad slot / timestamp / tracking param -> same normalizedTextSha256, different payloadSha256", () => {
    const htmlA = page({
      adSlot: "AD-CAMPAIGN-4471",
      timestamp: "2026-08-11T09:14:22Z",
      trackingParam: "newsletter_aug",
    });
    const htmlB = page({
      adSlot: "AD-CAMPAIGN-9902-SUMMER-SALE",
      timestamp: "2026-08-11T11:47:03Z",
      trackingParam: "twitter_promo_2",
    });

    expect(htmlA).not.toBe(htmlB);

    const bytesA = new TextEncoder().encode(htmlA);
    const bytesB = new TextEncoder().encode(htmlB);

    const digestsA = computeSnapshotDigests(bytesA, htmlA);
    const digestsB = computeSnapshotDigests(bytesB, htmlB);

    // The alert trigger: identical. The ad slot, tracking param, and
    // timestamp all live in a <script>, a nav <a href>, an HTML comment,
    // and a <footer> — every one of which extraction strips — so none of
    // that churn reaches the normalized text at all.
    expect(digestsA.normalizedTextSha256).toBe(digestsB.normalizedTextSha256);
    expect(digestsA.normalizedText).toBe(digestsB.normalizedText);

    // The forensic-only digest: different, because the raw bytes differ.
    expect(digestsA.payloadSha256).not.toBe(digestsB.payloadSha256);
  });

  test("normalizedText contains only the durable prose, none of the churny noise", () => {
    const html = page({
      adSlot: "AD-1",
      timestamp: "2026-08-11T09:14:22Z",
      trackingParam: "x",
    });
    const { normalizedText } = computeSnapshotDigests(new TextEncoder().encode(html), html);
    expect(normalizedText).toContain("Linear renders its sidebar on a 4px spacing scale.");
    expect(normalizedText).not.toContain("2026-08-11T09:14:22Z");
    expect(normalizedText).not.toContain("Home");
  });

  test("normalization label and char count are reported", () => {
    const html = page({ adSlot: "AD-1", timestamp: "t", trackingParam: "x" });
    const digests = computeSnapshotDigests(new TextEncoder().encode(html), html);
    expect(digests.normalization).toBe("nfc-ws-v1");
    expect(digests.chars).toBe(digests.normalizedText.length);
    expect(digests.chars).toBeGreaterThan(0);
  });

  test("truly identical raw bytes produce identical digests on both sides", () => {
    const html = page({ adSlot: "AD-1", timestamp: "t", trackingParam: "x" });
    const bytes = new TextEncoder().encode(html);
    const first = computeSnapshotDigests(bytes, html);
    const second = computeSnapshotDigests(bytes, html);
    expect(first.payloadSha256).toBe(second.payloadSha256);
    expect(first.normalizedTextSha256).toBe(second.normalizedTextSha256);
  });
});
