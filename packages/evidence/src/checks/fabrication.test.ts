/**
 * The headline acceptance property, exercised end to end: **a chapter
 * cannot pass the audit while carrying a claim its own cited source
 * contradicts.**
 *
 * This is the exact scenario the Wave 2 review demonstrated, by execution,
 * as a live hole (C-1): a snapshot says *"...standardized every sidebar
 * measurement on an 8 px grid..."*; the sidecar's `selector.exact` says
 * *"...on an 4 px grid..."* (edit distance 2 — a fabrication, not a typo).
 * Before D24's fix, this passed the entire audit: C2 resolved the selector
 * *fuzzily* (a mere warning, not a failure) because fuzzy anchoring was
 * enabled against a pinned snapshot; the numeric sub-check compared the
 * claim's "4" against the fabricated quote's *own* "4" (of course it
 * matched — it's the same string); and C3's judge was hand the fabricated
 * quote itself rather than anything resolved from the store, so it too
 * judged the fabrication against itself.
 *
 * D24 closes both halves: C2 resolves exact-only against the pinned
 * snapshot (no fuzzy escape hatch), and both the numeric sub-check and the
 * C3 judge read the *resolved* stored snapshot slice, never the claim's own
 * `selector.exact`. This test proves the fix holds even against a
 * maximally uncooperative judge — one that would happily approve the
 * fabrication if it ever saw it — because the fabricated text is
 * structurally never routed to it.
 */

import { describe, expect, test } from "bun:test";
import { sha256Of } from "../digest.ts";
import type {
  CheckWorthinessClassifier,
  CheckWorthinessInput,
  CheckWorthinessVerdict,
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
} from "../test-helpers.ts";
import { runFullAudit } from "./tier2.ts";

/** Always classifies unmarked sentences as ordinary connective prose — irrelevant to this scenario, which is about the *marked* claim's own fabricated citation. */
class ConnectiveProseClassifier implements CheckWorthinessClassifier {
  async classify(
    inputs: readonly CheckWorthinessInput[],
  ): Promise<readonly CheckWorthinessVerdict[]> {
    return inputs.map(() => ({ checkRequired: false, rationale: "connective prose" }));
  }
}

/**
 * A deliberately *permissive* judge: it approves any claim whose candidate
 * evidence contains the fabricated numeral, and only reports `unsupported`
 * when it genuinely has nothing to go on. This is the strongest possible
 * adversary for this test — a judge that a leaked fabrication would fool —
 * so a passing test proves the fabrication never reaches it, not merely
 * that a well-behaved judge happens to reject it.
 */
class GullibleJudge implements EntailmentRelevanceJudge {
  calls: EntailmentRelevanceInput[][] = [];
  async judge(
    inputs: readonly EntailmentRelevanceInput[],
  ): Promise<readonly EntailmentRelevanceVerdict[]> {
    this.calls.push([...inputs]);
    return inputs.map((input) => ({
      entailment: {
        status: input.candidates.length > 0 ? "supported" : "unsupported",
        rationale:
          input.candidates.length > 0
            ? "approved — I'll believe whatever text I'm handed"
            : "no candidates to judge against",
      },
      relevance: { relevance: "on-topic", rationale: "on subject" },
    }));
  }
}

