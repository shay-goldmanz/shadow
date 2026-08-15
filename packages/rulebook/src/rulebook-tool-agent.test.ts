import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemRulebookStore, toChapterSlug, toVolumeSlug, type VolumeSlug } from "@shadow/core";
import {
  type EntailmentRelevanceInput,
  FileSystemEvidenceStore,
  parseFootnoteMarkers,
} from "@shadow/evidence";
import { FakeStructuredGenerationPort } from "@shadow/model";
import type { RulebookBrief, RulebookEvent } from "./port.ts";
import { RulebookToolAgent } from "./rulebook-tool-agent.ts";
import { alwaysNarrativeClassifier, scriptedClaimRestater } from "./test-helpers.ts";

/**
 * A `FileSystemRulebookStore` whose `readExtractionCache` throws for any
 * chunk-extraction cache key — simulating corrupted extraction-cache JSON
 * (`Bun.file().json()` throwing) without needing an actual malformed file
 * on disk. Used by the cache-throw regression test below.
 */
class ChunkCacheCorruptingStore extends FileSystemRulebookStore {
  override async readExtractionCache<T>(rulebookSlug: VolumeSlug, key: string): Promise<T | null> {
    if (key.startsWith("chunk-")) {
      throw new Error("corrupted extraction-cache JSON (test fixture)");
    }
    return super.readExtractionCache<T>(rulebookSlug, key);
  }
}

const FIXTURE_TEXT =
  "Borrowers must repay principal monthly. Interest accrues daily on the outstanding balance.\n\n" +
  "The lender may seize collateral upon default. All collateral must be insured against loss.";

function taxonomyFixture() {
  return {
    groups: [
      {
        slug: "payments",
        title: "Payments",
        when_to_use: "Rules about repayment schedules.",
        not_for: "Collateral and default remedies.",
        keywords: ["payment"],
      },
      {
        slug: "collateral",
        title: "Collateral",
        when_to_use: "Rules about collateral and default.",
        not_for: "Payment schedules.",
        keywords: ["collateral"],
      },
    ],
  };
}

function extractionFixture() {
  return {
    rules: [
      {
        statement: "Borrowers must repay principal monthly.",
        quotes: ["Borrowers must repay principal monthly."],
        group: "payments",
      },
      {
        statement: "Interest accrues daily on the outstanding balance.",
        quotes: ["Interest accrues daily on the outstanding balance."],
        group: "payments",
      },
      {
        statement: "The lender may seize collateral upon default.",
        quotes: ["The lender may seize collateral upon default."],
        group: "collateral",
      },
      {
        statement: "All collateral must be insured against loss.",
        quotes: ["All collateral must be insured against loss."],
        group: "collateral",
      },
    ],
  };
}

function emptyExtractionFixture() {
  return { rules: [] };
}

function makeStructuredGeneration(
  extraction: () => unknown = extractionFixture,
): FakeStructuredGenerationPort {
  return new FakeStructuredGenerationPort((request) => {
    if (request.schemaName === "rulebook-taxonomy") return taxonomyFixture();
    if (request.schemaName === "rulebook-extraction") return extraction();
    if (request.schemaName === "rulebook-group-finalization") return { assignments: [] };
    throw new Error(`unexpected schemaName in test fixture: ${request.schemaName}`);
  });
}

