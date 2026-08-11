import { describe, expect, test } from "bun:test";
import { normalizeForHashing } from "./normalize.ts";

describe("normalizeForHashing", () => {
  test("strips per-line trailing whitespace", () => {
    expect(normalizeForHashing("hello   \nworld\t\n")).toBe("hello\nworld\n");
  });

  test("collapses runs of 2+ blank lines to a single blank line", () => {
    expect(normalizeForHashing("a\n\n\n\n\nb\n")).toBe("a\n\nb\n");
  });

  test("converts CRLF and lone CR to LF", () => {
    expect(normalizeForHashing("a\r\nb\rc\n")).toBe("a\nb\nc\n");
  });

  test("is idempotent", () => {
    const once = normalizeForHashing("a   \n\n\n\nb\r\nc  \n");
    expect(normalizeForHashing(once)).toBe(once);
  });

  test("leaves already-clean text unchanged", () => {
    const clean = "line one\nline two\n\nline three\n";
    expect(normalizeForHashing(clean)).toBe(clean);
  });
});
