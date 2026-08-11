import { describe, expect, test } from "bun:test";
import { FakeStructuredGenerationPort } from "@shadow/model";
import { type Sha256Digest, sha256Of } from "../digest.ts";
import type { SourceId } from "../ids.ts";
import {
  makeClaim,
  makeEvidenceSpan,
  makeSelector,
  makeSidecar,
  makeSource,
} from "../test-helpers.ts";
import type { SourceRecord } from "../types.ts";
import type { EvidenceLookup } from "./source-integrity.ts";
import { runFullAudit } from "./tier2.ts";
import {
  BatchedCheckWorthinessClassifier,
  BatchedEntailmentRelevanceJudge,
  BatchedIndexAlignmentChecker,
} from "./tier2-adapters.ts";

function lookupFrom(sources: SourceRecord[], snapshots: Record<string, string>): EvidenceLookup {
  const byId = new Map(sources.map((s) => [s.id, s]));
  return {
    getSource: (id: SourceId) => byId.get(id),
    getSnapshotText: (hash: Sha256Digest) => snapshots[hash],
  };
}

/** A grounded, gapless fixture chapter: one marked sourced claim, benign connective prose only. */
function buildFixture() {
  const snapshotText = "Every measurement in the sidebar is a multiple of four.";
  const hash = sha256Of(snapshotText);
  const source = makeSource();
  const chapterBody =
    "Linear renders its sidebar on a 4px spacing scale.[^lin-4px] This is a matter of internal consistency.";
  const claim = makeClaim({
    label: "lin-4px",
    kind: "sourced",
    decontextualized: "Linear renders its sidebar on a strict spacing scale.",
    evidence: [
      makeEvidenceSpan({
        sourceId: source.id,
        snapshotHash: hash,
        selector: makeSelector({ exact: "multiple of four" }),
      }),
    ],
  });
  const sidecar = makeSidecar({ chapter: "how-linear-designs-ui", claims: [claim] });
  const lookup = lookupFrom([source], { [hash]: snapshotText });
  return { chapterBody, claim, sidecar, lookup, source, hash };
}

