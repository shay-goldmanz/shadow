import { describe, expect, test } from "bun:test";
import { FakeStructuredGenerationPort } from "@shadow/model";
import { fixtureClaimId, fixtureSourceId } from "../test-helpers.ts";
import {
  BatchedCheckWorthinessClassifier,
  BatchedClaimRestater,
  BatchedEntailmentRelevanceJudge,
  BatchedIndexAlignmentChecker,
} from "./tier2-adapters.ts";

describe("BatchedCheckWorthinessClassifier", () => {
  test("batches every sentence into one generate() call", async () => {
    const port = new FakeStructuredGenerationPort([
      {
        verdicts: [
          { checkRequired: true, rationale: "specific factual claim" },
          { checkRequired: false, rationale: "connective prose" },
        ],
      },
    ]);
    const classifier = new BatchedCheckWorthinessClassifier(port);

    const verdicts = await classifier.classify([
      { sentence: "Notion redesigns weekly.", context: "...", chapterSubject: "UI systems" },
      { sentence: "This matters a lot.", context: "...", chapterSubject: "UI systems" },
    ]);

    expect(port.calls).toHaveLength(1);
    expect(verdicts).toEqual([
      { checkRequired: true, rationale: "specific factual claim" },
      { checkRequired: false, rationale: "connective prose" },
    ]);
  });

  test("an empty batch never calls the model", async () => {
    const port = new FakeStructuredGenerationPort([]);
    const classifier = new BatchedCheckWorthinessClassifier(port);
    const verdicts = await classifier.classify([]);
    expect(verdicts).toEqual([]);
    expect(port.calls).toHaveLength(0);
  });
});

describe("BatchedEntailmentRelevanceJudge", () => {
  test("batches every claim into one generate() call, combining C3 + C5", async () => {
    const port = new FakeStructuredGenerationPort([
      {
        verdicts: [
          {
            entailment: { status: "supported", rationale: "matches exactly" },
            relevance: { relevance: "on-topic", rationale: "on subject" },
          },
        ],
      },
    ]);
    const judge = new BatchedEntailmentRelevanceJudge(port);

    const verdicts = await judge.judge([
      {
        claimId: fixtureClaimId(),
        decontextualized: "Linear renders its sidebar on a 4px grid.",
        candidates: [
          { exact: "every measurement is a multiple of four", sourceId: fixtureSourceId() },
        ],
        chapterSubject: "UI systems",
      },
    ]);

    expect(port.calls).toHaveLength(1);
    expect(verdicts[0]?.entailment.status).toBe("supported");
    expect(verdicts[0]?.relevance.relevance).toBe("on-topic");
  });
});

describe("BatchedIndexAlignmentChecker", () => {
  test("batches multiple routing-metadata fragments into one call", async () => {
    const port = new FakeStructuredGenerationPort([
      {
        verdicts: [
          { aligned: true, unsupportedAssertions: [] },
          { aligned: false, unsupportedAssertions: ["promises real-time collaboration"] },
        ],
      },
    ]);
    const checker = new BatchedIndexAlignmentChecker(port);

    const verdicts = await checker.check([
      {
        nodeSummary: "Covers Linear's spacing system.",
        chapterClaims: ["Linear uses a 4px grid."],
      },
      {
        nodeSummary: "Covers real-time collaboration in Linear.",
        chapterClaims: ["Linear uses a 4px grid."],
      },
    ]);

    expect(port.calls).toHaveLength(1);
    expect(verdicts[1]?.aligned).toBe(false);
    expect(verdicts[1]?.unsupportedAssertions).toEqual(["promises real-time collaboration"]);
  });
});

describe("BatchedClaimRestater", () => {
  test("batches multiple restatement requests into one call", async () => {
    const port = new FakeStructuredGenerationPort([
      {
        proposals: [
          { to: "Linear's docs emphasise borders over shadows.", reason: "softened absolute" },
        ],
      },
    ]);
    const restater = new BatchedClaimRestater(port);

    const proposals = await restater.restate([
      {
        claimId: fixtureClaimId(),
        label: "lin-shadows",
        verdict: "unsupported",
        text: "Linear never uses shadows.",
        decontextualized: "Linear never uses shadows.",
        evidenceExcerpts: ["we generally avoid heavy drop shadows"],
      },
    ]);

    expect(port.calls).toHaveLength(1);
    expect(proposals[0]?.to).toContain("borders");
  });
});
