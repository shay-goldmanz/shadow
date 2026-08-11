import { describe, expect, test } from "bun:test";
import {
  coerceConfidence,
  coerceDateLike,
  coerceRoutingText,
  coerceStringArray,
} from "./routing-fields.ts";

describe("coerceRoutingText", () => {
  test("accepts a plain string (docs/INDEXING.md's own frontmatter example)", () => {
    expect(coerceRoutingText("Designing list views, tables, dashboards.")).toBe(
      "Designing list views, tables, dashboards.",
    );
  });

  test("accepts a string array (as @shadow/core's own test fixtures author it) and joins it", () => {
    expect(coerceRoutingText(["designing a one-pager", "single-page layout"])).toBe(
      "designing a one-pager; single-page layout",
    );
  });

  test("trims whitespace on a plain string", () => {
    expect(coerceRoutingText("  padded  ")).toBe("padded");
  });

  test("undefined, empty string, empty array, and non-string values are all dropped", () => {
    expect(coerceRoutingText(undefined)).toBeUndefined();
    expect(coerceRoutingText("")).toBeUndefined();
    expect(coerceRoutingText("   ")).toBeUndefined();
    expect(coerceRoutingText([])).toBeUndefined();
    expect(coerceRoutingText(42)).toBeUndefined();
    expect(coerceRoutingText([1, 2])).toBeUndefined();
  });
});

describe("coerceStringArray", () => {
  test("passes through a non-empty string array", () => {
    expect(coerceStringArray(["a", "b"])).toEqual(["a", "b"]);
  });

  test("drops empty arrays, non-arrays, and mixed-type arrays", () => {
    expect(coerceStringArray([])).toBeUndefined();
    expect(coerceStringArray("not an array")).toBeUndefined();
    expect(coerceStringArray(["a", 1])).toBeUndefined();
    expect(coerceStringArray(undefined)).toBeUndefined();
  });
});

describe("coerceConfidence", () => {
  test("accepts exactly the three documented values", () => {
    expect(coerceConfidence("high")).toBe("high");
    expect(coerceConfidence("medium")).toBe("medium");
    expect(coerceConfidence("provisional")).toBe("provisional");
  });

  test("rejects anything else", () => {
    expect(coerceConfidence("HIGH")).toBeUndefined();
    expect(coerceConfidence("certain")).toBeUndefined();
    expect(coerceConfidence(1)).toBeUndefined();
    expect(coerceConfidence(undefined)).toBeUndefined();
  });
});

describe("coerceDateLike", () => {
  test("passes through a non-empty string verbatim, trimmed", () => {
    expect(coerceDateLike(" 2026-08-11 ")).toBe("2026-08-11");
  });

  test("drops non-strings and empty strings", () => {
    expect(coerceDateLike("")).toBeUndefined();
    expect(coerceDateLike(undefined)).toBeUndefined();
    expect(coerceDateLike(20260811)).toBeUndefined();
  });
});
