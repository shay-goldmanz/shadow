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
import { checkSourceIntegrity, type EvidenceLookup } from "./source-integrity.ts";

function fakeLookup(sources: SourceRecord[], snapshots: Record<string, string>): EvidenceLookup {
  const byId = new Map(sources.map((s) => [s.id, s]));
  return {
    getSource: (id: SourceId) => byId.get(id),
    getSnapshotText: (hash: Sha256Digest) => snapshots[hash],
  };
}

describe("checkSourceIntegrity (C2)", () => {
  test("passes when everything resolves cleanly", () => {
    const snapshotText = "Every measurement in the sidebar is a multiple of four.";
    const hash = sha256Of(snapshotText);
    const source = makeSource({
      snapshot: {
        path: "snapshots/x.txt",
        payloadSha256: sha256Of("raw"),
        normalizedTextSha256: hash,
        normalization: "nfc-ws-v1",
        chars: snapshotText.length,
      },
    });
    const sidecar = makeSidecar({
      claims: [
        makeClaim({
          label: "lin-4px",
          kind: "sourced",
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
    const result = checkSourceIntegrity({
      sidecar,
      lookup: fakeLookup([source], { [hash]: snapshotText }),
    });
    expect(result.passed).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test("missing source", () => {
    const hash = sha256Of("text");
    const sidecar = makeSidecar({
      claims: [
        makeClaim({
          label: "x",
          kind: "sourced",
          evidence: [
            makeEvidenceSpan({ snapshotHash: hash, selector: makeSelector({ exact: "text" }) }),
          ],
        }),
      ],
    });
    const result = checkSourceIntegrity({ sidecar, lookup: fakeLookup([], {}) });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.code === "missing-source")).toBe(true);
  });

  test("missing snapshot", () => {
    const source = makeSource();
    const missingHash = sha256Of("never stored");
    const sidecar = makeSidecar({
      claims: [
        makeClaim({
          label: "x",
          kind: "sourced",
          evidence: [makeEvidenceSpan({ sourceId: source.id, snapshotHash: missingHash })],
        }),
      ],
    });
    const result = checkSourceIntegrity({ sidecar, lookup: fakeLookup([source], {}) });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.code === "missing-snapshot")).toBe(true);
  });

  test("tampered snapshot: stored content no longer matches its own filename hash", () => {
    const originalText = "The original snapshot text.";
    const hash = sha256Of(originalText);
    const source = makeSource();
    const sidecar = makeSidecar({
      claims: [
        makeClaim({
          label: "x",
          kind: "sourced",
          evidence: [makeEvidenceSpan({ sourceId: source.id, snapshotHash: hash })],
        }),
      ],
    });
    // Simulate corruption: the store returns different content than what
    // was originally hashed to produce this filename/key.
    const tamperedText = "Someone edited this snapshot file by hand.";
    const result = checkSourceIntegrity({
      sidecar,
      lookup: fakeLookup([source], { [hash]: tamperedText }),
    });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.code === "tampered-snapshot")).toBe(true);
  });

  test("a selector that no longer resolves", () => {
    const snapshotText = "This text has completely changed and no longer mentions the old quote.";
    const hash = sha256Of(snapshotText);
    const source = makeSource();
    const sidecar = makeSidecar({
      claims: [
        makeClaim({
          label: "x",
          kind: "sourced",
          evidence: [
            makeEvidenceSpan({
              sourceId: source.id,
              snapshotHash: hash,
              selector: makeSelector({
                exact: "Linear renders its sidebar on a 4px spacing scale.",
              }),
            }),
          ],
        }),
      ],
    });
    const result = checkSourceIntegrity({
      sidecar,
      lookup: fakeLookup([source], { [hash]: snapshotText }),
    });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.code === "unresolved-selector")).toBe(true);
  });

  test("numeric sub-check catches a mismatch via the composed check", () => {
    const snapshotText = "A total of 40 respondents completed the survey.";
    const hash = sha256Of(snapshotText);
    const source = makeSource();
    const sidecar = makeSidecar({
      claims: [
        makeClaim({
          label: "x",
          kind: "sourced",
          text: "The study surveyed 100 respondents.",
          decontextualized: "The study surveyed 100 respondents.",
          evidence: [
            makeEvidenceSpan({
              sourceId: source.id,
              snapshotHash: hash,
              selector: makeSelector({ exact: "A total of 40 respondents completed the survey." }),
            }),
          ],
        }),
      ],
    });
    const result = checkSourceIntegrity({
      sidecar,
      lookup: fakeLookup([source], { [hash]: snapshotText }),
    });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.code === "numeric-mismatch")).toBe(true);
  });
});
