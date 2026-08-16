import { describe, expect, test } from "bun:test";
import type { VolumeSlug, VolumeStore } from "@shadow/core";
import { toChapterSlug } from "@shadow/core";
import type { EvidenceStore } from "@shadow/evidence";
import type { IndexDocument } from "@shadow/indexing";
import { draftChapter } from "./chapter-draft.ts";
import type { ChapterDirective } from "./directives.ts";
import { publishChapter } from "./publish.ts";
import {
  alwaysNarrativeClassifier,
  freshIndexer,
  scriptedClaimRestater,
  scriptedEntailmentJudge,
  withVolumeHarness,
} from "./test-helpers.ts";

async function draftSimpleChapter(
  deps: { evidenceStore: EvidenceStore; volumeStore: VolumeStore },
  volume: VolumeSlug,
  opts: { readonly slug: string; readonly claimText: string; readonly quote: string },
) {
  const source = await deps.evidenceStore.putSourceFromRetrieval(
    volume,
    {
      requestedUrl: `https://example.test/${opts.slug}`,
      finalUrl: `https://example.test/${opts.slug}`,
      httpStatus: 200,
      contentType: "text/plain",
      bytes: new TextEncoder().encode(opts.quote),
      extractedText: opts.quote,
      retrievedAt: "2026-08-11T00:00:00.000Z",
      transport: "fixture",
    },
    {
      title: "Test source",
      agent: "test",
      authority: { tier: "secondary", rationale: "test" },
      volatility: "unknown",
    },
  );

  const directive: ChapterDirective = {
    slug: opts.slug,
    title: `Chapter ${opts.slug}`,
    body: `${opts.claimText}[^c1]`,
    frontmatter: { when_to_use: "testing publish" },
    claims: [
      {
        label: "c1",
        kind: "sourced",
        text: opts.claimText,
        evidence: [{ sourceId: source.id, quote: opts.quote }],
      },
    ],
  };

  return draftChapter(deps, volume, directive);
}

describe("publishChapter — happy path", () => {
  test("a fully-supported chapter passes the audit, is published, and reindexes the corpus", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume, root }) => {
      const { chapter } = await draftSimpleChapter({ evidenceStore, volumeStore }, volume, {
        slug: "supported-chapter",
        claimText: "Linear uses a 4px spacing grid.",
        quote: "a 4px spacing grid",
      });

      const result = await publishChapter(
        {
          volumeStore,
          evidenceStore,
          indexer: freshIndexer(root),
          checkWorthinessClassifier: alwaysNarrativeClassifier,
          entailmentRelevanceJudge: scriptedEntailmentJudge(),
          claimRestater: scriptedClaimRestater(() => {
            throw new Error("restater should not be called on the happy path");
          }),
        },
        volume,
        chapter.slug,
      );

      expect(result.verdict.passed).toBe(true);
      expect(result.published).toBe(true);
      expect(result.repairs).toEqual([]);

      const audit = await evidenceStore.getAudit(volume, chapter.slug);
      expect(audit?.verdict.passed).toBe(true);

      const corpusIndex = (await volumeStore.readCorpusIndex()) as IndexDocument | undefined;
      expect(corpusIndex).toBeDefined();
      const chapterNode = corpusIndex?.volumes
        .flatMap((v) => v.chapters)
        .find((c) => c.slug === "supported-chapter");
      expect(chapterNode).toBeDefined();
    });
  });
});

describe("publishChapter — unsupported claims fail the audit and are not published", () => {
  test("a claim the judge always reports unsupported fails the audit; the chapter is not published", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume, root }) => {
      const { chapter } = await draftSimpleChapter({ evidenceStore, volumeStore }, volume, {
        slug: "unsupported-chapter",
        claimText: "Linear invented the concept of a sidebar.",
        quote: "a 4px spacing grid",
      });

      const result = await publishChapter(
        {
          volumeStore,
          evidenceStore,
          indexer: freshIndexer(root),
          checkWorthinessClassifier: alwaysNarrativeClassifier,
          entailmentRelevanceJudge: scriptedEntailmentJudge(() => ({
            entailment: { status: "unsupported", rationale: "the cited span never says this" },
            relevance: { relevance: "on-topic", rationale: "on topic" },
          })),
          claimRestater: scriptedClaimRestater((input) => ({
            to: input.text, // "restates" to the same text — still won't be supported
            reason: "attempted repair, but the claim genuinely overclaims",
          })),
        },
        volume,
        chapter.slug,
      );

      expect(result.verdict.passed).toBe(false);
      expect(result.published).toBe(false);

      const audit = await evidenceStore.getAudit(volume, chapter.slug);
      expect(audit?.verdict.passed).toBe(false);

      // Not reindexed — the corpus index must not exist yet (nothing else published).
      const corpusIndex = await volumeStore.readCorpusIndex();
      expect(corpusIndex).toBeUndefined();
    });
  });
});

