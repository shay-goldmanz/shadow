import { describe, expect, test } from "bun:test";
import { toChapterSlug } from "@shadow/core";
import { draftChapter } from "./chapter-draft.ts";
import type { ChapterDirective } from "./directives.ts";
import { ClaimMissingRequiredFieldError } from "./errors.ts";
import { expectRejection, withVolumeHarness } from "./test-helpers.ts";

describe("draftChapter", () => {
  test("persists the chapter and a claim sidecar with resolved evidence", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume }) => {
      const source = await evidenceStore.putSourceFromRetrieval(
        volume,
        {
          requestedUrl: "https://linear.app/blog/design-system",
          finalUrl: "https://linear.app/blog/design-system",
          httpStatus: 200,
          contentType: "text/plain",
          bytes: new TextEncoder().encode(
            "Every measurement in the sidebar is a multiple of four.",
          ),
          extractedText: "Every measurement in the sidebar is a multiple of four.",
          retrievedAt: "2026-08-11T00:00:00.000Z",
          transport: "fixture",
        },
        {
          title: "Linear",
          agent: "test",
          authority: { tier: "primary", rationale: "test" },
          volatility: "unknown",
        },
      );

      const directive: ChapterDirective = {
        slug: "how-linear-designs-ui",
        title: "How Linear designs its UI",
        body: "Linear uses a 4px grid.[^lin-4px]",
        frontmatter: {
          when_to_use: "Designing dense UI",
          keywords: ["Linear"],
          confidence: "high",
        },
        claims: [
          {
            label: "lin-4px",
            kind: "sourced",
            text: "Linear uses a 4px grid.",
            evidence: [{ sourceId: source.id, quote: "a multiple of four" }],
          },
        ],
      };

      const { chapter, sidecar } = await draftChapter(
        { evidenceStore, volumeStore },
        volume,
        directive,
      );

      expect(chapter.title).toBe("How Linear designs its UI");
      expect(chapter.frontmatter.when_to_use).toBe("Designing dense UI");

      const persistedChapter = await volumeStore.getChapter(
        volume,
        toChapterSlug("how-linear-designs-ui"),
      );
      expect(persistedChapter.body).toContain("[^lin-4px]");

      expect(sidecar.claims).toHaveLength(1);
      expect(sidecar.claims[0]?.kind).toBe("sourced");
      expect(sidecar.claims[0]?.evidence[0]?.sourceId).toBe(source.id);
      expect(sidecar.claims[0]?.verification.status).toBe("unchecked");

      const persistedSidecar = await evidenceStore.getClaims(
        volume,
        toChapterSlug("how-linear-designs-ui"),
      );
      expect(persistedSidecar?.claims).toHaveLength(1);
    });
  });

  test("throws ClaimMissingRequiredFieldError for a sourced claim with no evidence", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume }) => {
      const directive: ChapterDirective = {
        slug: "bad-chapter",
        title: "Bad",
        body: "Claim.[^bad]",
        claims: [{ label: "bad", kind: "sourced", text: "Claim." }],
      };
      await expectRejection(
        draftChapter({ evidenceStore, volumeStore }, volume, directive),
        ClaimMissingRequiredFieldError,
      );
    });
  });

  test("throws ClaimMissingRequiredFieldError for a derived claim with no supports", async () => {
    await withVolumeHarness(async ({ evidenceStore, volumeStore, volume }) => {
      const directive: ChapterDirective = {
        slug: "bad-chapter-2",
        title: "Bad",
        body: "Claim.[^=bad]",
        claims: [{ label: "bad", kind: "derived", text: "Claim." }],
      };
      await expectRejection(
        draftChapter({ evidenceStore, volumeStore }, volume, directive),
        ClaimMissingRequiredFieldError,
      );
    });
  });
});
