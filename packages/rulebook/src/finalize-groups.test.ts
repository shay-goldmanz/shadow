import { describe, expect, test } from "bun:test";
import { FakeStructuredGenerationPort } from "@shadow/model";
import { finalizeGroups } from "./finalize-groups.ts";
import type { ConsolidatedRule } from "./merge.ts";
import type { TaxonomyGroup } from "./schemas.ts";

function rule(overrides: Partial<ConsolidatedRule>): ConsolidatedRule {
  return {
    label: "r-00000000",
    statement: "Borrowers must repay principal monthly.",
    normalizedQuotes: ["pay principal monthly"],
    proposedGroup: "payments",
    ...overrides,
  };
}

function group(overrides: Partial<TaxonomyGroup>): TaxonomyGroup {
  return {
    slug: "payments",
    title: "Payments",
    when_to_use: "Rules about repayment schedules.",
    not_for: "Collateral and default remedies.",
    keywords: ["payment"],
    ...overrides,
  };
}

describe("finalizeGroups", () => {
  test("short-circuits with no LLM call when there are no rules", async () => {
    const structuredGeneration = new FakeStructuredGenerationPort([]);
    const result = await finalizeGroups(
      { structuredGeneration },
      { rules: [], groups: [group({})] },
    );

    expect(structuredGeneration.calls).toHaveLength(0);
    expect(result.assignments.size).toBe(0);
    expect(result.groups).toEqual([]);
  });

  test("assigns rules to the group the LLM names, dropping empty groups from the final list", async () => {
    const rules = [rule({ label: "r-a" }), rule({ label: "r-b", proposedGroup: "collateral" })];
    const groups = [group({ slug: "payments" }), group({ slug: "collateral" }), group({ slug: "general" })];

    const structuredGeneration = new FakeStructuredGenerationPort([
      { assignments: [{ label: "r-a", group: "payments" }, { label: "r-b", group: "payments" }] },
    ]);

    const result = await finalizeGroups({ structuredGeneration }, { rules, groups });

    expect(result.assignments.get("r-a")).toBe("payments");
    expect(result.assignments.get("r-b")).toBe("payments");
    // "collateral" and "general" got zero rules assigned — dropped.
    expect(result.groups.map((g) => g.slug)).toEqual(["payments"]);
  });

  test("falls back to a rule's own chunk-proposed group when the response omits its label", async () => {
    const rules = [rule({ label: "r-a", proposedGroup: "collateral" })];
    const groups = [group({ slug: "payments" }), group({ slug: "collateral" })];

    const structuredGeneration = new FakeStructuredGenerationPort([{ assignments: [] }]);

    const result = await finalizeGroups({ structuredGeneration }, { rules, groups });

    expect(result.assignments.get("r-a")).toBe("collateral");
  });

  test("routes an unknown group name in the response to general", async () => {
    const rules = [rule({ label: "r-a" })];
    const groups = [group({ slug: "payments" }), group({ slug: "general", title: "General" })];

    const structuredGeneration = new FakeStructuredGenerationPort([
      { assignments: [{ label: "r-a", group: "not-a-real-group" }] },
    ]);

    const result = await finalizeGroups({ structuredGeneration }, { rules, groups });

    expect(result.assignments.get("r-a")).toBe("general");
    expect(result.groups.map((g) => g.slug)).toEqual(["general"]);
  });

  test("splits a group exceeding maxRulesPerGroup into -2, -3, ... in rule order, inheriting parent metadata", async () => {
    const rules = Array.from({ length: 5 }, (_, i) => rule({ label: `r-${i}` }));
    const groups = [group({ slug: "payments", title: "Payments" })];

    const structuredGeneration = new FakeStructuredGenerationPort([
      { assignments: rules.map((r) => ({ label: r.label, group: "payments" })) },
    ]);

    const result = await finalizeGroups(
      { structuredGeneration },
      { rules, groups, maxRulesPerGroup: 2 },
    );

    expect(result.groups.map((g) => g.slug)).toEqual(["payments", "payments-2", "payments-3"]);
    expect(result.groups.map((g) => g.title)).toEqual(["Payments", "Payments (2)", "Payments (3)"]);
    // Every split still carries the parent's routing metadata.
    expect(result.groups.every((g) => g.when_to_use === groups[0]?.when_to_use)).toBe(true);

    expect(result.assignments.get("r-0")).toBe("payments");
    expect(result.assignments.get("r-1")).toBe("payments");
    expect(result.assignments.get("r-2")).toBe("payments-2");
    expect(result.assignments.get("r-3")).toBe("payments-2");
    expect(result.assignments.get("r-4")).toBe("payments-3");
  });

  test("does not split a group exactly at maxRulesPerGroup", async () => {
    const rules = Array.from({ length: 2 }, (_, i) => rule({ label: `r-${i}` }));
    const groups = [group({ slug: "payments" })];

    const structuredGeneration = new FakeStructuredGenerationPort([
      { assignments: rules.map((r) => ({ label: r.label, group: "payments" })) },
    ]);

    const result = await finalizeGroups(
      { structuredGeneration },
      { rules, groups, maxRulesPerGroup: 2 },
    );

    expect(result.groups.map((g) => g.slug)).toEqual(["payments"]);
  });
});
