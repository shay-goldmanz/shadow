import { describe, expect, test } from "bun:test";
import { toChapterSlug } from "@shadow/core";
import { assembleGroup } from "./assembly.ts";
import type { ConsolidatedRule } from "./merge.ts";
import { publishGroup } from "./publish-group.ts";
import type { TaxonomyGroup } from "./schemas.ts";
import {
  alwaysNarrativeClassifier,
  scriptedClaimRestater,
  scriptedEntailmentJudge,
  withRulebookHarness,
  witnessSourceText,
} from "./test-helpers.ts";

const DOC_TEXT = "Linear uses a 4px spacing grid. We settled on borders instead of shadows.";

function group(overrides: Partial<TaxonomyGroup> = {}): TaxonomyGroup {
  return {
    slug: "layout",
    title: "Layout Rules",
    when_to_use: "Rules about spacing and layout.",
    not_for: "Color and typography.",
    keywords: ["layout"],
    ...overrides,
  };
}

function rule(overrides: Partial<ConsolidatedRule>): ConsolidatedRule {
  return {
    label: "r-aaaaaaaa",
    statement: "Linear uses a 4px spacing grid.",
    normalizedQuotes: ["a 4px spacing grid"],
    proposedGroup: "layout",
    ...overrides,
  };
}

describe("publishGroup — happy path", () => {
  test("a fully-supported group passes the audit, is published, and flips to stable", async () => {
    await withRulebookHarness(async ({ rulebookStore, evidenceStore, rulebookSlug }) => {
      const source = await witnessSourceText(evidenceStore, rulebookSlug, DOC_TEXT);
      await assembleGroup(
        { rulebookStore, evidenceStore },
        { rulebookSlug, sourceId: source.id, group: group(), rules: [rule({})] },
      );

      const result = await publishGroup(
        {
          rulebookStore,
          evidenceStore,
          checkWorthinessClassifier: alwaysNarrativeClassifier,
          entailmentRelevanceJudge: scriptedEntailmentJudge(),
          claimRestater: scriptedClaimRestater(() => {
            throw new Error("restater should not be called on the happy path");
          }),
        },
        rulebookSlug,
        toChapterSlug("layout"),
        new Set(),
      );

      expect(result.verdict.passed).toBe(true);
      expect(result.passed).toBe(true);
      expect(result.repairs).toEqual([]);

      const persisted = await rulebookStore.getGroup(rulebookSlug, toChapterSlug("layout"));
      expect(persisted.status).toBe("stable");
      expect(persisted.verified).toHaveLength(1);
      expect(persisted.verified[0]?.by).toBe("process:audit");

      const audit = await evidenceStore.getAudit(rulebookSlug, toChapterSlug("layout"));
      expect(audit?.verdict.passed).toBe(true);
    });
  });
});

describe("publishGroup — unsupported claims fail the audit and are not published", () => {
  test("a claim the judge always reports unsupported fails the audit; the group stays draft", async () => {
    await withRulebookHarness(async ({ rulebookStore, evidenceStore, rulebookSlug }) => {
      const source = await witnessSourceText(evidenceStore, rulebookSlug, DOC_TEXT);
      await assembleGroup(
        { rulebookStore, evidenceStore },
        {
          rulebookSlug,
          sourceId: source.id,
          group: group(),
          rules: [rule({ statement: "Linear invented the concept of a sidebar." })],
        },
      );

      const result = await publishGroup(
        {
          rulebookStore,
          evidenceStore,
          checkWorthinessClassifier: alwaysNarrativeClassifier,
          entailmentRelevanceJudge: scriptedEntailmentJudge(() => ({
            entailment: { status: "unsupported", rationale: "the cited span never says this" },
            relevance: { relevance: "on-topic", rationale: "on topic" },
          })),
          claimRestater: scriptedClaimRestater((input) => ({
            to: input.text,
            reason: "attempted repair, but the claim genuinely overclaims",
          })),
        },
        rulebookSlug,
        toChapterSlug("layout"),
        new Set(),
      );

      expect(result.verdict.passed).toBe(false);
      expect(result.passed).toBe(false);

      const persisted = await rulebookStore.getGroup(rulebookSlug, toChapterSlug("layout"));
      expect(persisted.status).toBe("draft");
      expect(persisted.verified).toEqual([]);
    });
  });
});

