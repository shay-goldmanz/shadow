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
import { checkOperatorClaims } from "./operator-verification.ts";
import type { EvidenceLookup } from "./source-integrity.ts";

/**
 * A fake `EvidenceLookup` that actually resolves sources - unlike the
 * pre-Wave-1-review version of this file, whose `getSource` unconditionally
 * returned `undefined`. That was the structural proof of the C-1 gap: every
 * test still passed even though nothing in the check under test could ever
 * have seen a real source, because nothing exercised `getSource` at all.
 */
function fakeLookup(sources: SourceRecord[], snapshots: Record<string, string>): EvidenceLookup {
  const byId = new Map(sources.map((s) => [s.id, s]));
  return {
    getSource: (id: SourceId) => byId.get(id),
    getSnapshotText: (hash: Sha256Digest) => snapshots[hash],
  };
}

/** A source record whose transport is genuinely `"session"` - the only legitimate origin for operator-claim evidence (D19/D23). */
function sessionSource(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return makeSource({
    ...overrides,
    retrieval: {
      retrievedAt: new Date().toISOString(),
      agent: "shadow-chat",
      transport: "session",
      ...overrides.retrieval,
    },
  });
}

describe("checkOperatorClaims (operator-verification)", () => {
  test("an exact quote against a real session source passes", () => {
    const transcript = "Operator: I really prefer borders over drop shadows for cards.";
    const hash = sha256Of(transcript);
    const source = sessionSource({
      snapshot: {
        path: `snapshots/${hash.slice(7)}.txt`,
        payloadSha256: hash,
        normalizedTextSha256: hash,
        normalization: "nfc-ws-v1",
        chars: transcript.length,
      },
    });
    const sidecar = makeSidecar({
      claims: [
        makeClaim({
          label: "op-borders",
          kind: "operator",
          evidence: [
            makeEvidenceSpan({
              sourceId: source.id,
              snapshotHash: hash,
              selector: makeSelector({
                exact: "I really prefer borders over drop shadows for cards.",
              }),
            }),
          ],
        }),
      ],
    });
    const result = checkOperatorClaims({
      sidecar,
      lookup: fakeLookup([source], { [hash]: transcript }),
    });
    expect(result.passed).toBe(true);
  });

  test("a near-but-not-exact quote fails (the loophole this check closes)", () => {
    const transcript = "Operator: I really prefer borders over drop shadows for cards.";
    const hash = sha256Of(transcript);
    const source = sessionSource({
      snapshot: {
        path: `snapshots/${hash.slice(7)}.txt`,
        payloadSha256: hash,
        normalizedTextSha256: hash,
        normalization: "nfc-ws-v1",
        chars: transcript.length,
      },
    });
    const sidecar = makeSidecar({
      claims: [
        makeClaim({
          label: "op-borders",
          kind: "operator",
          evidence: [
            makeEvidenceSpan({
              sourceId: source.id,
              snapshotHash: hash,
              // Paraphrased, not a substring of the transcript - even
              // though the meaning is close, this must NOT anchor fuzzily.
              selector: makeSelector({ exact: "I strongly prefer borders over shadows on cards." }),
            }),
          ],
        }),
      ],
    });
    const result = checkOperatorClaims({
      sidecar,
      lookup: fakeLookup([source], { [hash]: transcript }),
    });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.code === "operator-quote-not-exact")).toBe(true);
  });

  test("missing transcript snapshot fails", () => {
    const missingHash = sha256Of("never stored");
    const source = sessionSource();
    const sidecar = makeSidecar({
      claims: [
        makeClaim({
          label: "op-x",
          kind: "operator",
          evidence: [makeEvidenceSpan({ sourceId: source.id, snapshotHash: missingHash })],
        }),
      ],
    });
    const result = checkOperatorClaims({ sidecar, lookup: fakeLookup([source], {}) });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.code === "missing-snapshot")).toBe(true);
  });

  test("an operator claim with no evidence fails", () => {
    const sidecar = makeSidecar({
      claims: [makeClaim({ label: "op-bare", kind: "operator", evidence: [] })],
    });
    const result = checkOperatorClaims({ sidecar, lookup: fakeLookup([], {}) });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.code === "missing-evidence")).toBe(true);
  });

  test("non-operator claims are ignored entirely", () => {
    const sidecar = makeSidecar({
      claims: [makeClaim({ label: "sourced-one", kind: "sourced", evidence: [] })],
    });
    const result = checkOperatorClaims({ sidecar, lookup: fakeLookup([], {}) });
    expect(result.passed).toBe(true);
  });

  // ---- C-1: the Wave 1 review's core finding ------------------------------

  test("an operator claim citing a source whose transport is not 'session' fails, even with an exact quote (C-1, D19/D23)", () => {
    const transcript = "I really prefer borders over drop shadows for cards.";
    const hash = sha256Of(transcript);
    // A *web* source that happens to contain the exact sentence - the
    // attack this check exists to close: pointing an "operator said this"
    // claim at any snapshot containing the right text, regardless of where
    // that snapshot actually came from.
    const webSource = makeSource({
      snapshot: {
        path: `snapshots/${hash.slice(7)}.txt`,
        payloadSha256: hash,
        normalizedTextSha256: hash,
        normalization: "nfc-ws-v1",
        chars: transcript.length,
      },
      retrieval: {
        retrievedAt: new Date().toISOString(),
        agent: "@shadow/research/web-tool-agent@0.1.0",
        transport: "live",
      },
    });
    const sidecar = makeSidecar({
      claims: [
        makeClaim({
          label: "op-borders",
          kind: "operator",
          evidence: [
            makeEvidenceSpan({
              sourceId: webSource.id,
              snapshotHash: hash,
              selector: makeSelector({ exact: transcript }),
            }),
          ],
        }),
      ],
    });
    const result = checkOperatorClaims({
      sidecar,
      lookup: fakeLookup([webSource], { [hash]: transcript }),
    });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.code === "not-session-source")).toBe(true);
  });

  test("an operator claim citing a source that does not exist fails with a distinct code (C-1)", () => {
    const hash = sha256Of("orphaned reference");
    const sidecar = makeSidecar({
      claims: [
        makeClaim({
          label: "op-ghost",
          kind: "operator",
          evidence: [makeEvidenceSpan({ snapshotHash: hash })],
        }),
      ],
    });
    const result = checkOperatorClaims({ sidecar, lookup: fakeLookup([], {}) });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.code === "missing-source")).toBe(true);
    // Distinct from "not-session-source": missing entirely vs. resolved but wrong transport.
    expect(result.issues.some((i) => i.code === "not-session-source")).toBe(false);
  });
});