describe("publishChapter — conservative restatement (D9/D21)", () => {
  test("a partial claim is restated within the preservation bound, applied, and logged, and then passes", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume, root }) => {
      const original = "Linear never uses shadows.";
      const restated = "Linear's documentation emphasises borders over shadows.";

      const { chapter } = await draftSimpleChapter({ evidenceStore, volumeStore }, volume, {
        slug: "partial-chapter",
        claimText: original,
        quote: "we settled on borders instead of shadows",
      });

      const result = await publishChapter(
        {
          volumeStore,
          evidenceStore,
          indexer: freshIndexer(root),
          checkWorthinessClassifier: alwaysNarrativeClassifier,
          entailmentRelevanceJudge: scriptedEntailmentJudge((input) => ({
            entailment: {
              status: input.decontextualized === original ? "partial" : "supported",
              rationale: "test fixture",
            },
            relevance: { relevance: "on-topic", rationale: "test fixture" },
          })),
          claimRestater: scriptedClaimRestater(() => ({
            to: restated,
            reason: "overclaim: source states a preference, not an absolute",
          })),
        },
        volume,
        chapter.slug,
      );

      expect(result.repairs).toHaveLength(1);
      expect(result.repairs[0]?.outcome).toBe("applied");
      expect(result.repairs[0]?.to).toBe(restated);
      expect(result.verdict.passed).toBe(true);
      expect(result.published).toBe(true);

      const persisted = await volumeStore.getChapter(volume, toChapterSlug("partial-chapter"));
      expect(persisted.body).toContain(restated);
      expect(persisted.body).not.toContain(original);

      const sidecar = await evidenceStore.getClaims(volume, toChapterSlug("partial-chapter"));
      expect(sidecar?.claims[0]?.text).toBe(restated);

      const ledger = await evidenceStore.readLedger(volume);
      const restatedEvents = ledger.filter((e) => e.event === "claim.restated");
      expect(restatedEvents).toHaveLength(1);
      expect(restatedEvents[0]).toMatchObject({
        outcome: "applied",
        to: restated,
        chapter: "partial-chapter",
      });
    });
  });

  test("a restatement exceeding the preservation bound is escalated, not applied, and logged", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume, root }) => {
      const original = "Linear never uses shadows.";
      // Wildly different and much longer than max(80, 0.5*|original|) —
      // RARR's adversarial-editor attack (D21) — must be rejected.
      const wildRestatement =
        "This is an entirely different sentence about a completely unrelated subject, " +
        "chosen specifically to exceed the Levenshtein preservation bound so that the " +
        "repair loop must refuse to apply it and instead escalate to the operator for review.";

      const { chapter } = await draftSimpleChapter({ evidenceStore, volumeStore }, volume, {
        slug: "escalated-chapter",
        claimText: original,
        quote: "we settled on borders instead of shadows",
      });

      const result = await publishChapter(
        {
          volumeStore,
          evidenceStore,
          indexer: freshIndexer(root),
          checkWorthinessClassifier: alwaysNarrativeClassifier,
          // Always "unsupported" (blocking) — the point of this test is the
          // guardrail rejecting the restatement, so the claim must still be
          // failing after the escalation, not merely warned about.
          entailmentRelevanceJudge: scriptedEntailmentJudge(() => ({
            entailment: { status: "unsupported", rationale: "test fixture" },
            relevance: { relevance: "on-topic", rationale: "test fixture" },
          })),
          claimRestater: scriptedClaimRestater(() => ({
            to: wildRestatement,
            reason: "test fixture: an adversarial/unreasonable restatement",
          })),
        },
        volume,
        chapter.slug,
      );

      expect(result.repairs).toHaveLength(1);
      expect(result.repairs[0]?.outcome).toBe("escalated");
      expect(result.verdict.passed).toBe(false);
      expect(result.published).toBe(false);

      // The chapter body and claim text are left untouched — nothing was silently applied.
      const persisted = await volumeStore.getChapter(volume, toChapterSlug("escalated-chapter"));
      expect(persisted.body).toContain(original);
      expect(persisted.body).not.toContain(wildRestatement);

      const ledger = await evidenceStore.readLedger(volume);
      const restatedEvents = ledger.filter((e) => e.event === "claim.restated");
      expect(restatedEvents).toHaveLength(1);
      expect(restatedEvents[0]).toMatchObject({
        outcome: "escalated",
        from: original,
        chapter: "escalated-chapter",
      });
    });
  });
});

