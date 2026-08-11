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
import { runTier0Audit } from "./audit.ts";
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
