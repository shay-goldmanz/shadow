import { describe, expect, test } from "bun:test";
import { disambiguateLabels, ruleLabel } from "./labels.ts";

describe("ruleLabel", () => {
  test("is stable across repeated calls on the same statement", () => {
    const statement = "Borrowers must repay principal and interest monthly.";
    expect(ruleLabel(statement)).toBe(ruleLabel(statement));
  });

  test("is insensitive to case and whitespace differences (content-derived, not literal-string-derived)", () => {
    const a = "Borrowers  must repay\nprincipal.";
    const b = "borrowers must repay principal.";
    expect(ruleLabel(a)).toBe(ruleLabel(b));
  });

  test("differs for genuinely different statements", () => {
    expect(ruleLabel("Rule A applies to all borrowers.")).not.toBe(
      ruleLabel("Rule B applies to all lenders."),
    );
  });

  test("has the r- prefix and 8 hex chars", () => {
    const label = ruleLabel("Some statement.");
    expect(label).toMatch(/^r-[0-9a-f]{8}$/);
  });
});

describe("disambiguateLabels", () => {
  test("leaves labels untouched when there is no collision", () => {
    const rules = [{ label: "r-aaaaaaaa" }, { label: "r-bbbbbbbb" }];
    expect(disambiguateLabels(rules)).toEqual(rules);
  });

  test("suffixes a collision with -2, -3, ... in first-seen order", () => {
    const rules = [
      { id: "first", label: "r-aaaaaaaa" },
      { id: "second", label: "r-aaaaaaaa" },
      { id: "third", label: "r-aaaaaaaa" },
    ];
    const result = disambiguateLabels(rules);
    expect(result.map((r) => r.label)).toEqual(["r-aaaaaaaa", "r-aaaaaaaa-2", "r-aaaaaaaa-3"]);
    // Non-label fields are preserved.
    expect(result.map((r) => r.id)).toEqual(["first", "second", "third"]);
  });

  test("tracks collisions per distinct label independently", () => {
    const rules = [
      { label: "r-aaaaaaaa" },
      { label: "r-bbbbbbbb" },
      { label: "r-aaaaaaaa" },
      { label: "r-bbbbbbbb" },
    ];
    expect(disambiguateLabels(rules).map((r) => r.label)).toEqual([
      "r-aaaaaaaa",
      "r-bbbbbbbb",
      "r-aaaaaaaa-2",
      "r-bbbbbbbb-2",
    ]);
  });
});
