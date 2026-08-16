import { describe, expect, test } from "bun:test";
import { toVolumeSlug } from "@shadow/core";
import { newSourceId } from "@shadow/evidence";
import { withApi } from "../test-helpers.ts";

describe("Rule book evidence", () => {
  test("a rule book source and its snapshot are served through the rule book's own evidence routes", async () => {
    await withApi(async ({ baseUrl, deps }) => {
      const slug = toVolumeSlug("rnb-loan-agreement");
      await deps.rulebookStore.createRulebook({ slug, title: "RNB Loan Agreement" });

      const extractedText = "the Borrower shall pay interest at a fixed rate of 6.5% per annum";
      const source = await deps.rulebookEvidenceStore.putSourceFromFile(
        slug,
        {
          path: "/rnb_loan.pdf",
          bytes: new TextEncoder().encode(extractedText),
          text: extractedText,
          readAt: new Date("2026-08-11T00:00:00.000Z"),
        },
        {
          title: "Loan Agreement",
          agent: "test",
          authority: { tier: "primary", rationale: "test fixture" },
          volatility: "unknown",
        },
      );

      const sourceRes = await fetch(
        `${baseUrl}/api/rulebooks/rnb-loan-agreement/sources/${source.id}`,
      );
      expect(sourceRes.status).toBe(200);
      const fetchedSource = (await sourceRes.json()) as { id: string; url: string };
      expect(fetchedSource.id).toBe(source.id);
      expect(fetchedSource.url).toBe("file:///rnb_loan.pdf");

      const snapshotRes = await fetch(
        `${baseUrl}/api/rulebooks/rnb-loan-agreement/snapshot/${source.snapshot.normalizedTextSha256}`,
      );
      expect(snapshotRes.status).toBe(200);
      expect(snapshotRes.headers.get("content-type")).toContain("text/plain");
      expect(await snapshotRes.text()).toBe(extractedText);
    });
  });

  test("a nonexistent rule book source is 404 source_not_found, not 500", async () => {
    await withApi(async ({ baseUrl, deps }) => {
      const slug = toVolumeSlug("rnb-loan-agreement");
      await deps.rulebookStore.createRulebook({ slug, title: "RNB Loan Agreement" });

      const res = await fetch(
        `${baseUrl}/api/rulebooks/rnb-loan-agreement/sources/${newSourceId()}`,
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("source_not_found");
    });
  });

  test("a nonexistent rule book snapshot hash is 404 snapshot_not_found, not 500", async () => {
    await withApi(async ({ baseUrl, deps }) => {
      const slug = toVolumeSlug("rnb-loan-agreement");
      await deps.rulebookStore.createRulebook({ slug, title: "RNB Loan Agreement" });

      const fakeHash = `sha256:${"0".repeat(64)}`;
      const res = await fetch(`${baseUrl}/api/rulebooks/rnb-loan-agreement/snapshot/${fakeHash}`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("snapshot_not_found");
    });
  });

  test("a source lookup against an unknown rule book slug is 404 source_not_found (no separate rule-book-existence check)", async () => {
    await withApi(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/rulebooks/does-not-exist/sources/${newSourceId()}`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("source_not_found");
    });
  });
});