describe("runFullAudit", () => {
  test("a fully grounded chapter passes Tier 0 and Tier 2 together", async () => {
    const { chapterBody, sidecar, lookup } = buildFixture();

    const checkWorthinessPort = new FakeStructuredGenerationPort([
      { verdicts: [{ checkRequired: false, rationale: "connective prose" }] },
    ]);
    const entailmentPort = new FakeStructuredGenerationPort([
      {
        verdicts: [
          {
            entailment: { status: "supported", rationale: "matches exactly" },
            relevance: { relevance: "on-topic", rationale: "on subject" },
          },
        ],
      },
    ]);

    const result = await runFullAudit({
      chapterBody,
      chapterSubject: "How Linear designs its UI",
      sidecar,
      lookup,
      checkWorthinessClassifier: new BatchedCheckWorthinessClassifier(checkWorthinessPort),
      entailmentRelevanceJudge: new BatchedEntailmentRelevanceJudge(entailmentPort),
    });

    expect(result.verdict.passed).toBe(true);
    expect(result.outcomes.map((o) => o.checkId)).toEqual([
      "C1a",
      "C2",
      "operator-verification",
      "C1b",
      "C3",
      "C5",
    ]);
    expect(result.sidecar.claims[0]?.verification.status).toBe("supported");
    expect(checkWorthinessPort.calls).toHaveLength(1);
    expect(entailmentPort.calls).toHaveLength(1);
  });

  test("an orphan claim from C1b fails the overall verdict, even though Tier 0 is clean", async () => {
    const { sidecar, lookup } = buildFixture();
    const chapterBody =
      "Linear renders its sidebar on a 4px spacing scale.[^lin-4px] Notion secretly redesigns its UI every quarter without telling anyone.";

    const checkWorthinessPort = new FakeStructuredGenerationPort([
      { verdicts: [{ checkRequired: true, rationale: "specific factual claim, uncited" }] },
    ]);
    const entailmentPort = new FakeStructuredGenerationPort([
      {
        verdicts: [
          {
            entailment: { status: "supported", rationale: "matches exactly" },
            relevance: { relevance: "on-topic", rationale: "on subject" },
          },
        ],
      },
    ]);

    const result = await runFullAudit({
      chapterBody,
      chapterSubject: "How Linear designs its UI",
      sidecar,
      lookup,
      checkWorthinessClassifier: new BatchedCheckWorthinessClassifier(checkWorthinessPort),
      entailmentRelevanceJudge: new BatchedEntailmentRelevanceJudge(entailmentPort),
    });

    expect(result.verdict.passed).toBe(false);
    const c1b = result.outcomes.find((o) => o.checkId === "C1b");
    expect(c1b?.passed).toBe(false);
    expect(c1b?.issues[0]?.code).toBe("orphan-claim");
  });

  test("memoization: rerunning an unchanged chapter makes zero model calls", async () => {
    const { chapterBody, sidecar, lookup } = buildFixture();

    const firstCheckWorthinessPort = new FakeStructuredGenerationPort([
      { verdicts: [{ checkRequired: false, rationale: "connective prose" }] },
    ]);
    const firstEntailmentPort = new FakeStructuredGenerationPort([
      {
        verdicts: [
          {
            entailment: { status: "supported", rationale: "matches exactly" },
            relevance: { relevance: "on-topic", rationale: "on subject" },
          },
        ],
      },
    ]);

    const first = await runFullAudit({
      chapterBody,
      chapterSubject: "How Linear designs its UI",
      sidecar,
      lookup,
      checkWorthinessClassifier: new BatchedCheckWorthinessClassifier(firstCheckWorthinessPort),
      entailmentRelevanceJudge: new BatchedEntailmentRelevanceJudge(firstEntailmentPort),
    });

    // Re-run with the exact same chapter body and the sidecar as it now
    // stands after the first audit (as if reloaded from disk) — nothing
    // about any claim or any unmarked sentence has changed.
    const secondCheckWorthinessPort = new FakeStructuredGenerationPort([]);
    const secondEntailmentPort = new FakeStructuredGenerationPort([]);

    const second = await runFullAudit({
      chapterBody,
      chapterSubject: "How Linear designs its UI",
      sidecar: first.sidecar,
      lookup,
      checkWorthinessClassifier: new BatchedCheckWorthinessClassifier(secondCheckWorthinessPort),
      entailmentRelevanceJudge: new BatchedEntailmentRelevanceJudge(secondEntailmentPort),
    });

    expect(secondCheckWorthinessPort.calls).toHaveLength(0);
    expect(secondEntailmentPort.calls).toHaveLength(0);
    expect(second.verdict.passed).toBe(true);
  });

  test("changing one claim's evidence re-judges only that claim, not the whole chapter", async () => {
    const snapshotText = "Every measurement in the sidebar is a multiple of four.";
    const hash = sha256Of(snapshotText);
    const source = makeSource();
    const chapterBody =
      "Linear renders its sidebar on a 4px spacing scale.[^lin-4px] Notion leans on generous whitespace instead.[^notion-ws]";

    const stableClaim = makeClaim({
      label: "lin-4px",
      kind: "sourced",
      decontextualized: "Linear renders its sidebar on a strict spacing scale.",
      evidence: [
        makeEvidenceSpan({
          sourceId: source.id,
          snapshotHash: hash,
          selector: makeSelector({ exact: "multiple of four" }),
        }),
      ],
    });
    const changingClaim = makeClaim({
      label: "notion-ws",
      kind: "sourced",
      decontextualized: "Notion leans on generous whitespace instead of a strict grid.",
      evidence: [
        makeEvidenceSpan({
          sourceId: source.id,
          snapshotHash: hash,
          selector: makeSelector({ exact: "multiple of four" }),
        }),
      ],
    });
    const sidecar = makeSidecar({
      chapter: "linear-and-notion",
      claims: [stableClaim, changingClaim],
    });
    const lookup = lookupFrom([source], { [hash]: snapshotText });

    const firstCheckWorthinessPort = new FakeStructuredGenerationPort([{ verdicts: [] }]);
    const firstEntailmentPort = new FakeStructuredGenerationPort([
      {
        verdicts: [
          {
            entailment: { status: "supported", rationale: "r" },
            relevance: { relevance: "on-topic", rationale: "r" },
          },
          {
            entailment: { status: "supported", rationale: "r" },
            relevance: { relevance: "on-topic", rationale: "r" },
          },
        ],
      },
    ]);

    const first = await runFullAudit({
      chapterBody,
      chapterSubject: "How Linear and Notion design UI",
      sidecar,
      lookup,
      checkWorthinessClassifier: new BatchedCheckWorthinessClassifier(firstCheckWorthinessPort),
      entailmentRelevanceJudge: new BatchedEntailmentRelevanceJudge(firstEntailmentPort),
    });

    // Now change only the second claim's evidence selector.
    const updatedClaims = first.sidecar.claims.map((c) =>
      c.label === "notion-ws"
        ? {
            ...c,
            evidence: [
              makeEvidenceSpan({
                sourceId: source.id,
                snapshotHash: hash,
                selector: makeSelector({ exact: "Every measurement" }),
              }),
            ],
          }
        : c,
    );
    const updatedSidecar = { ...first.sidecar, claims: updatedClaims };

    const secondCheckWorthinessPort = new FakeStructuredGenerationPort([{ verdicts: [] }]);
    const secondEntailmentPort = new FakeStructuredGenerationPort([
      {
        verdicts: [
          {
            entailment: { status: "supported", rationale: "re-judged" },
            relevance: { relevance: "on-topic", rationale: "r" },
          },
        ],
      },
    ]);

    const second = await runFullAudit({
      chapterBody,
      chapterSubject: "How Linear and Notion design UI",
      sidecar: updatedSidecar,
      lookup,
      checkWorthinessClassifier: new BatchedCheckWorthinessClassifier(secondCheckWorthinessPort),
      entailmentRelevanceJudge: new BatchedEntailmentRelevanceJudge(secondEntailmentPort),
    });

    expect(second.verdict.passed).toBe(true);
    // Exactly one generate() call, and its prompt names only the changed
    // claim's decontextualized text — the unchanged claim never re-entered
    // the batch.
    expect(secondEntailmentPort.calls).toHaveLength(1);
    const prompt = secondEntailmentPort.calls[0]?.prompt ?? "";
    expect(prompt).toContain("following 1 claim(s)");
    expect(prompt).toContain("Notion leans on generous whitespace instead of a strict grid.");
    expect(prompt).not.toContain("Linear renders its sidebar on a strict spacing scale.");
  });

  test("C4 runs only when routing metadata changes, and is skipped (memoized) otherwise", async () => {
    const { chapterBody, sidecar, lookup } = buildFixture();

    const checkWorthinessPort = new FakeStructuredGenerationPort([
      { verdicts: [{ checkRequired: false, rationale: "connective prose" }] },
    ]);
    const entailmentPort = new FakeStructuredGenerationPort([
      {
        verdicts: [
          {
            entailment: { status: "supported", rationale: "r" },
            relevance: { relevance: "on-topic", rationale: "r" },
          },
        ],
      },
    ]);
    const indexPort = new FakeStructuredGenerationPort([
      { verdicts: [{ aligned: true, unsupportedAssertions: [] }] },
    ]);

    const first = await runFullAudit({
      chapterBody,
      chapterSubject: "How Linear designs its UI",
      sidecar,
      lookup,
      checkWorthinessClassifier: new BatchedCheckWorthinessClassifier(checkWorthinessPort),
      entailmentRelevanceJudge: new BatchedEntailmentRelevanceJudge(entailmentPort),
      indexNodeSummaries: ["Use this chapter for Linear's spacing system."],
      indexAlignmentChecker: new BatchedIndexAlignmentChecker(indexPort),
    });

    expect(indexPort.calls).toHaveLength(1);
    expect(first.outcomes.map((o) => o.checkId)).toContain("C4");
    expect(first.record.routingMetadataHash).toBeDefined();

    // Second audit: same routing metadata, nothing changed — C4 should not
    // call the model again, but its previous outcome still gates the verdict.
    const secondCheckWorthinessPort = new FakeStructuredGenerationPort([]);
    const secondEntailmentPort = new FakeStructuredGenerationPort([]);
    const secondIndexPort = new FakeStructuredGenerationPort([]);

    const c4Outcome = first.outcomes.find((o) => o.checkId === "C4");

    const second = await runFullAudit({
      chapterBody,
      chapterSubject: "How Linear designs its UI",
      sidecar: first.sidecar,
      lookup,
      checkWorthinessClassifier: new BatchedCheckWorthinessClassifier(secondCheckWorthinessPort),
      entailmentRelevanceJudge: new BatchedEntailmentRelevanceJudge(secondEntailmentPort),
      indexNodeSummaries: ["Use this chapter for Linear's spacing system."],
      indexAlignmentChecker: new BatchedIndexAlignmentChecker(secondIndexPort),
      previousRoutingMetadataHash: first.record.routingMetadataHash,
      previousIndexAlignmentOutcome: c4Outcome,
    });

    expect(secondIndexPort.calls).toHaveLength(0);
    expect(second.outcomes.map((o) => o.checkId)).toContain("C4");
    expect(second.verdict.passed).toBe(true);

    // Third audit: routing metadata actually changes — C4 re-runs.
    const thirdCheckWorthinessPort = new FakeStructuredGenerationPort([]);
    const thirdEntailmentPort = new FakeStructuredGenerationPort([]);
    const thirdIndexPort = new FakeStructuredGenerationPort([
      {
        verdicts: [{ aligned: false, unsupportedAssertions: ["promises real-time collaboration"] }],
      },
    ]);

    const third = await runFullAudit({
      chapterBody,
      chapterSubject: "How Linear designs its UI",
      sidecar: second.sidecar,
      lookup,
      checkWorthinessClassifier: new BatchedCheckWorthinessClassifier(thirdCheckWorthinessPort),
      entailmentRelevanceJudge: new BatchedEntailmentRelevanceJudge(thirdEntailmentPort),
      indexNodeSummaries: [
        "Use this chapter for Linear's spacing system AND real-time collaboration.",
      ],
      indexAlignmentChecker: new BatchedIndexAlignmentChecker(thirdIndexPort),
      previousRoutingMetadataHash: second.record.routingMetadataHash,
    });

    expect(thirdIndexPort.calls).toHaveLength(1);
    expect(third.verdict.passed).toBe(false);
  });

  // ---- I-3 (Wave 2 review): C4's memo key must also depend on chapterClaims ----

  test("I-3: C4 re-runs when chapterClaims change even though routing metadata (frontmatter) does not", async () => {
    const { chapterBody, sidecar, lookup } = buildFixture();

    const checkWorthinessPort = new FakeStructuredGenerationPort([
      { verdicts: [{ checkRequired: false, rationale: "connective prose" }] },
    ]);
    const entailmentPort = new FakeStructuredGenerationPort([
      {
        verdicts: [
          {
            entailment: { status: "supported", rationale: "r" },
            relevance: { relevance: "on-topic", rationale: "r" },
          },
        ],
      },
    ]);
    const indexPort = new FakeStructuredGenerationPort([
      { verdicts: [{ aligned: true, unsupportedAssertions: [] }] },
    ]);

    const first = await runFullAudit({
      chapterBody,
      chapterSubject: "How Linear designs its UI",
      sidecar,
      lookup,
      checkWorthinessClassifier: new BatchedCheckWorthinessClassifier(checkWorthinessPort),
      entailmentRelevanceJudge: new BatchedEntailmentRelevanceJudge(entailmentPort),
      indexNodeSummaries: ["Use this chapter for Linear's 4px spacing system."],
      indexAlignmentChecker: new BatchedIndexAlignmentChecker(indexPort),
    });

    expect(indexPort.calls).toHaveLength(1);
    expect(first.outcomes.find((o) => o.checkId === "C4")?.passed).toBe(true);

    // Second audit: the SAME routing metadata (frontmatter untouched) — the
    // operator deleted the claim that supported it, without touching
    // `when_to_use`. If C4's memo key depended only on the node-summary
    // text, this would incorrectly replay the *first* run's stale
    // "aligned: true" pass on what is now an unsupported promise.
    const emptySidecar = { ...first.sidecar, claims: [] };
    const secondCheckWorthinessPort = new FakeStructuredGenerationPort([]);
    const secondEntailmentPort = new FakeStructuredGenerationPort([]);
    const secondIndexPort = new FakeStructuredGenerationPort([
      {
        verdicts: [
          {
            aligned: false,
            unsupportedAssertions: ["promises a 4px spacing system the chapter no longer claims"],
          },
        ],
      },
    ]);

    const second = await runFullAudit({
      chapterBody,
      chapterSubject: "How Linear designs its UI",
      sidecar: emptySidecar,
      lookup,
      checkWorthinessClassifier: new BatchedCheckWorthinessClassifier(secondCheckWorthinessPort),
      entailmentRelevanceJudge: new BatchedEntailmentRelevanceJudge(secondEntailmentPort),
      indexNodeSummaries: ["Use this chapter for Linear's 4px spacing system."],
      indexAlignmentChecker: new BatchedIndexAlignmentChecker(secondIndexPort),
      previousRoutingMetadataHash: first.record.routingMetadataHash,
      previousIndexAlignmentOutcome: first.outcomes.find((o) => o.checkId === "C4"),
    });

    // C4 must actually re-run — not replay the memoized "aligned: true" —
    // because the claims underneath the summary changed even though the
    // summary text itself did not.
    expect(secondIndexPort.calls).toHaveLength(1);
    expect(second.outcomes.find((o) => o.checkId === "C4")?.passed).toBe(false);
    expect(second.verdict.passed).toBe(false);
  });
});
