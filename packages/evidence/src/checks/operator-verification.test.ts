import { describe, expect, test } from "bun:test";
import { type Sha256Digest, sha256Of } from "../digest.ts";
import { makeClaim, makeEvidenceSpan, makeSelector, makeSidecar } from "../test-helpers.ts";
import { checkOperatorClaims } from "./operator-verification.ts";
import type { EvidenceLookup } from "./source-integrity.ts";

function fakeLookup(snapshots: Record<string, string>): EvidenceLookup {
  return {
    getSource: () => undefined,
    getSnapshotText: (hash: Sha256Digest) => snapshots[hash],
  };
}

describe("checkOperatorClaims (operator-verification)", () => {
  test("an exact quote passes", () => {
    const transcript = "Operator: I really prefer borders over drop shadows for cards.";
    const hash = sha256Of(transcript);
    const sidecar = makeSidecar({
      claims: [
        makeClaim({
          label: "op-borders",
          kind: "operator",
          evidence: [
            makeEvidenceSpan({
              snapshotHash: hash,
              selector: makeSelector({
                exact: "I really prefer borders over drop shadows for cards.",
              }),
            }),
          ],
        }),
      ],
    });
    const result = checkOperatorClaims({ sidecar, lookup: fakeLookup({ [hash]: transcript }) });
    expect(result.passed).toBe(true);
  });

  test("a near-but-not-exact quote fails (the loophole this check closes)", () => {
    const transcript = "Operator: I really prefer borders over drop shadows for cards.";
    const hash = sha256Of(transcript);
    const sidecar = makeSidecar({
      claims: [
        makeClaim({
          label: "op-borders",
          kind: "operator",
          evidence: [
            makeEvidenceSpan({
              snapshotHash: hash,
              // Paraphrased, not a substring of the transcript — even
              // though the meaning is close, this must NOT anchor fuzzily.
              selector: makeSelector({ exact: "I strongly prefer borders over shadows on cards." }),
            }),
          ],
        }),
      ],
    });
    const result = checkOperatorClaims({ sidecar, lookup: fakeLookup({ [hash]: transcript }) });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.code === "operator-quote-not-exact")).toBe(true);
  });

  test("missing transcript snapshot fails", () => {
    const missingHash = sha256Of("never stored");
    const sidecar = makeSidecar({
      claims: [
        makeClaim({
          label: "op-x",
          kind: "operator",
          evidence: [makeEvidenceSpan({ snapshotHash: missingHash })],
        }),
      ],
    });
    const result = checkOperatorClaims({ sidecar, lookup: fakeLookup({}) });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.code === "missing-snapshot")).toBe(true);
  });

  test("an operator claim with no evidence fails", () => {
    const sidecar = makeSidecar({
      claims: [makeClaim({ label: "op-bare", kind: "operator", evidence: [] })],
    });
    const result = checkOperatorClaims({ sidecar, lookup: fakeLookup({}) });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.code === "missing-evidence")).toBe(true);
  });

  test("non-operator claims are ignored entirely", () => {
    const sidecar = makeSidecar({
      claims: [makeClaim({ label: "sourced-one", kind: "sourced", evidence: [] })],
    });
    const result = checkOperatorClaims({ sidecar, lookup: fakeLookup({}) });
    expect(result.passed).toBe(true);
  });
});