describe("the fabrication scenario (D24, Wave 2 review C-1)", () => {
  test("a claim whose selector.exact contradicts its own pinned snapshot is blocked, end to end", async () => {
    const realSnapshotText =
      "The team standardized every sidebar measurement on an 8 px grid, discarding the old ad-hoc spacing.";
    // Fabricated: "8" silently changed to "4" (edit distance 2 in the
    // surrounding text) — exactly the review's reproduction. This text does
    // NOT appear in `realSnapshotText`.
    const fabricatedExact =
      "The team standardized every sidebar measurement on an 4 px grid, discarding the old ad-hoc spacing.";
    expect(realSnapshotText.includes(fabricatedExact)).toBe(false);

    const hash = sha256Of(realSnapshotText);
    const source = makeSource({
      snapshot: {
        path: `snapshots/${hash}.txt`,
        payloadSha256: sha256Of("raw bytes"),
        normalizedTextSha256: hash,
        normalization: "nfc-ws-v1",
        chars: realSnapshotText.length,
      },
    });

    const chapterBody =
      "Linear standardized its sidebar on a 4 px grid.[^lin-4px] This keeps the interface internally consistent.";

    const claim = makeClaim({
      label: "lin-4px",
      kind: "sourced",
      text: "Linear standardized its sidebar on a 4 px grid.",
      decontextualized: "Linear standardized its sidebar on a 4 px grid.",
      evidence: [
        makeEvidenceSpan({
          sourceId: source.id,
          snapshotHash: hash,
          selector: makeSelector({ exact: fabricatedExact }),
        }),
      ],
    });

    const sidecar = makeSidecar({ chapter: "how-linear-designs-ui", claims: [claim] });
    const lookup = {
      getSource: (id: typeof source.id) => (id === source.id ? source : undefined),
      getSnapshotText: (h: typeof hash) => (h === hash ? realSnapshotText : undefined),
    };

    const judge = new GullibleJudge();

    const result = await runFullAudit({
      chapterBody,
      chapterSubject: "How Linear designs its UI",
      sidecar,
      lookup,
      checkWorthinessClassifier: new ConnectiveProseClassifier(),
      entailmentRelevanceJudge: judge,
    });

    // ---- The headline property: the audit blocks. ----
    expect(result.verdict.passed).toBe(false);

    // ---- C2 (Tier 0, exact-only per D24): blocks structurally. ----
    const c2 = result.outcomes.find((o) => o.checkId === "C2");
    expect(c2?.passed).toBe(false);
    expect(c2?.issues.some((i) => i.code === "unresolved-selector")).toBe(true);
    // No fuzzy escape hatch: this must never appear as a mere warning.
    expect(c2?.warnings?.some((w) => w.code === "anchored-fuzzy")).toBeFalsy();

    // ---- The numeric sub-check independently fails: "4" is not within
    // tolerance of anything in the (empty) resolved evidence. ----
    expect(c2?.issues.some((i) => i.code === "numeric-mismatch")).toBe(true);

    // ---- C3: even a judge willing to approve whatever it's handed never
    // saw the fabricated text — its candidate list was empty, so it
    // (correctly) reports unsupported rather than rubber-stamping it. ----
    expect(judge.calls).toHaveLength(1);
    const request = judge.calls[0]?.[0];
    expect(request?.candidates).toEqual([]);
    for (const call of judge.calls) {
      for (const input of call) {
        for (const candidate of input.candidates) {
          expect(candidate.exact).not.toContain("4 px");
          expect(candidate.exact).not.toBe(fabricatedExact);
        }
      }
    }
    const c3 = result.outcomes.find((o) => o.checkId === "C3");
    expect(c3?.passed).toBe(false);
    expect(c3?.issues.some((i) => i.label === "lin-4px")).toBe(true);
    expect(result.sidecar.claims[0]?.verification.status).toBe("unsupported");
  });

  test("control: the same claim passes when its selector.exact genuinely matches the snapshot", async () => {
    const realSnapshotText =
      "The team standardized every sidebar measurement on an 8 px grid, discarding the old ad-hoc spacing.";
    const hash = sha256Of(realSnapshotText);
    const source = makeSource({
      snapshot: {
        path: `snapshots/${hash}.txt`,
        payloadSha256: sha256Of("raw bytes"),
        normalizedTextSha256: hash,
        normalization: "nfc-ws-v1",
        chars: realSnapshotText.length,
      },
    });

    const chapterBody =
      "Linear standardized its sidebar on an 8 px grid.[^lin-8px] This keeps the interface internally consistent.";

    const claim = makeClaim({
      label: "lin-8px",
      kind: "sourced",
      text: "Linear standardized its sidebar on an 8 px grid.",
      decontextualized: "Linear standardized its sidebar on an 8 px grid.",
      evidence: [
        makeEvidenceSpan({
          sourceId: source.id,
          snapshotHash: hash,
          selector: makeSelector({ exact: realSnapshotText }),
        }),
      ],
    });

    const sidecar = makeSidecar({ chapter: "how-linear-designs-ui", claims: [claim] });
    const lookup = {
      getSource: (id: typeof source.id) => (id === source.id ? source : undefined),
      getSnapshotText: (h: typeof hash) => (h === hash ? realSnapshotText : undefined),
    };

    const result = await runFullAudit({
      chapterBody,
      chapterSubject: "How Linear designs its UI",
      sidecar,
      lookup,
      checkWorthinessClassifier: new ConnectiveProseClassifier(),
      entailmentRelevanceJudge: new GullibleJudge(),
    });

    const c2 = result.outcomes.find((o) => o.checkId === "C2");
    expect(c2?.passed).toBe(true);
    expect(result.verdict.passed).toBe(true);
  });
});
