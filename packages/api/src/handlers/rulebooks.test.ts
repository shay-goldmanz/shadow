import { describe, expect, test } from "bun:test";
import { toChapterSlug, toVolumeSlug } from "@shadow/core";
import { type ClaimSidecar, sha256Of } from "@shadow/evidence";
import { withApi } from "../test-helpers.ts";

describe("Rule books", () => {
  test("GET /api/rulebooks lists rule books with slug/title/status/groupCount/updatedAt", async () => {
    await withApi(async ({ baseUrl, deps }) => {
      const slug = toVolumeSlug("rnb-loan-agreement");
      await deps.rulebookStore.createRulebook({ slug, title: "RNB Loan Agreement" });
      await deps.rulebookStore.putGroup(slug, {
        slug: toChapterSlug("borrower-obligations"),
        title: "Borrower Obligations",
        body: "- Borrowers must repay monthly.[^rule-1]",
      });

      const res = await fetch(`${baseUrl}/api/rulebooks`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        rulebooks: {
          slug: string;
          title: string;
          status: string;
          groupCount: number;
          updatedAt: unknown;
        }[];
      };
      expect(body.rulebooks).toHaveLength(1);
      expect(body.rulebooks[0]).toMatchObject({
        slug: "rnb-loan-agreement",
        title: "RNB Loan Agreement",
        status: "draft",
        groupCount: 1,
      });
      expect(body.rulebooks[0]?.updatedAt).toBeDefined();
    });
  });

  test("GET /api/rulebooks (empty) returns an empty array", async () => {
    await withApi(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/rulebooks`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ rulebooks: [] });
    });
  });

  test("GET /api/rulebooks/:slug returns the rule book and its group summaries", async () => {
    await withApi(async ({ baseUrl, deps }) => {
      const slug = toVolumeSlug("rnb-loan-agreement");
      await deps.rulebookStore.createRulebook({
        slug,
        title: "RNB Loan Agreement",
        whenToUse: "Answering questions about this loan agreement's terms.",
      });
      await deps.rulebookStore.putGroup(slug, {
        slug: toChapterSlug("borrower-obligations"),
        title: "Borrower Obligations",
        body: "- Borrowers must repay monthly.[^rule-1]\n- Interest accrues daily.[^rule-2]",
      });

      const res = await fetch(`${baseUrl}/api/rulebooks/rnb-loan-agreement`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        rulebook: { slug: string; title: string; whenToUse?: string };
        groups: { slug: string; title: string; status: string; ruleCount: number }[];
      };
      expect(body.rulebook.slug).toBe("rnb-loan-agreement");
      expect(body.rulebook.whenToUse).toBe(
        "Answering questions about this loan agreement's terms.",
      );
      expect(body.groups).toHaveLength(1);
      expect(body.groups[0]).toMatchObject({
        slug: "borrower-obligations",
        title: "Borrower Obligations",
        status: "draft",
        ruleCount: 2,
      });
    });
  });

  test("GET /api/rulebooks/:slug 404s rulebook_not_found for a missing rule book", async () => {
    await withApi(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/rulebooks/nope`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("rulebook_not_found");
    });
  });

  test("GET /api/rulebooks/:slug/groups/:group mirrors the chapter-detail shape: { group, claims?, audit? }", async () => {
    await withApi(async ({ baseUrl, deps }) => {
      const slug = toVolumeSlug("rnb-loan-agreement");
      const groupSlug = toChapterSlug("borrower-obligations");
      await deps.rulebookStore.createRulebook({ slug, title: "RNB Loan Agreement" });
      await deps.rulebookStore.putGroup(slug, {
        slug: groupSlug,
        title: "Borrower Obligations",
        body: "- Borrowers must repay monthly.[^rule-1]",
      });

      const res = await fetch(
        `${baseUrl}/api/rulebooks/rnb-loan-agreement/groups/borrower-obligations`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        group: { slug: string; title: string; body: string };
        claims: unknown;
        audit: unknown;
      };
      expect(body.group.slug).toBe("borrower-obligations");
      expect(body.group.title).toBe("Borrower Obligations");
      // Never published through `publishGroup` in this test — no sidecar/audit yet.
      expect(body.claims).toBeUndefined();
      expect(body.audit).toBeUndefined();
    });
  });

  test("GET .../groups/:group returns claims once a sidecar has been written", async () => {
    await withApi(async ({ baseUrl, deps }) => {
      const slug = toVolumeSlug("rnb-loan-agreement");
      const groupSlug = toChapterSlug("borrower-obligations");
      await deps.rulebookStore.createRulebook({ slug, title: "RNB Loan Agreement" });
      await deps.rulebookStore.putGroup(slug, {
        slug: groupSlug,
        title: "Borrower Obligations",
        body: "- Borrowers must repay monthly.[^rule-1]",
      });
      const sidecar: ClaimSidecar = {
        schemaVersion: "1.0",
        chapter: groupSlug,
        chapterTextSha256: sha256Of("- Borrowers must repay monthly.[^rule-1]"),
        claims: [],
      };
      await deps.rulebookEvidenceStore.putClaims(slug, sidecar);

      const res = await fetch(
        `${baseUrl}/api/rulebooks/rnb-loan-agreement/groups/borrower-obligations`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { claims: { claims: unknown[] } | undefined };
      expect(body.claims).toBeDefined();
      expect(body.claims?.claims).toEqual([]);
    });
  });

  test("GET .../groups/:group 404s group_not_found for a missing group", async () => {
    await withApi(async ({ baseUrl, deps }) => {
      const slug = toVolumeSlug("rnb-loan-agreement");
      await deps.rulebookStore.createRulebook({ slug, title: "RNB Loan Agreement" });

      const res = await fetch(`${baseUrl}/api/rulebooks/rnb-loan-agreement/groups/nope`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("group_not_found");
    });
  });

  test("GET .../groups/:group 404s rulebook_not_found when the rule book itself doesn't exist", async () => {
    await withApi(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/rulebooks/nope/groups/nope`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("rulebook_not_found");
    });
  });
});
