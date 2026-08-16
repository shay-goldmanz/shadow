import { describe, expect, test } from "bun:test";
import { consolidateRules } from "./merge.ts";
import type { ValidatedRule } from "./validate.ts";

function rule(overrides: Partial<ValidatedRule>): ValidatedRule {
  return {
    statement: "Borrowers must repay principal monthly.",
    normalizedQuotes: ["pay principal monthly"],
    proposedGroup: "payments",
    ...overrides,
  };
}

describe("consolidateRules", () => {
  test("merges the same rule extracted from two chunks (identical statement, different quotes) into one, unioning quotes", () => {
    const a = rule({ normalizedQuotes: ["quote from chunk one"] });
    const b = rule({ normalizedQuotes: ["quote from chunk two"] });

    const result = consolidateRules([a, b]);

    expect(result).toHaveLength(1);
    expect(result[0]?.normalizedQuotes).toEqual(["quote from chunk one", "quote from chunk two"]);
  });

  test("merges on identical normalized quote sets even when statements differ", () => {
    const a = rule({
      statement: "Borrowers must repay monthly.",
      normalizedQuotes: ["shared quote"],
    });
    const b = rule({
      statement: "A different phrasing of the same rule.",
      normalizedQuotes: ["shared quote"],
    });

    const result = consolidateRules([a, b]);

    expect(result).toHaveLength(1);
    expect(result[0]?.normalizedQuotes).toEqual(["shared quote"]);
  });

  test("case-insensitive statement match merges regardless of quote overlap", () => {
    const a = rule({ statement: "Borrowers Must Repay Monthly.", normalizedQuotes: ["quote a"] });
    const b = rule({ statement: "borrowers must repay monthly.", normalizedQuotes: ["quote b"] });

    const result = consolidateRules([a, b]);

    expect(result).toHaveLength(1);
    expect(result[0]?.normalizedQuotes).toEqual(["quote a", "quote b"]);
  });

  test("deduplicates a quote that appears in both merged rules, keeping first-seen order", () => {
    const a = rule({ normalizedQuotes: ["quote one", "quote two"] });
    const b = rule({ normalizedQuotes: ["quote two", "quote three"] });

    const result = consolidateRules([a, b]);

    expect(result[0]?.normalizedQuotes).toEqual(["quote one", "quote two", "quote three"]);
  });

  test("leaves distinct rules (different statement, different quotes) untouched", () => {
    const a = rule({ statement: "Rule about payments.", normalizedQuotes: ["payments quote"] });
    const b = rule({ statement: "Rule about collateral.", normalizedQuotes: ["collateral quote"] });

    const result = consolidateRules([a, b]);

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.statement)).toEqual([a.statement, b.statement]);
  });

  test("assigns a stable content-derived label to each consolidated rule", () => {
    const result = consolidateRules([rule({})]);
    expect(result[0]?.label).toMatch(/^r-[0-9a-f]{8}$/);
  });
});
