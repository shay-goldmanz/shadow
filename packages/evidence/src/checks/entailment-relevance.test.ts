import { describe, expect, test } from "bun:test";
import { type Sha256Digest, sha256Of } from "../digest.ts";
import type { SourceId } from "../ids.ts";
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
  makeSource,
  makeVerification,
} from "../test-helpers.ts";
import type { SourceRecord } from "../types.ts";
import { computeInputHashes } from "./audit.ts";
import { judgeEntailmentAndRelevance } from "./entailment-relevance.ts";
import type { EvidenceLookup } from "./source-integrity.ts";

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

function lookupFrom(sources: SourceRecord[], snapshots: Record<string, string>): EvidenceLookup {
  const byId = new Map(sources.map((s) => [s.id, s]));
  return {
    getSource: (id: SourceId) => byId.get(id),
    getSnapshotText: (hash: Sha256Digest) => snapshots[hash],
  };
}

/** No sources/snapshots at all — every evidence span in a test using this simply fails to resolve. Fine for tests that don't assert on `candidates` content (a `RecordingJudge`'s fixed responder ignores its input either way). */
function emptyLookup(): EvidenceLookup {
  return lookupFrom([], {});
}

/** A source + snapshot whose *entire* stored text is `text` — so a `selector.exact` of `text` resolves via a trivial exact match, and the resolved text equals `text` back. Lets tests that care about candidate *content* set up real resolution without a lot of ceremony. */
function resolvableSource(text: string): {
  readonly source: SourceRecord;
  readonly hash: Sha256Digest;
} {
  const hash = sha256Of(text);
  const source = makeSource({
    snapshot: {
      path: `snapshots/${hash}.txt`,
      payloadSha256: sha256Of("raw"),
      normalizedTextSha256: hash,
      normalization: "nfc-ws-v1",
      chars: text.length,
    },
  });
  return { source, hash };
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

    const result = await judgeEntailmentAndRelevance({
      sidecar,
      chapterSubject: "UI systems",
      judge,
      currentInputHashes: computeInputHashes(sidecar),
      lookup: emptyLookup(),
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

    const result = await judgeEntailmentAndRelevance({
      sidecar,
      chapterSubject: "UI systems",
      judge,
      currentInputHashes: computeInputHashes(sidecar),
      lookup: emptyLookup(),
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
      currentInputHashes: computeInputHashes(sidecar),
      lookup: emptyLookup(),
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
    const hash = computeInputHashes(makeSidecar({ claims: [claim] }))[
      "stable-claim"
    ] as Sha256Digest;
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
      lookup: emptyLookup(),
    });

    expect(judge.calls).toHaveLength(0);
    expect(result.claims[0]?.verification.status).toBe("supported");
  });

  test("changing one claim's evidence re-judges only that claim, not the whole batch", async () => {
    const stable = makeClaim({
      label: "stable",
      decontextualized: "Linear uses a 4px grid.",
      evidence: [
        makeEvidenceSpan({ selector: makeSelector({ exact: "every measurement is 4px" }) }),
      ],
    });
    const changed = makeClaim({
      label: "changed",
      decontextualized: "Notion leans on generous whitespace.",
      evidence: [makeEvidenceSpan({ selector: makeSelector({ exact: "an old citation" }) })],
    });
    const freshHashes = computeInputHashes(makeSidecar({ claims: [stable, changed] }));
    const stableHash = freshHashes.stable as Sha256Digest;

    const verifiedStable = {
      ...stable,
      verification: makeVerification({ status: "supported", inputHash: stableHash }),
    };
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
      currentInputHashes: freshHashes,
      lookup: emptyLookup(),
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
      currentInputHashes: computeInputHashes(sidecar),
      lookup: emptyLookup(),
    });

    expect(result.extractiveness["extractive-claim"]).toBeCloseTo(1, 5);
    expect(result.meanExtractiveness).toBeCloseTo(1, 5);
    expect(result.c3Outcome.data).toMatchObject({ meanExtractiveness: expect.any(Number) });
  });

  // ---- D24 (Wave 2 review, C-1): the judge reads resolved bytes, never selector.exact ----

  describe("candidatesFor resolves against the pinned snapshot (D24)", () => {
    test("a resolvable span's candidate carries the resolved snapshot text", async () => {
      const realText = "We standardized every sidebar measurement on an 8 px grid.";
      const { source, hash } = resolvableSource(realText);
      const claim = makeClaim({
        label: "lin-8px",
        decontextualized: "Linear standardized its sidebar measurements on an 8 px grid.",
        evidence: [
          makeEvidenceSpan({
            sourceId: source.id,
            snapshotHash: hash,
            selector: makeSelector({ exact: realText }),
          }),
        ],
      });
      const sidecar = makeSidecar({ claims: [claim] });
      const judge = new RecordingJudge(() => ({
        entailment: { status: "supported", rationale: "matches" },
        relevance: { relevance: "on-topic", rationale: "on subject" },
      }));

      await judgeEntailmentAndRelevance({
        sidecar,
        chapterSubject: "UI systems",
        judge,
        currentInputHashes: computeInputHashes(sidecar),
        lookup: lookupFrom([source], { [hash]: realText }),
      });

      expect(judge.calls[0]?.[0]?.candidates).toEqual([{ exact: realText, sourceId: source.id }]);
    });

    test("a fabricated selector.exact is never handed to the judge — the unresolved span is dropped, not laundered through", async () => {
      // The snapshot really says "8 px"; the claim's own selector.exact
      // fabricates "4 px" (small edit distance — this is exactly the case
      // that used to resolve as `anchored-fuzzy` and leak through).
      const realText = "We standardized every sidebar measurement on an 8 px grid.";
      const fabricated = "We standardized every sidebar measurement on an 4 px grid.";
      const { source, hash } = resolvableSource(realText);
      const claim = makeClaim({
        label: "lin-4px-fabricated",
        decontextualized: "Linear standardized its sidebar measurements on a 4 px grid.",
        evidence: [
          makeEvidenceSpan({
            sourceId: source.id,
            snapshotHash: hash,
            selector: makeSelector({ exact: fabricated }),
          }),
        ],
      });
      const sidecar = makeSidecar({ claims: [claim] });

      // A judge that *would* approve the fabricated text if it ever saw it —
      // proving the candidate list genuinely never contains it, rather than
      // relying on the judge to reject it.
      const judge = new RecordingJudge((input) => ({
        entailment: {
          status: input.candidates.some((c) => c.exact.includes("4 px"))
            ? "supported"
            : "unsupported",
          rationale: "test probe",
        },
        relevance: { relevance: "on-topic", rationale: "on subject" },
      }));

      const result = await judgeEntailmentAndRelevance({
        sidecar,
        chapterSubject: "UI systems",
        judge,
        currentInputHashes: computeInputHashes(sidecar),
        lookup: lookupFrom([source], { [hash]: realText }),
      });

      expect(judge.calls[0]?.[0]?.candidates).toEqual([]);
      // With no candidates, the judge (correctly, given nothing to go on)
      // reports unsupported rather than rubber-stamping the fabrication.
      expect(result.claims[0]?.verification.status).toBe("unsupported");
    });
  });

  // ---- Minor (Wave 2 review): operator claims verify at Tier 0, never batched into C3 ----

  test("a fresh operator claim is never sent to the judge — it verifies at Tier 0 only", async () => {
    const operatorClaim = makeClaim({
      label: "op-borders",
      kind: "operator",
      decontextualized: "The operator prefers borders over drop shadows for cards.",
      evidence: [
        makeEvidenceSpan({ selector: makeSelector({ exact: "prefer borders over shadows" }) }),
      ],
    });
    const sourcedClaim = makeClaim({
      label: "lin-4px",
      decontextualized: "Linear uses a 4px grid.",
      evidence: [
        makeEvidenceSpan({ selector: makeSelector({ exact: "every measurement is 4px" }) }),
      ],
    });
    const sidecar = makeSidecar({ claims: [operatorClaim, sourcedClaim] });

    const judge = new RecordingJudge(() => ({
      entailment: { status: "supported", rationale: "r" },
      relevance: { relevance: "on-topic", rationale: "r" },
    }));

    const result = await judgeEntailmentAndRelevance({
      sidecar,
      chapterSubject: "UI systems",
      judge,
      currentInputHashes: computeInputHashes(sidecar),
      lookup: emptyLookup(),
    });

    // Only the sourced claim reaches the judge; the operator claim never does.
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]).toHaveLength(1);
    expect(judge.calls[0]?.[0]?.claimId).toBe(sourcedClaim.id);

    // The operator claim's verification is untouched by C3/C5 — Tier 0's
    // operator-verification check (a separate blocking check) is what
    // actually verifies it.
    const untouchedOperator = result.claims.find((c) => c.label === "op-borders");
    expect(untouchedOperator?.verification.status).toBe("unchecked");
  });
});
