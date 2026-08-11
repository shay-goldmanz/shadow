import { describe, expect, test } from "bun:test";
import { toSourceId } from "@shadow/evidence";
import { UnknownSourceError, UnresolvedEvidenceQuoteError } from "./errors.ts";
import { buildEvidenceSpan } from "./evidence-binding.ts";
import { expectRejection, withVolumeHarness } from "./test-helpers.ts";

describe("buildEvidenceSpan", () => {
  test("resolves a real, verbatim quote against a witnessed source into an anchored EvidenceSpan", async () => {
    await withVolumeHarness(async ({ evidenceStore, volume }) => {
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
          title: "How Linear built its design system",
          agent: "test",
          authority: { tier: "primary", rationale: "test" },
          volatility: "unknown",
        },
      );

      const span = await buildEvidenceSpan(evidenceStore, volume, "lin-4px", {
        sourceId: source.id,
        quote: "a multiple of four",
      });

      expect(span.sourceId).toBe(source.id);
      expect(span.snapshotHash).toBe(source.snapshot.normalizedTextSha256);
      expect(span.selector.exact).toBe("a multiple of four");
      expect(span.anchorStatus).toBe("anchored");
      expect(span.selector.refinedBy).toBeDefined();
    });
  });

  test("throws UnknownSourceError when the sourceId does not exist", async () => {
    await withVolumeHarness(async ({ evidenceStore, volume }) => {
      await expectRejection(
        buildEvidenceSpan(evidenceStore, volume, "label", {
          sourceId: toSourceId(`src_${"0".repeat(26)}`),
          quote: "anything",
        }),
        UnknownSourceError,
      );
    });
  });

  test("throws UnresolvedEvidenceQuoteError when the quote is not a verbatim substring", async () => {
    await withVolumeHarness(async ({ evidenceStore, volume }) => {
      const source = await evidenceStore.putSourceFromRetrieval(
        volume,
        {
          requestedUrl: "https://example.com/page",
          finalUrl: "https://example.com/page",
          httpStatus: 200,
          contentType: "text/plain",
          bytes: new TextEncoder().encode("The real sentence is here."),
          extractedText: "The real sentence is here.",
          retrievedAt: "2026-08-11T00:00:00.000Z",
          transport: "fixture",
        },
        {
          title: "Example",
          agent: "test",
          authority: { tier: "unknown", rationale: "test" },
          volatility: "unknown",
        },
      );

      await expectRejection(
        buildEvidenceSpan(evidenceStore, volume, "label", {
          sourceId: source.id,
          quote: "a paraphrase that was never actually said",
        }),
        UnresolvedEvidenceQuoteError,
      );
    });
  });
});