describe("publishChapter — claim.restated is scoped to its chapter (T3.6)", () => {
  test("filtering a volume-wide ledger by chapter returns only that chapter's restatements", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume, root }) => {
      const restatedText = "Restated within the preservation bound for this fixture.";

      async function publishOnePartialClaimChapter(slug: string, claimText: string) {
        const { chapter } = await draftSimpleChapter({ evidenceStore, volumeStore }, volume, {
          slug,
          claimText,
          quote: "we settled on borders instead of shadows",
        });
        await publishChapter(
          {
            volumeStore,
            evidenceStore,
            indexer: freshIndexer(root),
            checkWorthinessClassifier: alwaysNarrativeClassifier,
            entailmentRelevanceJudge: scriptedEntailmentJudge((input) => ({
              entailment: {
                status: input.decontextualized === claimText ? "partial" : "supported",
                rationale: "test fixture",
              },
              relevance: { relevance: "on-topic", rationale: "test fixture" },
            })),
            claimRestater: scriptedClaimRestater(() => ({
              to: restatedText,
              reason: "test fixture restatement",
            })),
          },
          volume,
          chapter.slug,
        );
        return chapter;
      }

      const chapterA = await publishOnePartialClaimChapter(
        "ledger-scope-a",
        "Chapter A never uses shadows.",
      );
      const chapterB = await publishOnePartialClaimChapter(
        "ledger-scope-b",
        "Chapter B never uses shadows.",
      );

      const ledger = await evidenceStore.readLedger(volume);
      const restatedEvents = ledger.filter((e) => e.event === "claim.restated");
      expect(restatedEvents).toHaveLength(2);

      const forA = restatedEvents.filter((e) => e.chapter === chapterA.slug);
      const forB = restatedEvents.filter((e) => e.chapter === chapterB.slug);
      expect(forA).toHaveLength(1);
      expect(forB).toHaveLength(1);
      expect(forA[0]?.from).toBe("Chapter A never uses shadows.");
      expect(forB[0]?.from).toBe("Chapter B never uses shadows.");
    });
  });

  test("a restatement survives its claim's label being retired from the chapter", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume, root }) => {
      const original = "Linear never uses shadows.";
      const restated = "Linear's documentation emphasises borders over shadows.";

      const { chapter } = await draftSimpleChapter({ evidenceStore, volumeStore }, volume, {
        slug: "retired-label-chapter",
        claimText: original,
        quote: "we settled on borders instead of shadows",
      });

      await publishChapter(
        {
          volumeStore,
          evidenceStore,
          indexer: freshIndexer(root),
          checkWorthinessClassifier: alwaysNarrativeClassifier,
          entailmentRelevanceJudge: scriptedEntailmentJudge((input) => ({
            entailment: {
              status: input.decontextualized === original ? "partial" : "supported",
              rationale: "test fixture",
            },
            relevance: { relevance: "on-topic", rationale: "test fixture" },
          })),
          claimRestater: scriptedClaimRestater(() => ({
            to: restated,
            reason: "overclaim: source states a preference, not an absolute",
          })),
        },
        volume,
        chapter.slug,
      );

      // The operator now edits the chapter and removes the `c1` claim
      // entirely (D18: the label is never reused after this). Re-drafting
      // over the same slug with a claim set that no longer includes "c1"
      // is exactly what `putClaims` uses to detect and retire it.
      const source = await evidenceStore.putSourceFromRetrieval(
        volume,
        {
          requestedUrl: "https://example.test/retired-label-chapter-2",
          finalUrl: "https://example.test/retired-label-chapter-2",
          httpStatus: 200,
          contentType: "text/plain",
          bytes: new TextEncoder().encode("a completely different topic"),
          extractedText: "a completely different topic",
          retrievedAt: "2026-08-11T00:00:00.000Z",
          transport: "fixture",
        },
        {
          title: "Test source 2",
          agent: "test",
          authority: { tier: "secondary", rationale: "test" },
          volatility: "unknown",
        },
      );
      await draftChapter({ evidenceStore, volumeStore }, volume, {
        slug: "retired-label-chapter",
        title: "Chapter retired-label-chapter",
        body: "This chapter is now about something else entirely.[^c2]",
        frontmatter: { when_to_use: "testing publish" },
        claims: [
          {
            label: "c2",
            kind: "sourced",
            text: "This chapter is now about something else entirely.",
            evidence: [{ sourceId: source.id, quote: "a completely different topic" }],
          },
        ],
      });

      // The claim list no longer mentions "c1" — cross-referencing the
      // chapter's *current* claims would miss the earlier restatement.
      const sidecar = await evidenceStore.getClaims(volume, toChapterSlug("retired-label-chapter"));
      const currentLabels = new Set(sidecar?.claims.map((c) => c.label) ?? []);
      expect(currentLabels.has("c1")).toBe(false);

      const retired = await evidenceStore.getRetiredLabels(
        volume,
        toChapterSlug("retired-label-chapter"),
      );
      expect(retired.has("c1")).toBe(true);

      // Filtering the ledger by `chapter` still finds the restatement, even
      // though its label is gone from the sidecar — the edge case T3.6
      // exists to fix.
      const ledger = await evidenceStore.readLedger(volume);
      const restatedForChapter = ledger.filter(
        (e) => e.event === "claim.restated" && e.chapter === "retired-label-chapter",
      );
      expect(restatedForChapter).toHaveLength(1);
      expect(restatedForChapter[0]).toMatchObject({ outcome: "applied", to: restated });
    });
  });
});
