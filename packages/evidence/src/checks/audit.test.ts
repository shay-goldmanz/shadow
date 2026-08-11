import { describe, expect, test } from "bun:test";
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
import { computeInputHashes, runTier0Audit } from "./audit.ts";
import type { EvidenceLookup } from "./source-integrity.ts";

function lookupFrom(sources: SourceRecord[], snapshots: Record<string, string>): EvidenceLookup {
  const byId = new Map(sources.map((s) => [s.id, s]));
  return {
    getSource: (id: SourceId) => byId.get(id),
    getSnapshotText: (hash: Sha256Digest) => snapshots[hash],
  };
}

describe("runTier0Audit", () => {
  test("a fully grounded chapter passes every Tier 0 check and reports inputHashes", async () => {
    const snapshotText = "Every measurement in the sidebar is a multiple of four.";
    const hash = sha256Of(snapshotText);
    const source = makeSource();
    const body = "Linear uses a strict 4px grid.[^lin-4px]";
    const sidecar = makeSidecar({
      chapter: "how-linear-designs-ui",
      claims: [
        makeClaim({
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
        }),
      ],
    });

    const result = await runTier0Audit({
      chapterBody: body,
      sidecar,
      lookup: lookupFrom([source], { [hash]: snapshotText }),
    });

    expect(result.verdict.passed).toBe(true);
    expect(result.outcomes.map((o) => o.checkId)).toEqual(["C1a", "C2", "operator-verification"]);
    expect(result.inputHashes["lin-4px"]).toBeDefined();
  });

  test("a single structural failure fails the whole verdict", async () => {
    const body = "An orphan claim with no marker at all.";
    const sidecar = makeSidecar({
      claims: [makeClaim({ label: "unused", kind: "sourced", evidence: [makeEvidenceSpan()] })],
    });
    const result = await runTier0Audit({ chapterBody: body, sidecar, lookup: lookupFrom([], {}) });
    expect(result.verdict.passed).toBe(false);
    const c1a = result.outcomes.find((o) => o.checkId === "C1a");
    expect(c1a?.passed).toBe(false);
  });
});

// ---- I-1 (Wave 2 review): a derived claim's inputHash must cascade from its supports' own hashes ----

describe("computeInputHashes", () => {
  test("a derived claim's inputHash changes when its supporting claim's text changes, even though the derived claim's own text/supports[] label did not (I-1)", () => {
    const derived = makeClaim({
      label: "derived-claim",
      kind: "derived",
      decontextualized: "Both treat spacing as a system-level constraint.",
      supports: ["lin-grid"],
    });

    const before = makeClaim({
      label: "lin-grid",
      decontextualized: "Linear standardizes its sidebar on a 4px grid.",
    });
    const after = makeClaim({
      label: "lin-grid",
      decontextualized: "Linear standardizes its sidebar on an 8px grid.",
    });

    const hashesBefore = computeInputHashes(makeSidecar({ claims: [before, derived] }));
    const hashesAfter = computeInputHashes(makeSidecar({ claims: [after, derived] }));

    // The supporting claim's own hash moved, as expected...
    expect(hashesBefore["lin-grid"]).not.toBe(hashesAfter["lin-grid"]);
    // ...and that must cascade to the derived claim built on it, even
    // though `derived`'s own text and `supports: ["lin-grid"]` label never
    // changed. Hashing the label instead of the target's own inputHash
    // (the bug this test guards) would keep these equal, silently skipping
    // Tier 2 re-judging of a claim whose actual support just changed
    // meaning underneath it.
    expect(hashesBefore["derived-claim"]).not.toBe(hashesAfter["derived-claim"]);
  });

  test("the cascade is transitive through a chain of derived claims", () => {
    const leaf = makeClaim({ label: "leaf", decontextualized: "Linear uses a 4px grid." });
    const mid = makeClaim({
      label: "mid",
      kind: "derived",
      decontextualized: "Spacing is systemic, not per-screen.",
      supports: ["leaf"],
    });
    const top = makeClaim({
      label: "top",
      kind: "derived",
      decontextualized: "Systemic spacing is a hallmark of mature design systems.",
      supports: ["mid"],
    });

    const leafChanged = { ...leaf, decontextualized: "Linear uses an 8px grid." };

    const before = computeInputHashes(makeSidecar({ claims: [leaf, mid, top] }));
    const after = computeInputHashes(makeSidecar({ claims: [leafChanged, mid, top] }));

    expect(before.leaf).not.toBe(after.leaf);
    expect(before.mid).not.toBe(after.mid);
    // `top` supports `mid`, not `leaf`, directly — the change still has to
    // ripple two hops.
    expect(before.top).not.toBe(after.top);
  });
});