describe("publishGroup — conservative restatement (D9/D21)", () => {
  test("a partial claim is restated within the preservation bound, applied, logged, and then passes", async () => {
    await withRulebookHarness(async ({ rulebookStore, evidenceStore, rulebookSlug }) => {
      const original = "Linear never uses shadows.";
      const restated = "Linear's documentation emphasises borders over shadows.";
      const source = await witnessSourceText(evidenceStore, rulebookSlug, DOC_TEXT);

      await assembleGroup(
        { rulebookStore, evidenceStore },
        {
          rulebookSlug,
          sourceId: source.id,
          group: group(),
          rules: [
            rule({
              statement: original,
              normalizedQuotes: ["We settled on borders instead of shadows"],
            }),
          ],
        },
      );

      const result = await publishGroup(
        {
          rulebookStore,
          evidenceStore,
          checkWorthinessClassifier: alwaysNarrativeClassifier,
          entailmentRelevanceJudge: scriptedEntailmentJudge((input) => ({
            entailment: {
              status: input.decontextualized === original ? "partial" : "supported",
              rationale: "test fixture",
            },
            relevance: { relevance: "on-topic", rationale: "test fixture" },
          })),
          claimRestater: scriptedClaimRestater(() => ({
            to: restated,
            reason: "overclaim: source states a preference, not an absolute",
          })),
        },
        rulebookSlug,
        toChapterSlug("layout"),
        new Set(),
      );

      expect(result.repairs).toHaveLength(1);
      expect(result.repairs[0]?.outcome).toBe("applied");
      expect(result.verdict.passed).toBe(true);
      expect(result.passed).toBe(true);

      const persisted = await rulebookStore.getGroup(rulebookSlug, toChapterSlug("layout"));
      expect(persisted.body).toContain(restated);
      expect(persisted.body).not.toContain(original);

      const ledger = await evidenceStore.readLedger(rulebookSlug);
      const restatedEvents = ledger.filter((e) => e.event === "claim.restated");
      expect(restatedEvents).toHaveLength(1);
      expect(restatedEvents[0]).toMatchObject({ outcome: "applied", to: restated, chapter: "layout" });
    });
  });
});

describe("publishGroup — a content-derived label reappearing after retirement is not a reuse violation", () => {
  test("retire a label (it leaves the group), then re-add the identical claim on a later run — C1a passes", async () => {
    await withRulebookHarness(async ({ rulebookStore, evidenceStore, rulebookSlug }) => {
      const source = await witnessSourceText(evidenceStore, rulebookSlug, DOC_TEXT);
      const groupSlug = toChapterSlug("layout");

      const ruleA = rule({});
      const ruleB = rule({
        label: "r-bbbbbbbb",
        statement: "Linear settled on borders instead of shadows.",
        normalizedQuotes: ["We settled on borders instead of shadows"],
      });

      const deps = {
        rulebookStore,
        evidenceStore,
        checkWorthinessClassifier: alwaysNarrativeClassifier,
        entailmentRelevanceJudge: scriptedEntailmentJudge(),
        claimRestater: scriptedClaimRestater(() => {
          throw new Error("restater should not be called on this happy path");
        }),
      };

      // Run 1: both rules present, publishes clean.
      await assembleGroup(
        { rulebookStore, evidenceStore },
        { rulebookSlug, sourceId: source.id, group: group(), rules: [ruleA, ruleB] },
      );
      const retiredBeforeFirst = await evidenceStore.getRetiredLabels(rulebookSlug, groupSlug);
      const first = await publishGroup(deps, rulebookSlug, groupSlug, retiredBeforeFirst);
      expect(first.passed).toBe(true);

      // Run 2: a doc edit (or finalization nondeterminism) drops ruleA from
      // the group — its label retires.
      await assembleGroup(
        { rulebookStore, evidenceStore },
        { rulebookSlug, sourceId: source.id, group: group(), rules: [ruleB] },
      );
      const retiredAfterRun2 = await evidenceStore.getRetiredLabels(rulebookSlug, groupSlug);
      expect(retiredAfterRun2.has(ruleA.label)).toBe(true);

      const second = await publishGroup(deps, rulebookSlug, groupSlug, retiredAfterRun2);
      expect(second.passed).toBe(true);

      // Run 3: ruleA's identical content re-derives the same label —
      // `getRetiredLabels` still remembers it retired in run 2 (it never
      // forgets), but this is a legitimate re-derivation, not a reuse.
      await assembleGroup(
        { rulebookStore, evidenceStore },
        { rulebookSlug, sourceId: source.id, group: group(), rules: [ruleA, ruleB] },
      );
      const retiredAfterRun3 = await evidenceStore.getRetiredLabels(rulebookSlug, groupSlug);
      expect(retiredAfterRun3.has(ruleA.label)).toBe(true); // still never forgotten

      const third = await publishGroup(deps, rulebookSlug, groupSlug, retiredAfterRun3);

      const reusedLabelIssues = third.outcomes
        .flatMap((outcome) => outcome.issues)
        .filter((issue) => issue.code === "reused-label");
      expect(reusedLabelIssues).toEqual([]);
      expect(third.verdict.passed).toBe(true);
      expect(third.passed).toBe(true);
    });
  });
});
