import { describe, expect, test } from "bun:test";
import type {
  IndexAlignmentChecker,
  IndexAlignmentInput,
  IndexAlignmentVerdict,
} from "../ports.ts";
import { checkIndexAlignment, computeRoutingMetadataHash } from "./index-alignment.ts";

class RecordingChecker implements IndexAlignmentChecker {
  calls: IndexAlignmentInput[][] = [];
  constructor(private readonly responder: (input: IndexAlignmentInput) => IndexAlignmentVerdict) {}
  async check(inputs: readonly IndexAlignmentInput[]): Promise<readonly IndexAlignmentVerdict[]> {
    this.calls.push([...inputs]);
    return inputs.map(this.responder);
  }
}

describe("checkIndexAlignment (C4)", () => {
  test("catches a when_to_use promising something the chapter does not deliver", async () => {
    const checker = new RecordingChecker((input) => ({
      aligned: !input.nodeSummary.includes("real-time collaboration"),
      unsupportedAssertions: input.nodeSummary.includes("real-time collaboration")
        ? ["promises real-time collaboration guidance"]
        : [],
    }));

    const outcome = await checkIndexAlignment({
      fragments: [
        {
          nodeSummary:
            "Use this chapter for spacing systems and real-time collaboration patterns in Linear.",
          chapterClaims: [
            "Linear uses a 4px grid.",
            "Linear renders its sidebar with consistent spacing.",
          ],
        },
      ],
      checker,
    });

    expect(outcome.passed).toBe(false);
    expect(outcome.blocking).toBe(true);
    expect(outcome.issues).toHaveLength(1);
    expect(outcome.issues[0]?.message).toContain("real-time collaboration guidance");
  });

  test("an aligned summary passes", async () => {
    const checker = new RecordingChecker(() => ({ aligned: true, unsupportedAssertions: [] }));
    const outcome = await checkIndexAlignment({
      fragments: [
        {
          nodeSummary: "Covers Linear's spacing system.",
          chapterClaims: ["Linear uses a 4px grid."],
        },
      ],
      checker,
    });
    expect(outcome.passed).toBe(true);
    expect(outcome.issues).toEqual([]);
  });

  test("batches multiple fragments into one call", async () => {
    const checker = new RecordingChecker(() => ({ aligned: true, unsupportedAssertions: [] }));
    await checkIndexAlignment({
      fragments: [
        { nodeSummary: "Fragment A", chapterClaims: ["claim"] },
        { nodeSummary: "Fragment B", chapterClaims: ["claim"] },
      ],
      checker,
    });
    expect(checker.calls).toHaveLength(1);
    expect(checker.calls[0]).toHaveLength(2);
  });

  test("no fragments means no call and a trivial pass", async () => {
    const checker = new RecordingChecker(() => {
      throw new Error("should never be called");
    });
    const outcome = await checkIndexAlignment({ fragments: [], checker });
    expect(outcome.passed).toBe(true);
    expect(checker.calls).toHaveLength(0);
  });
});

describe("computeRoutingMetadataHash", () => {
  test("is stable for identical input and changes when input changes", () => {
    const a = computeRoutingMetadataHash(["Use this for spacing.", "Also covers grids."]);
    const b = computeRoutingMetadataHash(["Use this for spacing.", "Also covers grids."]);
    const c = computeRoutingMetadataHash([
      "Use this for spacing and collaboration.",
      "Also covers grids.",
    ]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
