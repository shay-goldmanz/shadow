import { describe, expect, test } from "bun:test";
import { parseFootnoteMarkers } from "@shadow/evidence";
import { assembleGroup } from "./assembly.ts";
import type { ConsolidatedRule } from "./merge.ts";
import type { TaxonomyGroup } from "./schemas.ts";
import { withRulebookHarness, witnessSourceText } from "./test-helpers.ts";

const DOC_TEXT =
  "Borrowers must repay principal monthly. Interest accrues daily on the outstanding balance. " +
  "Late payments incur a five percent fee.";

function group(overrides: Partial<TaxonomyGroup> = {}): TaxonomyGroup {
  return {
    slug: "payments",
    title: "Payments",
    when_to_use: "Rules about repayment schedules.",
    not_for: "Collateral and default remedies.",
    keywords: ["payment"],
    ...overrides,
  };
}

function rule(overrides: Partial<ConsolidatedRule>): ConsolidatedRule {
  return {
    label: "r-aaaaaaaa",
    statement: "Borrowers must repay principal monthly.",
    normalizedQuotes: ["Borrowers must repay principal monthly."],
    proposedGroup: "payments",
    ...overrides,
  };
}

describe("assembleGroup", () => {
  test("builds one bullet + one claim per rule, and the body's footnote markers exactly match the claim labels", async () => {
    await withRulebookHarness(async ({ rulebookStore, evidenceStore, rulebookSlug }) => {
      const source = await witnessSourceText(evidenceStore, rulebookSlug, DOC_TEXT);

      const rules = [
        rule({ label: "r-a", statement: "Borrowers must repay principal monthly." }),
        rule({
          label: "r-b",
          statement: "Interest accrues daily on the outstanding balance.",
          normalizedQuotes: ["Interest accrues daily on the outstanding balance."],
        }),
      ];

      const result = await assembleGroup(
        { rulebookStore, evidenceStore },
        { rulebookSlug, sourceId: source.id, group: group(), rules },
      );

      expect(result.droppedQuotes).toBe(0);
      expect(result.droppedRules).toBe(0);
      expect(result.sidecar.claims).toHaveLength(2);
      expect(result.group.body.split("\n")).toEqual([
        "- Borrowers must repay principal monthly.[^r-a]",
        "- Interest accrues daily on the outstanding balance.[^r-b]",
      ]);

      // Marker/claim parity: every footnote marker in the body has a matching claim label, and vice versa.
      const { markers, malformed } = parseFootnoteMarkers(result.group.body);
      expect(malformed).toEqual([]);
      expect(markers.map((m) => m.label).sort()).toEqual(
        result.sidecar.claims.map((c) => c.label).sort(),
      );

      // Every claim is `sourced`, unchecked, and carries exactly one evidence span citing the source.
      for (const claim of result.sidecar.claims) {
        expect(claim.kind).toBe("sourced");
        expect(claim.verification.status).toBe("unchecked");
        expect(claim.evidence).toHaveLength(1);
        expect(claim.evidence[0]?.sourceId).toBe(source.id);
      }

      // Persisted to disk via the store, not just returned in memory.
      const persistedGroup = await rulebookStore.getGroup(rulebookSlug, result.group.slug);
      expect(persistedGroup.body).toBe(result.group.body);
      expect(persistedGroup.status).toBe("draft");
      expect(persistedGroup.type).toBe("Rule Group");
      expect(persistedGroup.frontmatter.when_to_use).toBe(group().when_to_use);

      const persistedSidecar = await evidenceStore.getClaims(rulebookSlug, result.group.slug);
      expect(persistedSidecar?.claims).toHaveLength(2);
    });
  });

  test("drops one failing quote but keeps the rule if another quote survives, counting the drop", async () => {
    await withRulebookHarness(async ({ rulebookStore, evidenceStore, rulebookSlug }) => {
      const source = await witnessSourceText(evidenceStore, rulebookSlug, DOC_TEXT);

      const rules = [
        rule({
          label: "r-a",
          normalizedQuotes: [
            "Borrowers must repay principal monthly.",
            "this quote never appears in the source document",
          ],
        }),
      ];

      const result = await assembleGroup(
        { rulebookStore, evidenceStore },
        { rulebookSlug, sourceId: source.id, group: group(), rules },
      );

      expect(result.droppedQuotes).toBe(1);
      expect(result.droppedRules).toBe(0);
      expect(result.sidecar.claims).toHaveLength(1);
      expect(result.sidecar.claims[0]?.evidence).toHaveLength(1);
    });
  });

  test("drops a rule entirely, and does not put it in the body, when every one of its quotes fails to bind", async () => {
    await withRulebookHarness(async ({ rulebookStore, evidenceStore, rulebookSlug }) => {
      const source = await witnessSourceText(evidenceStore, rulebookSlug, DOC_TEXT);

      const rules = [
        rule({ label: "r-a", statement: "Borrowers must repay principal monthly." }),
        rule({
          label: "r-b",
          statement: "This rule was hallucinated and cites nothing real.",
          normalizedQuotes: ["nothing here is a real quote from the document"],
        }),
      ];

      const result = await assembleGroup(
        { rulebookStore, evidenceStore },
        { rulebookSlug, sourceId: source.id, group: group(), rules },
      );

      expect(result.droppedQuotes).toBe(1);
      expect(result.droppedRules).toBe(1);
      expect(result.sidecar.claims).toHaveLength(1);
      expect(result.sidecar.claims[0]?.label).toBe("r-a");
      expect(result.group.body).not.toContain("hallucinated");
      expect(result.group.body.split("\n")).toHaveLength(1);
    });
  });

  test("carries over a previous run's verification wholesale when a claim's inputHash is unchanged", async () => {
    await withRulebookHarness(async ({ rulebookStore, evidenceStore, rulebookSlug }) => {
      const source = await witnessSourceText(evidenceStore, rulebookSlug, DOC_TEXT);
      const rules = [rule({ label: "r-a", statement: "Borrowers must repay principal monthly." })];

      const first = await assembleGroup(
        { rulebookStore, evidenceStore },
        { rulebookSlug, sourceId: source.id, group: group(), rules },
      );
      expect(first.sidecar.claims[0]?.verification.status).toBe("unchecked");

      // Simulate a prior audit having judged this claim "supported", keeping the same inputHash.
      const auditedSidecar = {
        ...first.sidecar,
        claims: first.sidecar.claims.map((claim) => ({
          ...claim,
          verification: {
            ...claim.verification,
            status: "supported" as const,
            checkedAt: new Date().toISOString(),
            rationale: "test fixture: previously judged supported",
          },
        })),
      };
      await evidenceStore.putClaims(rulebookSlug, auditedSidecar);

      // Re-run assembly over the identical rule (same statement, same quotes => same inputHash).
      const second = await assembleGroup(
        { rulebookStore, evidenceStore },
        { rulebookSlug, sourceId: source.id, group: group(), rules },
      );

      expect(second.sidecar.claims).toHaveLength(1);
      expect(second.sidecar.claims[0]?.verification.status).toBe("supported");
      expect(second.sidecar.claims[0]?.verification.rationale).toBe(
        "test fixture: previously judged supported",
      );
    });
  });

  test("does not carry over verification when the rule's statement (and therefore inputHash) changed", async () => {
    await withRulebookHarness(async ({ rulebookStore, evidenceStore, rulebookSlug }) => {
      const source = await witnessSourceText(evidenceStore, rulebookSlug, DOC_TEXT);
      const original = rule({ label: "r-a", statement: "Borrowers must repay principal monthly." });

      const first = await assembleGroup(
        { rulebookStore, evidenceStore },
        { rulebookSlug, sourceId: source.id, group: group(), rules: [original] },
      );
      const auditedSidecar = {
        ...first.sidecar,
        claims: first.sidecar.claims.map((claim) => ({
          ...claim,
          verification: { ...claim.verification, status: "supported" as const },
        })),
      };
      await evidenceStore.putClaims(rulebookSlug, auditedSidecar);

      // A re-extraction that changed the rule's statement text — different inputHash.
      const changed = rule({
        label: "r-a",
        statement: "Interest accrues daily on the outstanding balance.",
        normalizedQuotes: ["Interest accrues daily on the outstanding balance."],
      });

      const second = await assembleGroup(
        { rulebookStore, evidenceStore },
        { rulebookSlug, sourceId: source.id, group: group(), rules: [changed] },
      );

      expect(second.sidecar.claims[0]?.verification.status).toBe("unchecked");
    });
  });
});
