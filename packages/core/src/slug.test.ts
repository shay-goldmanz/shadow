import { describe, expect, test } from "bun:test";
import { InvalidSlugError } from "./errors.ts";
import {
  isValidChapterSlug,
  isValidVolumeSlug,
  MAX_SLUG_LENGTH,
  slugify,
  toChapterSlug,
  toVolumeSlug,
} from "./slug.ts";

for (const [kind, toSlug, isValid] of [
  ["volume", toVolumeSlug, isValidVolumeSlug],
  ["chapter", toChapterSlug, isValidChapterSlug],
] as const) {
  describe(`${kind} slugs`, () => {
    test.each([["a"], ["linear-ui"], ["a1-b2-c3"], ["a".repeat(MAX_SLUG_LENGTH)]])(
      "accepts %p",
      (input) => {
        expect(String(toSlug(input))).toBe(input);
        expect(isValid(input)).toBe(true);
      },
    );

    test.each([
      ["", "empty string"],
      ["A", "uppercase"],
      ["Linear-UI", "uppercase"],
      ["a b", "space"],
      ["a_b", "underscore"],
      ["a.b", "dot"],
      ["..", "path traversal (bare)"],
      ["../etc", "path traversal (relative)"],
      ["a/../../etc", "path traversal (embedded)"],
      ["/etc/passwd", "absolute path"],
      ["a/b", "path separator"],
      ["-abc", "leading hyphen"],
      ["abc-", "trailing hyphen"],
      ["a--b", "repeated hyphen"],
      ["a\0b", "null byte"],
      ["a".repeat(MAX_SLUG_LENGTH + 1), "over-long"],
    ])("rejects %p (%s)", (input) => {
      expect(() => toSlug(input)).toThrow(InvalidSlugError);
      expect(isValid(input)).toBe(false);
    });

    test("InvalidSlugError carries the offending kind, input, and a reason", () => {
      try {
        toSlug("../etc");
        throw new Error("expected toSlug to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidSlugError);
        const invalid = error as InvalidSlugError;
        expect(invalid.kind).toBe(kind);
        expect(invalid.input).toBe("../etc");
        expect(invalid.reason.length).toBeGreaterThan(0);
      }
    });
  });
}

describe("slugify", () => {
  test("lowercases and hyphenates a messy title", () => {
    const result = slugify("Épòch Magazine — One-Pagers!");
    expect(result).toBe("epoch-magazine-one-pagers");
    expect(isValidVolumeSlug(result)).toBe(true);
  });

  test("collapses whitespace and punctuation runs into single hyphens", () => {
    expect(slugify("Linear   &&&  Notion")).toBe("linear-notion");
  });

  test("trims leading and trailing separators", () => {
    expect(slugify("  --Hello World--  ")).toBe("hello-world");
  });

  test("truncates to MAX_SLUG_LENGTH without leaving a trailing hyphen", () => {
    const longTitle = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const result = slugify(longTitle);
    expect(result.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(result.endsWith("-")).toBe(false);
    expect(isValidVolumeSlug(result)).toBe(true);
  });

  test("degenerate input with no alphanumeric characters slugifies to an empty, invalid slug", () => {
    const result = slugify("!!!");
    expect(result).toBe("");
    expect(isValidVolumeSlug(result)).toBe(false);
  });
});
