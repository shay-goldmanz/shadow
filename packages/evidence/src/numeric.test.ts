import { describe, expect, test } from "bun:test";
import { checkNumericConsistency, extractCheckableNumerals, extractNumerals } from "./numeric.ts";

describe("extractNumerals", () => {
  test("extracts a plain integer as one token, not split into chunks", () => {
    const numerals = extractNumerals("The page has 48213 characters.");
    expect(numerals).toHaveLength(1);
    expect(numerals[0]).toMatchObject({ raw: "48213", value: 48213, klass: "plain" });
  });

  test("extracts a comma-grouped number", () => {
    const numerals = extractNumerals("Revenue grew to 3,000 units.");
    expect(numerals).toHaveLength(1);
    expect(numerals[0]).toMatchObject({ raw: "3,000", value: 3000, klass: "plain" });
  });

  test("extracts a percentage as plain", () => {
    const numerals = extractCheckableNumerals("Content drift affects 75% of references.");
    expect(numerals).toHaveLength(1);
    expect(numerals[0]?.value).toBe(75);
  });

  test("classifies an ISO date and excludes it from checkable numerals", () => {
    const all = extractNumerals("Published 2024-03-11.");
    expect(all.some((n) => n.klass === "date")).toBe(true);
    expect(extractCheckableNumerals("Published 2024-03-11.")).toEqual([]);
  });

  test("classifies a hex color and excludes it from checkable numerals", () => {
    const all = extractNumerals("The accent color is #7C9885.");
    expect(all.some((n) => n.klass === "hex")).toBe(true);
    expect(extractCheckableNumerals("The accent color is #7C9885.")).toEqual([]);
  });

  test("classifies a 0x hex literal and excludes it from checkable numerals", () => {
    expect(extractCheckableNumerals("The flag value is 0x1A2B.")).toEqual([]);
  });

  test("classifies a dotted version number and excludes it from checkable numerals", () => {
    expect(extractCheckableNumerals("Shipped in v2.0.1 of the tool.")).toEqual([]);
    expect(extractCheckableNumerals("Bun 1.3.14 executes TypeScript natively.")).toEqual([]);
  });

  test("does not misclassify an ordinary decimal quantity as a version", () => {
    const numerals = extractCheckableNumerals("The budget grew by 4.5 percent.");
    expect(numerals).toHaveLength(1);
    expect(numerals[0]?.value).toBe(4.5);
  });
});

describe("checkNumericConsistency", () => {
  test("passes when the numeral matches exactly", () => {
    const result = checkNumericConsistency("The page has 48213 characters.", [
      "The full extracted text totals 48213 characters after normalization.",
    ]);
    expect(result.passed).toBe(true);
  });

  test("passes within 5% relative tolerance", () => {
    const result = checkNumericConsistency("Roughly 100 respondents took part.", [
      "A total of 104 respondents completed the survey.",
    ]);
    expect(result.passed).toBe(true);
  });

  test("catches a real mismatch beyond tolerance", () => {
    const result = checkNumericConsistency("The study surveyed 100 respondents.", [
      "A total of 40 respondents completed the survey.",
    ]);
    expect(result.passed).toBe(false);
    expect(result.outcomes[0]?.matched).toBe(false);
  });

  test("a claim with no checkable numerals trivially passes", () => {
    const result = checkNumericConsistency("Linear favors borders over shadows.", []);
    expect(result.passed).toBe(true);
    expect(result.outcomes).toEqual([]);
  });

  test("allowlisted classes never cause a false-positive failure even with no matching span", () => {
    const result = checkNumericConsistency(
      "Released as v2.0.1 on 2024-03-11 with accent #7C9885.",
      ["Completely unrelated span mentioning none of those figures."],
    );
    expect(result.passed).toBe(true);
  });
});
