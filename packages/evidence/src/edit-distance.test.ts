import { describe, expect, test } from "bun:test";
import { levenshteinDistance } from "./edit-distance.ts";

describe("levenshteinDistance", () => {
  test("identical strings", () => {
    expect(levenshteinDistance("hello", "hello")).toBe(0);
  });

  test("empty strings", () => {
    expect(levenshteinDistance("", "")).toBe(0);
    expect(levenshteinDistance("abc", "")).toBe(3);
    expect(levenshteinDistance("", "abc")).toBe(3);
  });

  test("single substitution", () => {
    expect(levenshteinDistance("cat", "bat")).toBe(1);
  });

  test("single insertion/deletion", () => {
    expect(levenshteinDistance("cat", "cats")).toBe(1);
    expect(levenshteinDistance("cats", "cat")).toBe(1);
  });

  test("classic kitten/sitting example", () => {
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
  });
});
