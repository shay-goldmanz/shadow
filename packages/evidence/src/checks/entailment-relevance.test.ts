import { describe, expect, test } from "bun:test";
import { sha256Of } from "../digest.ts";
import { computeInputHash } from "../input-hash.ts";
import type {
  EntailmentRelevanceInput,
  EntailmentRelevanceJudge,
  EntailmentRelevanceVerdict,
} from "../ports.ts";
import {
  makeClaim,
  makeEvidenceSpan,
  makeSelector,
  makeSidecar,
  makeVerification,
} from "../test-helpers.ts";
import { judgeEntailmentAndRelevance } from "./entailment-relevance.ts";

class RecordingJudge implements EntailmentRelevanceJudge {
  calls: EntailmentRelevanceInput[][] = [];
  constructor(
    private readonly responder: (input: EntailmentRelevanceInput) => EntailmentRelevanceVerdict,
  ) {}
  async judge(
    inputs: readonly EntailmentRelevanceInput[],
  ): Promise<readonly EntailmentRelevanceVerdict[]> {
    this.calls.push([...inputs]);
    return inputs.map(this.responder);
  }
}

function hashFor(claim: ReturnType<typeof makeClaim>) {
  return computeInputHash({
    decontextualized: claim.decontextualized,
    evidence: claim.evidence.map((e) => ({
      exact: e.selector.exact,
      snapshotHash: e.snapshotHash,
    })),
    supports: claim.supports,
  });
}

