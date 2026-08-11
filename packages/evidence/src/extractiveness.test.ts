import { describe, expect, test } from "bun:test";
import {
  extractivenessOf,
  longestCommonSubstringLength,
  meanExtractiveness,
} from "./extractiveness.ts";

describe("longestCommonSubstringLength", () => {
  test("finds the longest shared run", () => {
    expect(longestCommonSubstringLength("every measurement is four", "measurement is")).toBe(14);
  });

  test("zero for disjoint strings", () => {
    expect(longestCommonSubstringLength("abc", "xyz")).toBe(0);
  });

  test("empty inputs are zero, not an error", () => {
    expect(longestCommonSubstringLength("", "anything")).toBe(0);
    expect(longestCommonSubstringLength("anything", "")).toBe(0);
  });
});

describe("extractivenessOf", () => {
  test("near-verbatim copying scores close to 1", () => {
    const claim = "Every measurement in the sidebar is a multiple of four.";
    const span = "Every measurement in the sidebar is a multiple of four, always.";
    expect(extractivenessOf(claim, span)).toBeGreaterThan(0.95);
  });

  test("a paraphrase with little verbatim overlap scores low", () => {
    const claim = "Linear keeps its spacing consistent across the product.";
    const span = "We settled on a strict grid early on and never looked back.";
    expect(extractivenessOf(claim, span)).toBeLessThan(0.3);
  });
});

describe("meanExtractiveness", () => {
  test("averages across multiple cited spans", () => {
    const claim = "abcdefghij";
    const result = meanExtractiveness(claim, ["abcde", "fghij"]);
    expect(result).toBeCloseTo(0.5, 5);
  });

  test("undefined when there is nothing to compare against", () => {
    expect(meanExtractiveness("a derived claim", [])).toBeUndefined();
  });
});
