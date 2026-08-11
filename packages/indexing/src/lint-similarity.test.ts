import { describe, expect, test } from "bun:test";
import { tokenize, tokenSetJaccard } from "./lint-similarity.ts";

describe("tokenize", () => {
  test("lowercases and splits on non-alphanumeric runs", () => {
    expect(tokenize("Designing List-Views, Tables & Dashboards.")).toEqual([
      "designing",
      "list",
      "views",
      "tables",
      "dashboards",
    ]);
  });

  test("drops empty tokens from leading/trailing punctuation", () => {
    expect(tokenize("  ...hello...  ")).toEqual(["hello"]);
  });
});

describe("tokenSetJaccard", () => {
  test("identical strings score 1.0", () => {
    expect(
      tokenSetJaccard("designing tables and dashboards", "designing tables and dashboards"),
    ).toBe(1);
  });

  test("word order does not affect the score — token *set*, not sequence", () => {
    const a = "designing tables, dashboards, and lists";
    const b = "designing lists, dashboards, and tables";
    expect(tokenSetJaccard(a, b)).toBe(1);
  });

  test("completely disjoint strings score 0", () => {
    expect(tokenSetJaccard("designing dense tables", "writing onboarding copy")).toBe(0);
  });

  test("two empty strings score 0, not 1 — both missing when_to_use is not a collision", () => {
    expect(tokenSetJaccard("", "")).toBe(0);
  });

  test("partial overlap scores strictly between 0 and 1", () => {
    const score = tokenSetJaccard(
      "designing dense tables and lists",
      "designing spacious onboarding flows",
    );
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});
