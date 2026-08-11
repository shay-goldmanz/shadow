import { describe, expect, test } from "bun:test";
import { sha256Of } from "./digest.ts";
import { computeSnapshotDigests, normalizeNfcWs } from "./normalize.ts";

describe("normalizeNfcWs", () => {
  test("NFC-normalizes decomposed Unicode to composed form", () => {
    const decomposed = "café"; // "café" as e + combining acute accent
    const composed = "café";
    expect(normalizeNfcWs(decomposed)).toBe(normalizeNfcWs(composed));
    expect(normalizeNfcWs(decomposed)).toBe("café");
  });

  test("collapses whitespace runs (including newlines and tabs) to a single space", () => {
    expect(normalizeNfcWs("a   b\t\tc")).toBe("a b c");
    expect(normalizeNfcWs("a\n\nb")).toBe("a b");
  });

  test("normalizes CRLF and lone CR line endings before collapsing", () => {
    expect(normalizeNfcWs("a\r\nb\rc\nd")).toBe("a b c d");
  });

  test("trims leading and trailing whitespace", () => {
    expect(normalizeNfcWs("   padded text   ")).toBe("padded text");
  });

  test("idempotent: normalizing twice equals normalizing once", () => {
    const text = "  Some   text\r\nwith\tmixed   whitespace.  ";
    const once = normalizeNfcWs(text);
    expect(normalizeNfcWs(once)).toBe(once);
  });
});

describe("computeSnapshotDigests", () => {
  test("two fetches of the same page with different ads/timestamps produce the SAME normalizedTextSha256 but a DIFFERENT payloadSha256 (D16)", () => {
    // Simulate two raw payloads (e.g. two HTML fetches at different times,
    // with different ad slots / rendered timestamps in the raw bytes) that
    // extraction reduces to the same main-content text, only differing in
    // incidental whitespace/formatting this normalization collapses.
    const rawPayloadFirstFetch =
      '<html><body><div class="ad">Ad slot #4821</div><p>Every measurement in the sidebar is a multiple of four.</p><footer>Rendered at 09:14:22</footer></body></html>';
    const rawPayloadSecondFetch =
      '<html><body><div class="ad">Ad slot #9917 - new campaign</div><p>Every measurement in the sidebar is a multiple of four.</p><footer>Rendered at 14:52:03</footer></body></html>';

    // Extraction (readability-style boilerplate stripping) is upstream of
    // this package (see normalize.ts's module doc) — both fetches extract
    // to the same main content, module whitespace/formatting differences
    // this normalization collapses.
    const extractedFirst = "  Every measurement in the sidebar\n  is a multiple of four.  ";
    const extractedSecond = "Every measurement in the sidebar   is a multiple of four.";

    const first = computeSnapshotDigests(rawPayloadFirstFetch, extractedFirst);
    const second = computeSnapshotDigests(rawPayloadSecondFetch, extractedSecond);

    expect(first.payloadSha256).not.toBe(second.payloadSha256);
    expect(first.normalizedTextSha256).toBe(second.normalizedTextSha256);
    expect(first.normalizedText).toBe(second.normalizedText);
  });

  test("normalizedTextSha256 is the sha256 of the normalized text", () => {
    const digests = computeSnapshotDigests("raw bytes", "  extracted   text  ");
    expect(digests.normalizedText).toBe("extracted text");
    expect(digests.normalizedTextSha256).toBe(sha256Of("extracted text"));
  });

  test("payloadSha256 is the sha256 of the raw payload, untouched by normalization", () => {
    const digests = computeSnapshotDigests("raw   bytes\nwith whitespace", "irrelevant");
    expect(digests.payloadSha256).toBe(sha256Of("raw   bytes\nwith whitespace"));
  });

  test("chars matches the normalized text's length", () => {
    const digests = computeSnapshotDigests("raw", "  hello world  ");
    expect(digests.chars).toBe("hello world".length);
  });

  test("payload digest accepts raw bytes (Uint8Array) as well as strings", () => {
    const bytes = new TextEncoder().encode("raw byte payload");
    const digests = computeSnapshotDigests(bytes, "extracted text");
    expect(digests.payloadSha256).toBe(sha256Of(bytes));
  });
});