async function collect(events: AsyncIterable<RulebookEvent>): Promise<RulebookEvent[]> {
  const out: RulebookEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function alwaysSupportedJudge(calls: EntailmentRelevanceInput[][]) {
  return {
    judge: async (inputs: readonly EntailmentRelevanceInput[]) => {
      calls.push([...inputs]);
      return inputs.map(() => ({
        entailment: { status: "supported" as const, rationale: "test fixture: always supported" },
        relevance: { relevance: "on-topic" as const, rationale: "test fixture: always on-topic" },
      }));
    },
  };
}

describe("RulebookToolAgent", () => {
  test("full run: publishes every group, RULEBOOK.md goes stable, one claim per bullet with marker parity", async () => {
    const root = await mkdtemp(join(tmpdir(), "shadow-rulebook-agent-test-"));
    try {
      const docPath = join(root, "loan.md");
      await writeFile(docPath, FIXTURE_TEXT, "utf8");

      const rulebookStore = new FileSystemRulebookStore(root);
      const evidenceStore = new FileSystemEvidenceStore(rulebookStore);
      const entailmentCalls: EntailmentRelevanceInput[][] = [];

      const agent = new RulebookToolAgent({
        rulebookStore,
        evidenceStore,
        structuredGeneration: makeStructuredGeneration(),
        checkWorthinessClassifier: alwaysNarrativeClassifier,
        entailmentRelevanceJudge: alwaysSupportedJudge(entailmentCalls),
        claimRestater: scriptedClaimRestater(() => {
          throw new Error("restater should not be called on the happy path");
        }),
      });

      const brief: RulebookBrief = { slug: "loan-rules", title: "Loan Rules", docPath };
      const events = await collect(agent.create(brief));

      // Full event sequence shape.
      expect(events[0]?.type).toBe("started");
      expect(events[1]?.type).toBe("planned");
      const chunkEvents = events.filter((e) => e.type === "chunk-extracted");
      expect(chunkEvents.length).toBeGreaterThan(0);
      expect(events.some((e) => e.type === "merged")).toBe(true);
      const groupAuditedEvents = events.filter((e) => e.type === "group-audited");
      expect(groupAuditedEvents).toHaveLength(2);
      expect(events.at(-1)?.type).toBe("completed");

      const completedEvent = events.at(-1);
      if (completedEvent?.type !== "completed") throw new Error("expected a completed event");
      const { result } = completedEvent;

      expect([...result.publishedGroups].sort()).toEqual(["collateral", "payments"]);
      expect(result.rejectedGroups).toEqual([]);
      expect(result.failedChunks).toBe(0);
      expect(result.ruleCount).toBe(4);
      expect(result.groupCount).toBe(2);
      expect(result.status).toBe("stable");

      const rulebookSlug = toVolumeSlug("loan-rules");
      const rulebook = await rulebookStore.getRulebook(rulebookSlug);
      expect(rulebook.status).toBe("stable");
      expect(rulebook.sourceDoc?.url).toBe(`file://${docPath}`);
      expect(rulebook.verified).toHaveLength(1);
      expect(rulebook.verified[0]?.by).toBe("process:audit");

      for (const groupSlug of ["payments", "collateral"]) {
        const chapterSlug = toChapterSlug(groupSlug);
        const group = await rulebookStore.getGroup(rulebookSlug, chapterSlug);
        expect(group.status).toBe("stable");
        expect(group.verified).toHaveLength(1);

        const sidecar = await evidenceStore.getClaims(rulebookSlug, chapterSlug);
        expect(sidecar?.claims.length).toBeGreaterThan(0);

        // Marker/claim parity: every footnote marker in the body has a matching claim, and vice versa.
        const { markers, malformed } = parseFootnoteMarkers(group.body);
        expect(malformed).toEqual([]);
        expect(markers.map((m) => m.label).sort()).toEqual(
          (sidecar?.claims ?? []).map((c) => c.label).sort(),
        );
        expect(markers).toHaveLength(sidecar?.claims.length ?? -1);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an audit-fail script leaves that group draft and in rejectedGroups while the other group still publishes", async () => {
    const root = await mkdtemp(join(tmpdir(), "shadow-rulebook-agent-test-"));
    try {
      const docPath = join(root, "loan.md");
      await writeFile(docPath, FIXTURE_TEXT, "utf8");

      const rulebookStore = new FileSystemRulebookStore(root);
      const evidenceStore = new FileSystemEvidenceStore(rulebookStore);

      const failingJudge = {
        judge: async (inputs: readonly EntailmentRelevanceInput[]) =>
          inputs.map((input) => ({
            entailment: input.decontextualized.toLowerCase().includes("collateral")
              ? { status: "unsupported" as const, rationale: "test fixture: scripted failure" }
              : { status: "supported" as const, rationale: "test fixture" },
            relevance: { relevance: "on-topic" as const, rationale: "test fixture" },
          })),
      };

      const agent = new RulebookToolAgent({
        rulebookStore,
        evidenceStore,
        structuredGeneration: makeStructuredGeneration(),
        checkWorthinessClassifier: alwaysNarrativeClassifier,
        entailmentRelevanceJudge: failingJudge,
        claimRestater: scriptedClaimRestater((input) => ({
          to: input.text,
          reason: "test fixture: attempted repair, still fails",
        })),
      });

      const brief: RulebookBrief = { slug: "loan-rules", title: "Loan Rules", docPath };
      const events = await collect(agent.create(brief));

      const completedEvent = events.at(-1);
      if (completedEvent?.type !== "completed") throw new Error("expected a completed event");
      const { result } = completedEvent;

      expect(result.publishedGroups).toEqual(["payments"]);
      expect(result.rejectedGroups).toEqual(["collateral"]);
      expect(result.status).toBe("draft");

      const groupAuditedEvents = events.filter((e) => e.type === "group-audited");
      const collateralEvent = groupAuditedEvents.find((e) => e.type === "group-audited" && e.group === "collateral");
      expect(collateralEvent?.type === "group-audited" && collateralEvent.passed).toBe(false);

      const rulebookSlug = toVolumeSlug("loan-rules");
      const collateralGroup = await rulebookStore.getGroup(rulebookSlug, toChapterSlug("collateral"));
      expect(collateralGroup.status).toBe("draft");
      const paymentsGroup = await rulebookStore.getGroup(rulebookSlug, toChapterSlug("payments"));
      expect(paymentsGroup.status).toBe("stable");

      // Not every group passed — the rule book itself stays draft too.
      const rulebook = await rulebookStore.getRulebook(rulebookSlug);
      expect(rulebook.status).toBe("draft");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a degenerate document with no extractable rules completes with zero counts and writes no groups", async () => {
    const root = await mkdtemp(join(tmpdir(), "shadow-rulebook-agent-test-"));
    try {
      const docPath = join(root, "empty-of-rules.md");
      await writeFile(docPath, "This document has no normative content whatsoever.", "utf8");

      const rulebookStore = new FileSystemRulebookStore(root);
      const evidenceStore = new FileSystemEvidenceStore(rulebookStore);

      const agent = new RulebookToolAgent({
        rulebookStore,
        evidenceStore,
        structuredGeneration: makeStructuredGeneration(emptyExtractionFixture),
        checkWorthinessClassifier: alwaysNarrativeClassifier,
        entailmentRelevanceJudge: alwaysSupportedJudge([]),
        claimRestater: scriptedClaimRestater(() => {
          throw new Error("restater should not be called — no claims exist");
        }),
      });

      const brief: RulebookBrief = { slug: "empty-rules", title: "Empty Rules", docPath };
      const events = await collect(agent.create(brief));

      const completedEvent = events.at(-1);
      if (completedEvent?.type !== "completed") throw new Error("expected a completed event");
      const { result } = completedEvent;

      expect(result.ruleCount).toBe(0);
      expect(result.groupCount).toBe(0);
      expect(result.publishedGroups).toEqual([]);
      expect(result.rejectedGroups).toEqual([]);
      // Zero groups is the degenerate edge: nothing was rejected and no
      // chunk failed, but a book with no rules at all must not read as
      // "stable" — there's nothing verified about it.
      expect(result.status).toBe("draft");
      expect(events.some((e) => e.type === "group-audited")).toBe(false);

      const rulebookSlug = toVolumeSlug("empty-rules");
      const rulebook = await rulebookStore.getRulebook(rulebookSlug);
      expect(rulebook.status).toBe("draft");
      expect(await rulebookStore.listGroups(rulebookSlug)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("carry-over: a second run over the same document is served from cache, and the entailment judge is not called again", async () => {
    const root = await mkdtemp(join(tmpdir(), "shadow-rulebook-agent-test-"));
    try {
      const docPath = join(root, "loan.md");
      await writeFile(docPath, FIXTURE_TEXT, "utf8");

      const rulebookStore = new FileSystemRulebookStore(root);
      const evidenceStore = new FileSystemEvidenceStore(rulebookStore);
      const entailmentCalls: EntailmentRelevanceInput[][] = [];

      const agent = new RulebookToolAgent({
        rulebookStore,
        evidenceStore,
        structuredGeneration: makeStructuredGeneration(),
        checkWorthinessClassifier: alwaysNarrativeClassifier,
        entailmentRelevanceJudge: alwaysSupportedJudge(entailmentCalls),
        claimRestater: scriptedClaimRestater(() => {
          throw new Error("restater should not be called — nothing needs repair");
        }),
      });

      const brief: RulebookBrief = { slug: "loan-rules", title: "Loan Rules", docPath };

      const firstRun = await collect(agent.create(brief));
      const firstCompleted = firstRun.at(-1);
      if (firstCompleted?.type !== "completed") throw new Error("expected a completed event");
      expect(firstCompleted.result.publishedGroups).toHaveLength(2);

      const callsAfterFirstRun = entailmentCalls.length;
      expect(callsAfterFirstRun).toBeGreaterThan(0);

      const secondRun = await collect(agent.create(brief));

      const secondChunkEvents = secondRun.filter((e) => e.type === "chunk-extracted");
      expect(secondChunkEvents.length).toBeGreaterThan(0);
      for (const event of secondChunkEvents) {
        if (event.type === "chunk-extracted") expect(event.cached).toBe(true);
      }

      const secondCompleted = secondRun.at(-1);
      if (secondCompleted?.type !== "completed") throw new Error("expected a completed event");
      expect(secondCompleted.result.publishedGroups).toHaveLength(2);

      // Every claim's inputHash was unchanged, so `judgeEntailmentAndRelevance`'s
      // memoization filter should have found nothing left to judge — zero new calls.
      expect(entailmentCalls.length).toBe(callsAfterFirstRun);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a second concurrent call to the same instance yields failed instead of running", async () => {
    const root = await mkdtemp(join(tmpdir(), "shadow-rulebook-agent-test-"));
    try {
      const docPath = join(root, "loan.md");
      await writeFile(docPath, FIXTURE_TEXT, "utf8");

      const rulebookStore = new FileSystemRulebookStore(root);
      const evidenceStore = new FileSystemEvidenceStore(rulebookStore);

      const agent = new RulebookToolAgent({
        rulebookStore,
        evidenceStore,
        structuredGeneration: makeStructuredGeneration(),
        checkWorthinessClassifier: alwaysNarrativeClassifier,
        entailmentRelevanceJudge: alwaysSupportedJudge([]),
        claimRestater: scriptedClaimRestater(() => {
          throw new Error("restater should not be called on the happy path");
        }),
      });

      const brief: RulebookBrief = { slug: "loan-rules", title: "Loan Rules", docPath };

      const first = agent.create(brief)[Symbol.asyncIterator]();
      await first.next(); // drives the generator up to (and past) the busy-flag check

      const secondEvents = await collect(agent.create(brief));
      expect(secondEvents).toHaveLength(1);
      expect(secondEvents[0]?.type).toBe("failed");

      // Drain the first run to completion so it releases the busy flag cleanly.
      let step = await first.next();
      while (!step.done) {
        step = await first.next();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a store whose readExtractionCache throws mid-extraction terminates with a failed event, not a hang", async () => {
    const root = await mkdtemp(join(tmpdir(), "shadow-rulebook-agent-test-"));
    try {
      const docPath = join(root, "loan.md");
      await writeFile(docPath, FIXTURE_TEXT, "utf8");

      const rulebookStore = new ChunkCacheCorruptingStore(root);
      const evidenceStore = new FileSystemEvidenceStore(rulebookStore);

      const agent = new RulebookToolAgent({
        rulebookStore,
        evidenceStore,
        structuredGeneration: makeStructuredGeneration(),
        checkWorthinessClassifier: alwaysNarrativeClassifier,
        entailmentRelevanceJudge: alwaysSupportedJudge([]),
        claimRestater: scriptedClaimRestater(() => {
          throw new Error("restater should not be called — the run fails before publishing");
        }),
      });

      const brief: RulebookBrief = { slug: "loan-rules", title: "Loan Rules", docPath };

      let unhandledRejection: unknown;
      const onUnhandledRejection = (reason: unknown): void => {
        unhandledRejection = reason;
      };
      process.on("unhandledRejection", onUnhandledRejection);

      let events: RulebookEvent[];
      try {
        events = await collect(agent.create(brief));
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
      }

      expect(events.at(-1)?.type).toBe("failed");
      expect(unhandledRejection).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 2000);

  test("a failed chunk keeps the rule book draft even when every group that was created passes its audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "shadow-rulebook-agent-test-"));
    try {
      const docPath = join(root, "loan.md");
      // A payments section padded well past the chunker's 2000-token target
      // so it packs into its own chunk, separate from the collateral
      // section — see chunker.ts's greedy paragraph packing.
      const paymentsFiller = "Borrowers must repay principal monthly. ".repeat(230);
      const longFixtureText = [
        "## Payments",
        paymentsFiller.trim(),
        "## Collateral",
        "The lender may seize collateral upon default.",
      ].join("\n\n");
      await writeFile(docPath, longFixtureText, "utf8");

      const rulebookStore = new FileSystemRulebookStore(root);
      const evidenceStore = new FileSystemEvidenceStore(rulebookStore);

      const structuredGeneration = new FakeStructuredGenerationPort((request) => {
        if (request.schemaName === "rulebook-taxonomy") {
          return {
            groups: [
              {
                slug: "payments",
                title: "Payments",
                when_to_use: "Rules about repayment schedules.",
                not_for: "Collateral and default remedies.",
                keywords: ["payment"],
              },
            ],
          };
        }
        if (request.schemaName === "rulebook-extraction") {
          // Simulate a chunk whose extraction fails outright (both
          // attempts) — any chunk containing the collateral section.
          if (request.prompt.toLowerCase().includes("collateral")) {
            throw new Error("scripted extraction failure for the collateral chunk");
          }
          return {
            rules: [
              {
                statement: "Borrowers must repay principal monthly.",
                quotes: ["Borrowers must repay principal monthly."],
                group: "payments",
              },
            ],
          };
        }
        if (request.schemaName === "rulebook-group-finalization") return { assignments: [] };
        throw new Error(`unexpected schemaName in test fixture: ${request.schemaName}`);
      });

      const agent = new RulebookToolAgent({
        rulebookStore,
        evidenceStore,
        structuredGeneration,
        checkWorthinessClassifier: alwaysNarrativeClassifier,
        entailmentRelevanceJudge: alwaysSupportedJudge([]),
        claimRestater: scriptedClaimRestater(() => {
          throw new Error("restater should not be called — nothing needs repair");
        }),
      });

      const brief: RulebookBrief = { slug: "loan-rules", title: "Loan Rules", docPath };
      const events = await collect(agent.create(brief));

      const chunkEvents = events.filter((e) => e.type === "chunk-extracted");
      expect(chunkEvents.length).toBeGreaterThanOrEqual(2);
      expect(chunkEvents.some((e) => e.type === "chunk-extracted" && e.failed)).toBe(true);
      expect(chunkEvents.some((e) => e.type === "chunk-extracted" && !e.failed)).toBe(true);

      const completedEvent = events.at(-1);
      if (completedEvent?.type !== "completed") throw new Error("expected a completed event");
      const { result } = completedEvent;

      // The one group that was actually created passed its audit...
      expect(result.failedChunks).toBe(1);
      expect(result.rejectedGroups).toEqual([]);
      expect(result.publishedGroups).toEqual(["payments"]);
      expect(result.status).toBe("draft");

      // ...but a chunk failed outright, so the book must not read as fully
      // verified — a silently-missing rule is not the same as "verified".
      const rulebookSlug = toVolumeSlug("loan-rules");
      const rulebook = await rulebookStore.getRulebook(rulebookSlug);
      expect(rulebook.status).toBe("draft");
      expect(rulebook.verified).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
