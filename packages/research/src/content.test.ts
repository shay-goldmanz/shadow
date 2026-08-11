import { describe, expect, test } from "bun:test";
import { extractMainContent, normalizeNfcWs } from "./content.ts";

describe("normalizeNfcWs", () => {
  test("NFC-normalizes decomposed Unicode to composed form", () => {
    // Built entirely from \u escapes (no literal accented glyphs in source)
    // so the test is unambiguous about which form is which.
    const decomposed = "café"; // "e" (U+0065) + combining acute accent (U+0301)
    const composed = "café"; // precomposed "e-acute" (U+00E9)
    expect(decomposed).not.toBe(composed); // sanity: genuinely different strings pre-normalization
    expect(normalizeNfcWs(decomposed)).toBe(normalizeNfcWs(composed));
    expect(normalizeNfcWs(decomposed)).toBe(composed);
  });

  test("collapses runs of whitespace to a single space", () => {
    expect(normalizeNfcWs("hello    world")).toBe("hello world");
    expect(normalizeNfcWs("hello\t\t\tworld")).toBe("hello world");
    expect(normalizeNfcWs("hello \t \t world")).toBe("hello world");
  });

  test("CRLF and LF line endings normalize identically", () => {
    const crlf = "line one\r\nline two\r\nline three";
    const lf = "line one\nline two\nline three";
    const cr = "line one\rline two\rline three";
    expect(normalizeNfcWs(crlf)).toBe(normalizeNfcWs(lf));
    expect(normalizeNfcWs(crlf)).toBe(normalizeNfcWs(cr));
    expect(normalizeNfcWs(lf)).toBe("line one line two line three");
  });

  test("trims leading and trailing whitespace, including newlines", () => {
    expect(normalizeNfcWs("   hello world   ")).toBe("hello world");
    expect(normalizeNfcWs("\n\n  hello world  \n\n")).toBe("hello world");
  });

  test("a blank/whitespace-only string normalizes to the empty string", () => {
    expect(normalizeNfcWs("   \n\t  ")).toBe("");
  });
});

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
