import { describe, expect, test } from "bun:test";
import type {
  CheckWorthinessClassifier,
  CheckWorthinessInput,
  CheckWorthinessVerdict,
} from "../ports.ts";
import { checkCheckWorthiness } from "./check-worthiness.ts";

class RecordingClassifier implements CheckWorthinessClassifier {
  calls: CheckWorthinessInput[][] = [];
  constructor(
    private readonly responder: (input: CheckWorthinessInput) => CheckWorthinessVerdict,
  ) {}
  async classify(
    inputs: readonly CheckWorthinessInput[],
  ): Promise<readonly CheckWorthinessVerdict[]> {
    this.calls.push([...inputs]);
    return inputs.map(this.responder);
  }
}

describe("checkCheckWorthiness (C1b)", () => {
  test("flags an unmarked sentence the auditor deems check-worthy as an orphan claim — chapter fails", async () => {
    const chapterBody =
      "Notion secretly redesigns its entire UI every quarter. This is a connective sentence.";
    const classifier = new RecordingClassifier((input) => ({
      checkRequired: input.sentence.includes("secretly redesigns"),
      rationale: "specific factual claim",
    }));

    const { outcome } = await checkCheckWorthiness({
      chapterBody,
      chapterSubject: "How Notion designs its UI",
      classifier,
    });

    expect(outcome.passed).toBe(false);
    expect(outcome.blocking).toBe(true);
    expect(outcome.issues).toHaveLength(1);
    expect(outcome.issues[0]?.code).toBe("orphan-claim");
    expect(outcome.issues[0]?.message).toContain("secretly redesigns");
  });

  test("a chapter of pure connective prose does not fail — checkRequired:false is excluded from both numerator and denominator", async () => {
    const chapterBody =
      "This chapter explains why consistency matters. It helps teams move faster. That is the whole point.";
    const classifier = new RecordingClassifier(() => ({
      checkRequired: false,
      rationale: "connective prose",
    }));

    const { outcome, narrative } = await checkCheckWorthiness({
      chapterBody,
      chapterSubject: "Consistency in design systems",
      classifier,
    });

    expect(outcome.passed).toBe(true);
    expect(outcome.issues).toEqual([]);
    expect(narrative.sentences).toBe(3);
    expect(narrative.ratio).toBe(1);
  });

  test("marked sentences never reach the classifier — silence is what gets audited", async () => {
    const chapterBody =
      "Linear renders its sidebar on a 4px spacing scale.[^lin-4px] An unmarked sentence follows.";
    const classifier = new RecordingClassifier(() => ({ checkRequired: false, rationale: "r" }));

    await checkCheckWorthiness({
      chapterBody,
      chapterSubject: "UI systems",
      classifier,
    });

    expect(classifier.calls).toHaveLength(1);
    expect(classifier.calls[0]).toHaveLength(1);
    expect(classifier.calls[0]?.[0]?.sentence).toBe("An unmarked sentence follows.");
  });

  test("the writer's markup cannot bias classification of a different unmarked sentence", async () => {
    // Two structurally-identical unmarked sentences; the classifier only ever
    // sees `sentence`/`context`/`chapterSubject` — nothing about what else in
    // the chapter was or wasn't marked.
    const chapterBody =
      "Linear renders its sidebar on a 4px scale.[^lin-4px] Notion redesigns weekly. Figma redesigns weekly.";
    const seenSentences: string[] = [];
    const classifier = new RecordingClassifier((input) => {
      seenSentences.push(input.sentence);
      return { checkRequired: true, rationale: "r" };
    });

    await checkCheckWorthiness({ chapterBody, chapterSubject: "UI systems", classifier });

    expect(seenSentences).toEqual(["Notion redesigns weekly.", "Figma redesigns weekly."]);
  });

  test("memoization: an unchanged unmarked sentence is not re-classified", async () => {
    const chapterBody = "This is unchanged connective prose. This one changes each run.";
    const chapterSubject = "Design systems";

    const first = await checkCheckWorthiness({
      chapterBody,
      chapterSubject,
      classifier: new RecordingClassifier(() => ({ checkRequired: false, rationale: "r" })),
    });

    const secondClassifier = new RecordingClassifier((input) => ({
      checkRequired: input.sentence.includes("changes"),
      rationale: "r",
    }));
    const second = await checkCheckWorthiness({
      chapterBody,
      chapterSubject,
      classifier: secondClassifier,
      previousNarrative: first.narrative,
    });

    // Both sentences were already classified with identical hashes last
    // time (chapterBody/chapterSubject unchanged), so nothing new to judge.
    expect(secondClassifier.calls).toHaveLength(0);
    expect(second.outcome.passed).toBe(true);
  });

  test("a genuinely new sentence is classified even when the rest of the chapter is unchanged", async () => {
    const chapterSubject = "Design systems";
    const first = await checkCheckWorthiness({
      chapterBody: "Unchanged connective prose stays the same.",
      chapterSubject,
      classifier: new RecordingClassifier(() => ({ checkRequired: false, rationale: "r" })),
    });

    const secondClassifier = new RecordingClassifier(() => ({
      checkRequired: false,
      rationale: "r",
    }));
    // The new sentence lives in its own paragraph, so the first paragraph's
    // context — and therefore its sentence's memoization hash — is untouched.
    await checkCheckWorthiness({
      chapterBody:
        "Unchanged connective prose stays the same.\n\nA brand new sentence appears here.",
      chapterSubject,
      classifier: secondClassifier,
      previousNarrative: first.narrative,
    });

    expect(secondClassifier.calls).toHaveLength(1);
    expect(secondClassifier.calls[0]).toHaveLength(1);
    expect(secondClassifier.calls[0]?.[0]?.sentence).toBe("A brand new sentence appears here.");
  });
});