describe("judgeEntailmentAndRelevance (C3 + C5)", () => {
  test("supported, partial, unsupported statuses flow through to C3", async () => {
    const supported = makeClaim({
      label: "supported",
      decontextualized: "Linear uses a 4px grid.",
      evidence: [
        makeEvidenceSpan({ selector: makeSelector({ exact: "every measurement is 4px" }) }),
      ],
    });
    const partial = makeClaim({
      label: "partial",
      decontextualized: "Notion always uses generous whitespace.",
      evidence: [
        makeEvidenceSpan({ selector: makeSelector({ exact: "we lean toward more whitespace" }) }),
      ],
    });
    const unsupported = makeClaim({
      label: "unsupported",
      decontextualized: "Figma invented the 4px grid.",
      evidence: [makeEvidenceSpan({ selector: makeSelector({ exact: "unrelated text" }) })],
    });
    const sidecar = makeSidecar({ claims: [supported, partial, unsupported] });

    const judge = new RecordingJudge((input) => {
      const status =
        input.claimId === supported.id
          ? "supported"
          : input.claimId === partial.id
            ? "partial"
            : "unsupported";
      return {
        entailment: { status, rationale: `judged ${status}` },
        relevance: { relevance: "on-topic", rationale: "on subject" },
      };
    });

    const currentInputHashes = {
      supported: hashFor(supported),
      partial: hashFor(partial),
      unsupported: hashFor(unsupported),
    };

    const result = await judgeEntailmentAndRelevance({
      sidecar,
      chapterSubject: "UI systems",
      judge,
      currentInputHashes,
    });

    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]).toHaveLength(3);

    expect(result.c3Outcome.passed).toBe(false);
    expect(result.c3Outcome.issues).toHaveLength(1);
    expect(result.c3Outcome.issues[0]?.label).toBe("unsupported");
    expect(result.c3Outcome.warnings?.map((w) => w.label)).toEqual(["partial"]);

    const byLabel = new Map(result.claims.map((c) => [c.label, c]));
    expect(byLabel.get("supported")?.verification.status).toBe("supported");
    expect(byLabel.get("partial")?.verification.status).toBe("partial");
    expect(byLabel.get("unsupported")?.verification.status).toBe("unsupported");
  });

  test("a derived claim that overgeneralizes beyond its supports is flagged", async () => {
    const base1 = makeClaim({
      label: "base-1",
      decontextualized: "Linear uses a strict 4px grid.",
    });
    const base2 = makeClaim({
      label: "base-2",
      decontextualized: "Notion leans on generous whitespace instead of a grid.",
    });
    const derived = makeClaim({
      label: "derived-claim",
      kind: "derived",
      decontextualized: "Every major design tool has abandoned grid systems entirely.",
      supports: ["base-1", "base-2"],
    });
    const sidecar = makeSidecar({ claims: [base1, base2, derived] });

    const judge = new RecordingJudge((input) => {
      if (input.claimId !== derived.id) {
        return {
          entailment: { status: "supported", rationale: "base claim" },
          relevance: { relevance: "on-topic", rationale: "on subject" },
        };
      }
      return {
        entailment: {
          status: "partial",
          rationale: "the two supports describe two specific tools, not 'every major design tool'",
          overgeneralizationRisk: "high",
        },
        relevance: { relevance: "on-topic", rationale: "on subject" },
      };
    });

    const currentInputHashes = {
      "base-1": hashFor(base1),
      "base-2": hashFor(base2),
      "derived-claim": hashFor(derived),
    };

    const result = await judgeEntailmentAndRelevance({
      sidecar,
      chapterSubject: "UI systems",
      judge,
      currentInputHashes,
    });

    // derived candidates are empty; supportingClaims carries the two base claims' text.
    const derivedRequest = judge.calls[0]?.find((r) => r.claimId === derived.id);
    expect(derivedRequest?.candidates).toEqual([]);
    expect(derivedRequest?.supportingClaims).toEqual([
      "Linear uses a strict 4px grid.",
      "Notion leans on generous whitespace instead of a grid.",
    ]);

    const derivedResult = result.claims.find((c) => c.label === "derived-claim");
    expect(derivedResult?.verification.status).toBe("partial");
    expect(derivedResult?.overgeneralizationRisk).toBe("high");
    // partial does not block C3, it warns.
    expect(result.c3Outcome.passed).toBe(true);
    expect(result.c3Outcome.warnings?.some((w) => w.label === "derived-claim")).toBe(true);
  });

  test("a grounded-but-off-topic claim is a C5 warning, never a failure (D15)", async () => {
    const claim = makeClaim({
      label: "off-topic-claim",
      decontextualized: "Figma also supports real-time multiplayer editing.",
      evidence: [makeEvidenceSpan({ selector: makeSelector({ exact: "multiplayer editing" }) })],
    });
    const sidecar = makeSidecar({ claims: [claim] });

    const judge = new RecordingJudge(() => ({
      entailment: { status: "supported", rationale: "fully grounded" },
      relevance: { relevance: "off-topic", rationale: "chapter is about Linear, not Figma" },
    }));

    const result = await judgeEntailmentAndRelevance({
      sidecar,
      chapterSubject: "How Linear designs its UI",
      judge,
      currentInputHashes: { "off-topic-claim": hashFor(claim) },
    });

    expect(result.c3Outcome.passed).toBe(true);
    expect(result.c5Outcome.blocking).toBe(false);
    expect(result.c5Outcome.passed).toBe(true);
    expect(result.c5Outcome.issues).toEqual([]);
    expect(result.c5Outcome.warnings).toHaveLength(1);
    expect(result.c5Outcome.warnings?.[0]?.code).toBe("off-topic");
    expect(result.c5Outcome.warnings?.[0]?.label).toBe("off-topic-claim");
  });

  test("memoization: an unchanged claim (matching inputHash, already verified) is never re-judged", async () => {
    const claim = makeClaim({
      label: "stable-claim",
      decontextualized: "Linear uses a 4px grid.",
      evidence: [
        makeEvidenceSpan({ selector: makeSelector({ exact: "every measurement is 4px" }) }),
      ],
    });
    const hash = hashFor(claim);
    const verifiedClaim = {
      ...claim,
      verification: makeVerification({
        status: "supported",
        inputHash: hash,
        relevance: "on-topic",
      }),
    };
    const sidecar = makeSidecar({ claims: [verifiedClaim] });

    const judge = new RecordingJudge(() => {
      throw new Error("should never be called — claim is memoized");
    });

    const result = await judgeEntailmentAndRelevance({
      sidecar,
      chapterSubject: "UI systems",
      judge,
      currentInputHashes: { "stable-claim": hash },
    });

    expect(judge.calls).toHaveLength(0);
    expect(result.claims[0]?.verification.status).toBe("supported");
  });

  test("changing evidence triggers exactly the affected claim, not the whole batch", async () => {
    const stable = makeClaim({
      label: "stable",
      decontextualized: "Linear uses a 4px grid.",
      evidence: [
        makeEvidenceSpan({ selector: makeSelector({ exact: "every measurement is 4px" }) }),
      ],
    });
    const stableHash = hashFor(stable);
    const verifiedStable = {
      ...stable,
      verification: makeVerification({ status: "supported", inputHash: stableHash }),
    };

    const changed = makeClaim({
      label: "changed",
      decontextualized: "Notion leans on generous whitespace.",
      evidence: [makeEvidenceSpan({ selector: makeSelector({ exact: "an old citation" }) })],
    });
    // Stale verification: inputHash from before the evidence was updated.
    const staleVerifiedChanged = {
      ...changed,
      verification: makeVerification({
        status: "supported",
        inputHash: sha256Of("stale-input-hash"),
      }),
    };

    const sidecar = makeSidecar({ claims: [verifiedStable, staleVerifiedChanged] });

    const judge = new RecordingJudge(() => ({
      entailment: { status: "supported", rationale: "re-judged" },
      relevance: { relevance: "on-topic", rationale: "on subject" },
    }));

    await judgeEntailmentAndRelevance({
      sidecar,
      chapterSubject: "UI systems",
      judge,
      currentInputHashes: { stable: stableHash, changed: hashFor(changed) },
    });

    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]).toHaveLength(1);
    expect(judge.calls[0]?.[0]?.claimId).toBe(changed.id);
  });

  test("extractiveness is computed and reported alongside C3", async () => {
    const claim = makeClaim({
      label: "extractive-claim",
      decontextualized: "Every measurement in the sidebar is a multiple of four.",
      evidence: [
        makeEvidenceSpan({
          selector: makeSelector({
            exact: "Every measurement in the sidebar is a multiple of four.",
          }),
        }),
      ],
    });
    const sidecar = makeSidecar({ claims: [claim] });
    const judge = new RecordingJudge(() => ({
      entailment: { status: "supported", rationale: "near-verbatim" },
      relevance: { relevance: "on-topic", rationale: "on subject" },
    }));

    const result = await judgeEntailmentAndRelevance({
      sidecar,
      chapterSubject: "UI systems",
      judge,
      currentInputHashes: { "extractive-claim": hashFor(claim) },
    });

    expect(result.extractiveness["extractive-claim"]).toBeCloseTo(1, 5);
    expect(result.meanExtractiveness).toBeCloseTo(1, 5);
    expect(result.c3Outcome.data).toMatchObject({ meanExtractiveness: expect.any(Number) });
  });
});
