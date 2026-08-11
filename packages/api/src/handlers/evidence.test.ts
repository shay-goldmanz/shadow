import { describe, expect, test } from "bun:test";
import { toVolumeSlug } from "@shadow/core";
import { seedVolume, withApi } from "../test-helpers.ts";

describe("Evidence", () => {
  test("a snapshot is served as text/plain and matches its content hash", async () => {
    await withApi(async ({ baseUrl, deps }) => {
      const volume = toVolumeSlug("design-craft");
      await seedVolume(deps, volume);

      const extractedText = "Linear renders its sidebar on a 4px spacing scale.";
      const source = await deps.evidenceStore.putSourceFromRetrieval(
        volume,
        {
          requestedUrl: "https://example.test/linear",
          finalUrl: "https://example.test/linear",
          httpStatus: 200,
          contentType: "text/plain",
          bytes: new TextEncoder().encode(extractedText),
          extractedText,
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

      const sourceRes = await fetch(
        `${baseUrl}/api/volumes/design-craft/evidence/sources/${source.id}`,
      );
      expect(sourceRes.status).toBe(200);
      const fetchedSource = (await sourceRes.json()) as { id: string; url: string };
      expect(fetchedSource.id).toBe(source.id);
      expect(fetchedSource.url).toBe("https://example.test/linear");

      const snapshotRes = await fetch(
        `${baseUrl}/api/volumes/design-craft/evidence/snapshot/${source.snapshot.normalizedTextSha256}`,
      );
      expect(snapshotRes.status).toBe(200);
      expect(snapshotRes.headers.get("content-type")).toContain("text/plain");
      const snapshotText = await snapshotRes.text();
      expect(snapshotText).toBe(extractedText);

      // The hash in the URL really is the content hash of what came back.
      const rehashed = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(snapshotText),
      );
      const hex = [...new Uint8Array(rehashed)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      expect(source.snapshot.normalizedTextSha256).toContain(hex);
    });
  });

  test("a nonexistent snapshot hash is 404, not 500", async () => {
    await withApi(async ({ baseUrl, deps }) => {
      const volume = toVolumeSlug("design-craft");
      await seedVolume(deps, volume);
      const fakeHash = `sha256:${"0".repeat(64)}`;
      const res = await fetch(`${baseUrl}/api/volumes/design-craft/evidence/snapshot/${fakeHash}`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("snapshot_not_found");
    });
  });

  test("a malformed digest is 400, not 500", async () => {
    await withApi(async ({ baseUrl, deps }) => {
      const volume = toVolumeSlug("design-craft");
      await seedVolume(deps, volume);
      const res = await fetch(`${baseUrl}/api/volumes/design-craft/evidence/snapshot/not-a-hash`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid_digest");
    });
  });

  test("the ledger reads back append-only, newest last", async () => {
    await withApi(async ({ baseUrl, deps }) => {
      const volume = toVolumeSlug("design-craft");
      await seedVolume(deps, volume);

      await deps.evidenceStore.appendLedgerEvent(volume, {
        ts: "2026-08-11T00:00:00.000Z",
        event: "audit.completed",
        chapter: "spacing",
        result: "pass",
        completeness: 1,
        narrativeRatio: 0,
      });
      await deps.evidenceStore.appendLedgerEvent(volume, {
        ts: "2026-08-11T00:01:00.000Z",
        event: "audit.completed",
        chapter: "spacing",
        result: "fail",
        completeness: 0.5,
        narrativeRatio: 0,
      });

      const res = await fetch(`${baseUrl}/api/volumes/design-craft/evidence/ledger`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { events: { ts: string; result: string }[] };
      expect(body.events).toHaveLength(2);
      expect(body.events[0]?.result).toBe("pass");
      expect(body.events[1]?.result).toBe("fail"); // newest last
    });
  });
});
