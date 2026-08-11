import { describe, expect, test } from "bun:test";
import type { ClaimRestater, RestatementCandidateInput, RestatementProposal } from "./ports.ts";
import {
  applyPreservationBound,
  downgradeToOperatorClaim,
  isRepairable,
  preservationBound,
  REPAIRABLE_STATUSES,
  runRepairLoop,
  toLedgerEvent,
} from "./repair.ts";
import { makeClaim, makeVerification } from "./test-helpers.ts";

class FakeRestater implements ClaimRestater {
  calls: RestatementCandidateInput[][] = [];
  constructor(private readonly responses: readonly RestatementProposal[]) {}
  async restate(
    inputs: readonly RestatementCandidateInput[],
  ): Promise<readonly RestatementProposal[]> {
    this.calls.push([...inputs]);
    return this.responses;
  }
}

describe("preservationBound", () => {
  test("is at least 80 chars for short originals", () => {
    expect(preservationBound(10)).toBe(80);
  });

  test("is half the original length once that exceeds 160", () => {
    expect(preservationBound(200)).toBe(100);
  });
});

describe("isRepairable / REPAIRABLE_STATUSES", () => {
  test("partial, unsupported, conflicted are repairable", () => {
    expect(REPAIRABLE_STATUSES).toEqual(["partial", "unsupported", "conflicted"]);
    expect(isRepairable("partial")).toBe(true);
    expect(isRepairable("unsupported")).toBe(true);
    expect(isRepairable("conflicted")).toBe(true);
  });

  test("supported and unchecked are not repairable", () => {
    expect(isRepairable("supported")).toBe(false);
    expect(isRepairable("unchecked")).toBe(false);
  });
});

describe("applyPreservationBound", () => {
  test("a conservative restatement within bound is applied", () => {
    const claim = makeClaim({ label: "lin-shadows", text: "Linear never uses shadows." });
    const decision = applyPreservationBound(
      claim,
      {
        to: "Linear's documentation emphasises borders over shadows.",
        reason: "overclaim: source states a preference, not an absolute",
      },
      "how-linear-designs-ui",
    );
    expect(decision.outcome).toBe("applied");
    expect(decision.from).toBe("Linear never uses shadows.");
    expect(decision.levenshtein).toBeGreaterThan(0);
    expect(decision.levenshtein).toBeLessThanOrEqual(decision.bound);
  });

  test("a restatement exceeding the preservation bound is rejected and escalated", () => {
    const claim = makeClaim({ label: "lin-shadows", text: "Linear never uses shadows." });
    const decision = applyPreservationBound(
      claim,
      {
        to: "The retrieved document instead discusses an entirely unrelated topic about typography, spacing systems, onboarding flows, and how the design team runs its weekly critique sessions across every product surface.",
        reason: "attempted full replacement",
      },
      "how-linear-designs-ui",
    );
    expect(decision.outcome).toBe("escalated");
    // The original is left untouched — `from` records what it was, not what it becomes.
    expect(decision.from).toBe("Linear never uses shadows.");
    expect(decision.levenshtein).toBeGreaterThan(decision.bound);
  });

  test("carries the chapter it was repaired in, unchanged through to the ledger event", () => {
    const claim = makeClaim({ label: "lin-shadows", text: "Linear never uses shadows." });
    const decision = applyPreservationBound(
      claim,
      {
        to: "Linear's documentation emphasises borders over shadows.",
        reason: "overclaim: source states a preference, not an absolute",
      },
      "how-linear-designs-ui",
    );
    expect(decision.chapter).toBe("how-linear-designs-ui");
    const event = toLedgerEvent(decision, "2026-08-11T00:00:00Z");
    expect(event.chapter).toBe("how-linear-designs-ui");
  });

  test("logs the distance either way", () => {
    const claim = makeClaim({ label: "x", text: "Short original." });
    const applied = applyPreservationBound(
      claim,
      { to: "Short original, tweaked.", reason: "r" },
      "some-chapter",
    );
    const escalated = applyPreservationBound(
      claim,
      {
        to: "A completely different sentence about something else entirely, replacing the original wholesale.",
        reason: "r",
      },
      "some-chapter",
    );
    const appliedEvent = toLedgerEvent(applied, "2026-08-11T00:00:00Z");
    const escalatedEvent = toLedgerEvent(escalated, "2026-08-11T00:00:00Z");
    expect(appliedEvent.outcome).toBe("applied");
    expect(appliedEvent.levenshtein).toBe(applied.levenshtein);
    expect(appliedEvent.chapter).toBe("some-chapter");
    expect(escalatedEvent.outcome).toBe("escalated");
    expect(escalatedEvent.levenshtein).toBe(escalated.levenshtein);
    expect(escalatedEvent.chapter).toBe("some-chapter");
  });
});

describe("buildRestatementRequests / runRepairLoop", () => {
  test("only repairable claims are sent for restatement, in one batched call", async () => {
    const partial = makeClaim({
      label: "partial-claim",
      text: "Notion always uses generous whitespace.",
      verification: makeVerification({ status: "partial" }),
    });
    const supported = makeClaim({
      label: "supported-claim",
      text: "Linear uses a 4px grid.",
      verification: makeVerification({ status: "supported" }),
    });
    const restater = new FakeRestater([
      { to: "Notion often uses generous whitespace.", reason: "softened absolute claim" },
    ]);

    const decisions = await runRepairLoop(
      [partial, supported],
      restater,
      () => ["the source discusses whitespace generally"],
      "how-notion-designs-ui",
    );

    expect(restater.calls).toHaveLength(1);
    expect(restater.calls[0]).toHaveLength(1);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.label).toBe("partial-claim");
    expect(decisions[0]?.outcome).toBe("applied");
    expect(decisions[0]?.chapter).toBe("how-notion-designs-ui");
  });

  test("no repairable claims means the restater is never invoked", async () => {
    const supported = makeClaim({
      label: "supported-claim",
      verification: makeVerification({ status: "supported" }),
    });
    const restater = new FakeRestater([]);
    const decisions = await runRepairLoop([supported], restater, () => [], "some-chapter");
    expect(decisions).toEqual([]);
    expect(restater.calls).toHaveLength(0);
  });
});

describe("downgradeToOperatorClaim", () => {
  test("requires a non-empty confirmedBy — never silent", () => {
    const claim = makeClaim({ label: "x", kind: "sourced" });
    expect(() => downgradeToOperatorClaim(claim, { confirmedBy: "" })).toThrow();
    expect(() => downgradeToOperatorClaim(claim, { confirmedBy: "   " })).toThrow();
  });

  test("with confirmation, changes the claim's kind", () => {
    const claim = makeClaim({ label: "x", kind: "sourced" });
    const downgraded = downgradeToOperatorClaim(claim, { confirmedBy: "operator@example.com" });
    expect(downgraded.kind).toBe("operator");
    expect(downgraded.label).toBe(claim.label);
  });
});
