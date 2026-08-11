import { describe, expect, test } from "bun:test";
import { toChapterSlug, toVolumeSlug } from "@shadow/core";
import { type ClaimSidecar, computeInputHash, newClaimId, sha256Of } from "@shadow/evidence";
import { seedVolume, withScriptedApi } from "../test-helpers.ts";

describe("Chapters", () => {
  test("PUT writes a chapter, runs the audit, and reindexes on a passing verdict", async () => {
    await withScriptedApi({}, async ({ baseUrl, deps }) => {
      const volume = toVolumeSlug("design-craft");
      await seedVolume(deps, volume);

      const res = await fetch(`${baseUrl}/api/volumes/design-craft/chapters/spacing`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Spacing",
          body: "Spacing is a systemic constraint, not a per-screen decision.",
          frontmatter: { when_to_use: "Designing dense UI." },
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        chapter: { slug: string; title: string };
        audit: { verdict: { passed: boolean }; published: boolean };
      };
      expect(body.chapter.slug).toBe("spacing");
      expect(body.audit.verdict.passed).toBe(true);
      expect(body.audit.published).toBe(true);

      // Reindexed as a side effect of a passing publish.
      const corpusIndex = (await deps.volumeStore.readCorpusIndex()) as
        | { volumes: { chapters: { slug: string }[] }[] }
        | undefined;
      const slugs = corpusIndex?.volumes.flatMap((v) => v.chapters).map((c) => c.slug);
      expect(slugs).toEqual(["spacing"]);
    });
  });

  test("GET returns the chapter with its claims and audit once written", async () => {
    await withScriptedApi({}, async ({ baseUrl, deps }) => {
      const volume = toVolumeSlug("design-craft");
      await seedVolume(deps, volume);

      await fetch(`${baseUrl}/api/volumes/design-craft/chapters/spacing`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Spacing", body: "Spacing is systemic." }),
      });

      const res = await fetch(`${baseUrl}/api/volumes/design-craft/chapters/spacing`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        chapter: { title: string };
        claims: { claims: unknown[] } | undefined;
        audit: { verdict: { passed: boolean } } | undefined;
      };
      expect(body.chapter.title).toBe("Spacing");
      expect(body.claims).toBeDefined();
      expect(body.audit).toBeDefined();
      expect(body.audit?.verdict.passed).toBe(true);
    });
  });

  test("GET a never-written chapter omits claims/audit and 404s (chapter_not_found)", async () => {
    await withScriptedApi({}, async ({ baseUrl, deps }) => {
      const volume = toVolumeSlug("design-craft");
      await seedVolume(deps, volume);

      const res = await fetch(`${baseUrl}/api/volumes/design-craft/chapters/nope`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("chapter_not_found");
    });
  });

  test("DELETE removes the chapter", async () => {
    await withScriptedApi({}, async ({ baseUrl, deps }) => {
      const volume = toVolumeSlug("design-craft");
      await seedVolume(deps, volume);
      await fetch(`${baseUrl}/api/volumes/design-craft/chapters/spacing`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Spacing", body: "Spacing is systemic." }),
      });

      const del = await fetch(`${baseUrl}/api/volumes/design-craft/chapters/spacing`, {
        method: "DELETE",
      });
      expect(del.status).toBe(200);
      expect(await del.json()).toEqual({ deleted: true });

      const getAfter = await fetch(`${baseUrl}/api/volumes/design-craft/chapters/spacing`);
      expect(getAfter.status).toBe(404);
    });
  });

  test("a failing audit returns 200 with a failing verdict, never a 500", async () => {
    await withScriptedApi(
      {
        // Always says "unsupported", however the sentence is restated —
        // guarantees the post-repair re-audit still fails.
        entailmentRelevanceJudge: {
          judge: async (inputs) =>
            inputs.map(() => ({
              entailment: { status: "unsupported" as const, rationale: "test: never entailed" },
              relevance: { relevance: "on-topic" as const, rationale: "test" },
            })),
        },
        claimRestater: {
          restate: async (inputs) =>
            inputs.map((input) => ({ to: `${input.text} (restated)`, reason: "test restatement" })),
        },
      },
      async ({ baseUrl, deps }) => {
        const volume = toVolumeSlug("design-craft");
        await seedVolume(deps, volume);
        const chapter = toChapterSlug("spacing");

        // Pre-seed a chapter + sidecar with one sourced claim whose source
        // is real and resolvable, so C1a/C2 pass and only C3 (entailment)
        // is exercised by the scripted judge above.
        const sentence = "Spacing is a systemic constraint.[^spacing-claim]";
        const chapterDoc = await deps.volumeStore.putChapter(volume, {
          slug: chapter,
          title: "Spacing",
          body: sentence,
        });

        const source = await deps.evidenceStore.putSourceFromRetrieval(
          volume,
          {
            requestedUrl: "https://example.test/spacing",
            finalUrl: "https://example.test/spacing",
            httpStatus: 200,
            contentType: "text/plain",
            bytes: new TextEncoder().encode("Spacing is treated as a systemic constraint."),
            extractedText: "Spacing is treated as a systemic constraint.",
            retrievedAt: "2026-08-11T00:00:00.000Z",
            transport: "fixture",
          },
          {
            title: "Fake source",
            agent: "test",
            authority: { tier: "secondary", rationale: "test fixture" },
            volatility: "unknown",
          },
        );

        const quote = "Spacing is treated as a systemic constraint.";
        const evidence = [
          {
            sourceId: source.id,
            snapshotHash: source.snapshot.normalizedTextSha256,
            selector: { type: "TextQuoteSelector" as const, exact: quote },
            relation: "supports" as const,
            anchorStatus: "anchored" as const,
          },
        ];
        const decontextualized = "Spacing is a systemic constraint.";
        const sidecar: ClaimSidecar = {
          schemaVersion: "1.0",
          chapter,
          chapterTextSha256: sha256Of(chapterDoc.body),
          claims: [
            {
              id: newClaimId(),
              label: "spacing-claim",
              kind: "sourced",
              text: "Spacing is a systemic constraint.",
              decontextualized,
              checkRequired: true,
              evidence,
              supports: [],
              verification: {
                status: "unchecked",
                inputHash: computeInputHash({
                  decontextualized,
                  evidence: evidence.map((e) => ({
                    exact: e.selector.exact,
                    snapshotHash: e.snapshotHash,
                  })),
                  supports: [],
                }),
              },
            },
          ],
        };
        await deps.evidenceStore.putClaims(volume, sidecar);

        const res = await fetch(`${baseUrl}/api/volumes/design-craft/chapters/spacing`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Spacing", body: sentence }),
        });

        expect(res.status).toBe(200); // <-- explicit: failing audit is 200, not 500
        const body = (await res.json()) as {
          audit: { verdict: { passed: boolean }; published: boolean; repairs: unknown[] };
        };
        expect(body.audit.verdict.passed).toBe(false);
        expect(body.audit.published).toBe(false);
        expect(body.audit.repairs.length).toBeGreaterThan(0);
      },
    );
  });
});
