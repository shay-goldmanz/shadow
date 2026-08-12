/**
 * Unit tests for OKF `log.md` generation.
 */

import { describe, expect, test } from "bun:test";
import type { LedgerEvent } from "@shadow/evidence";
import { toDigest } from "@shadow/evidence";
import { newClaimId, newSourceId } from "@shadow/evidence";
import { generateRootLogMd, generateVolumeLogMd } from "./log-md.ts";

function sourceRetrieved(ts: string, sourceId: string = newSourceId()): LedgerEvent {
  return {
    ts,
    event: "source.retrieved",
    sourceId: sourceId as ReturnType<typeof newSourceId>,
    normalizedTextSha256: toDigest(
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ),
  };
}

function auditCompleted(
  ts: string,
  chapter = "intro",
  result: "pass" | "fail" = "pass",
): LedgerEvent {
  return {
    ts,
    event: "audit.completed",
    chapter,
    result,
    completeness: 1.0,
    narrativeRatio: 0.1,
  };
}

function claimRestated(
  ts: string,
  chapter = "intro",
  outcome: "applied" | "escalated" = "applied",
): LedgerEvent {
  return {
    ts,
    event: "claim.restated",
    claimId: newClaimId() as ReturnType<typeof newClaimId>,
    chapter,
    from: "old text",
    to: "new text",
    reason: "unsupported",
    levenshtein: 5,
    outcome,
  };
}

function claimVerified(ts: string): LedgerEvent {
  return {
    ts,
    event: "claim.verified",
    claimId: newClaimId() as ReturnType<typeof newClaimId>,
    status: "supported",
    inputHash: toDigest("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
  };
}

function sourceDrifted(ts: string, sourceId: string = newSourceId()): LedgerEvent {
  return {
    ts,
    event: "source.drifted",
    sourceId: sourceId as ReturnType<typeof newSourceId>,
    was: toDigest("sha256:0000000000000000000000000000000000000000000000000000000000000000"),
    now: toDigest("sha256:1111111111111111111111111111111111111111111111111111111111111111"),
    invalidatedClaims: 2,
  };
}

function labelRetired(ts: string, chapter = "intro"): LedgerEvent {
  return {
    ts,
    event: "claim.label.retired",
    chapter,
    label: "old-label",
    claimId: newClaimId() as ReturnType<typeof newClaimId>,
  };
}

describe("generateVolumeLogMd", () => {
  test("empty events produce the empty state", () => {
    const md = generateVolumeLogMd([]);
    expect(md).toContain("# Directory Update Log");
    expect(md).toContain("_No changes recorded yet._");
  });

  test("groups events by date, newest date first", () => {
    const events: LedgerEvent[] = [
      sourceRetrieved("2026-08-10T10:00:00Z"),
      auditCompleted("2026-08-12T09:00:00Z"),
      sourceRetrieved("2026-08-10T11:00:00Z"),
    ];
    const md = generateVolumeLogMd(events);

    // Dates should appear newest first
    const aug12Pos = md.indexOf("## 2026-08-12");
    const aug10Pos = md.indexOf("## 2026-08-10");
    expect(aug12Pos).toBeLessThan(aug10Pos);

    // Both events from Aug 10 should be under the same date heading
    expect(md).toContain("**Addition**");
  });

  test("formats each event type correctly", () => {
    const events: LedgerEvent[] = [
      sourceRetrieved("2026-08-11T10:00:00Z"),
      auditCompleted("2026-08-11T11:00:00Z", "intro", "pass"),
      claimVerified("2026-08-11T12:00:00Z"),
      sourceDrifted("2026-08-11T13:00:00Z"),
      labelRetired("2026-08-11T14:00:00Z"),
      claimRestated("2026-08-11T15:00:00Z", "intro", "applied"),
    ];
    const md = generateVolumeLogMd(events);

    expect(md).toContain("**Addition**");
    expect(md).toContain("**Verification**");
    expect(md).toContain("**Deprecation**");
    expect(md).toContain("**Update**");
  });

  test("escalated restatements are marked explicitly", () => {
    const events: LedgerEvent[] = [claimRestated("2026-08-11T10:00:00Z", "intro", "escalated")];
    const md = generateVolumeLogMd(events);
    expect(md).toContain("NOT");
    expect(md).toContain("escalated for operator review");
  });

  test("failed audits are marked FAILED", () => {
    const events: LedgerEvent[] = [auditCompleted("2026-08-11T10:00:00Z", "intro", "fail")];
    const md = generateVolumeLogMd(events);
    expect(md).toContain("FAILED");
  });

  test("within a date, events are listed chronologically", () => {
    const events: LedgerEvent[] = [
      sourceRetrieved("2026-08-11T12:00:00Z"), // later
      auditCompleted("2026-08-11T10:00:00Z", "intro", "pass"), // earlier
    ];
    const md = generateVolumeLogMd(events);

    // The audit (earlier) should appear before the source (later)
    // within the same date block, since events within a date are
    // listed chronologically (oldest first).
    const auditPos = md.indexOf("**Verification**");
    const additionPos = md.indexOf("**Addition**");
    expect(auditPos).toBeLessThan(additionPos);
  });
});

describe("generateRootLogMd", () => {
  test("empty input produces the empty state", () => {
    const md = generateRootLogMd([]);
    expect(md).toContain("_No changes recorded yet._");
  });

  test("merges events from multiple volumes, sorted by ts descending", () => {
    const vol1Id = newSourceId();
    const vol2Id = newSourceId();
    const vol1: LedgerEvent[] = [sourceRetrieved("2026-08-10T10:00:00Z", vol1Id)];
    const vol2: LedgerEvent[] = [sourceRetrieved("2026-08-12T10:00:00Z", vol2Id)];
    const md = generateRootLogMd([vol1, vol2]);

    const aug12Pos = md.indexOf("## 2026-08-12");
    const aug10Pos = md.indexOf("## 2026-08-10");
    expect(aug12Pos).toBeLessThan(aug10Pos);
  });

  test("handles a single volume with no events in a multi-volume set", () => {
    const vol1: LedgerEvent[] = [];
    const vol2: LedgerEvent[] = [sourceRetrieved("2026-08-11T10:00:00Z")];
    const md = generateRootLogMd([vol1, vol2]);
    expect(md).toContain("**Addition**");
    expect(md).not.toContain("_No changes recorded yet._");
  });
});
