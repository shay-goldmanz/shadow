import { describe, expect, test } from "bun:test";
import { estimateTokens } from "./tokens.ts";

describe("estimateTokens", () => {
  test("empty string is 0 tokens", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("uses the chars/4 approximation, rounded up", () => {
    expect(estimateTokens("a")).toBe(1); // ceil(1/4)
    expect(estimateTokens("abcd")).toBe(1); // ceil(4/4)
    expect(estimateTokens("abcde")).toBe(2); // ceil(5/4)
    expect(estimateTokens("a".repeat(800))).toBe(200);
  });

  test("never returns 0 for non-empty input", () => {
    expect(estimateTokens("x")).toBeGreaterThan(0);
  });
});
