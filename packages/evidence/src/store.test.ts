import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemVolumeStore, toChapterSlug, toVolumeSlug } from "@shadow/core";
import { sha256Of } from "./digest.ts";
import { computeSnapshotDigests } from "./normalize.ts";
import { FileSystemEvidenceStore } from "./store.ts";
import {
  expectRejection,
  makeClaim,
  makeEvidenceSpan,
  makeSelector,
  makeSidecar,
  makeSource,
} from "./test-helpers.ts";

async function makeHarness() {
  const root = await mkdtemp(join(tmpdir(), "shadow-evidence-test-"));
  const volumeStore = new FileSystemVolumeStore(root);
  const volume = toVolumeSlug("test-volume");
  await volumeStore.createVolume({ slug: volume, title: "Test Volume" });
  const store = new FileSystemEvidenceStore(volumeStore);
  return {
    store,
    volume,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

describe("FileSystemEvidenceStore", () => {
  test("round-trips a source record", async () => {
    const { store, volume, cleanup } = await makeHarness();
    try {
      const source = makeSource();
      await store.putSource(volume, source);
      const roundTripped = await store.getSource(volume, source.id);
      expect(roundTripped).toEqual(source);
    } finally {
      await cleanup();
    }
  });

  test("listSources returns sources sorted by id", async () => {
    const { store, volume, cleanup } = await makeHarness();
    try {
      const a = makeSource();
      const b = makeSource();
      await store.putSource(volume, a);
      await store.putSource(volume, b);
      const listed = await store.listSources(volume);
      expect(listed).toHaveLength(2);
      expect(listed.map((s) => s.id)).toEqual([a, b].map((s) => s.id).toSorted());
    } finally {
      await cleanup();
    }
  });

  test("getSource throws SourceNotFoundError for a missing id", async () => {
    const { store, volume, cleanup } = await makeHarness();
    try {
      const { SourceNotFoundError } = await import("./errors.ts");
      const { newSourceId } = await import("./ids.ts");
      await expectRejection(store.getSource(volume, newSourceId()), SourceNotFoundError);
    } finally {
      await cleanup();
    }
  });

  test("snapshots are content-addressed: identical text dedupes to the same file", async () => {
    const { store, volume, cleanup } = await makeHarness();
    try {
      const text = "Every measurement in the sidebar is a multiple of four.";
      const hash1 = await store.putSnapshot(volume, text);
      const hash2 = await store.putSnapshot(volume, text);
      expect(hash1).toBe(hash2);
      expect(hash1).toBe(sha256Of(text));
      const roundTripped = await store.getSnapshotText(volume, hash1);
      expect(roundTripped).toBe(text);
    } finally {
      await cleanup();
    }
  });

  test("different text produces a different snapshot hash and file", async () => {
    const { store, volume, cleanup } = await makeHarness();
    try {
      const hashA = await store.putSnapshot(volume, "Text A.");
      const hashB = await store.putSnapshot(volume, "Text B.");
      expect(hashA).not.toBe(hashB);
      expect(await store.hasSnapshot(volume, hashA)).toBe(true);
      expect(await store.hasSnapshot(volume, hashB)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("getSnapshotText throws SnapshotNotFoundError for a missing hash", async () => {
    const { store, volume, cleanup } = await makeHarness();
    try {
      const { SnapshotNotFoundError } = await import("./errors.ts");
      await expectRejection(
        store.getSnapshotText(volume, sha256Of("never stored")),
        SnapshotNotFoundError,
      );
    } finally {
      await cleanup();
    }
  });

  test("round-trips a claim sidecar", async () => {
    const { store, volume, cleanup } = await makeHarness();
    try {
      const chapter = toChapterSlug("how-linear-designs-ui");
      const sidecar = makeSidecar({
        chapter,
        claims: [makeClaim({ label: "lin-4px", kind: "sourced", evidence: [makeEvidenceSpan()] })],
      });
      await store.putClaims(volume, sidecar);
      const roundTripped = await store.getClaims(volume, chapter);
      expect(roundTripped).toEqual(sidecar);
    } finally {
      await cleanup();
    }
  });

  test("getClaims returns undefined for a chapter with no sidecar yet", async () => {
    const { store, volume, cleanup } = await makeHarness();
    try {
      const result = await store.getClaims(volume, toChapterSlug("never-audited"));
      expect(result).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test("putClaims retires a label removed from the sidecar, visible via getRetiredLabels", async () => {
    const { store, volume, cleanup } = await makeHarness();
    try {
      const chapter = toChapterSlug("evolving-chapter");
      const first = makeSidecar({
        chapter,
        claims: [
          makeClaim({ label: "keep", kind: "sourced", evidence: [makeEvidenceSpan()] }),
          makeClaim({ label: "will-be-deleted", kind: "sourced", evidence: [makeEvidenceSpan()] }),
        ],
      });
      await store.putClaims(volume, first);

      const second = makeSidecar({
        chapter,
        claims: [makeClaim({ label: "keep", kind: "sourced", evidence: [makeEvidenceSpan()] })],
      });
      await store.putClaims(volume, second);

      const retired = await store.getRetiredLabels(volume, chapter);
      expect(retired.has("will-be-deleted")).toBe(true);
      expect(retired.has("keep")).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("round-trips an audit record", async () => {
    const { store, volume, cleanup } = await makeHarness();
    try {
      const chapter = toChapterSlug("audited-chapter");
      const record = {
        chapter: "audited-chapter",
        auditedAt: new Date().toISOString(),
        verdict: { chapter: "audited-chapter", passed: true, outcomes: [] },
      };
      await store.putAudit(volume, chapter, record);
      const roundTripped = await store.getAudit(volume, chapter);
      expect(roundTripped).toEqual(record);
    } finally {
      await cleanup();
    }
  });

  test("round-trips the manifest", async () => {
    const { store, volume, cleanup } = await makeHarness();
    try {
      const manifest = {
        schemaVersion: "1.0" as const,
        sourceCount: 2,
        snapshotCount: 2,
        chapters: { "how-linear-designs-ui": { result: "pass" as const } },
      };
      await store.putManifest(volume, manifest);
      const roundTripped = await store.getManifest(volume);
      expect(roundTripped).toEqual(manifest);
    } finally {
      await cleanup();
    }
  });

  test("ledger round-trips events in append order", async () => {
    const { store, volume, cleanup } = await makeHarness();
    try {
      const source = makeSource();
      await store.appendLedgerEvent(volume, {
        ts: "2026-08-11T00:00:00Z",
        event: "source.retrieved",
        sourceId: source.id,
        normalizedTextSha256: source.snapshot.normalizedTextSha256,
      });
      await store.appendLedgerEvent(volume, {
        ts: "2026-08-11T00:01:00Z",
        event: "audit.completed",
        chapter: "how-linear-designs-ui",
        result: "pass",
        completeness: 1,
        narrativeRatio: 0.41,
      });
      const events = await store.readLedger(volume);
      expect(events).toHaveLength(2);
      expect(events[0]?.event).toBe("source.retrieved");
      expect(events[1]?.event).toBe("audit.completed");
    } finally {
      await cleanup();
    }
  });

  test("ledger is append-only: existing lines are never rewritten", async () => {
    const { store, volume, cleanup } = await makeHarness();
    try {
      for (let i = 0; i < 5; i++) {
        await store.appendLedgerEvent(volume, {
          ts: new Date(2026, 0, 1, 0, i).toISOString(),
          event: "audit.completed",
          chapter: `chapter-${i}`,
          result: "pass",
          completeness: 1,
          narrativeRatio: 0,
        });
      }
      const events = await store.readLedger(volume);
      expect(events).toHaveLength(5);
      expect(events.map((e) => (e as { chapter: string }).chapter)).toEqual([
        "chapter-0",
        "chapter-1",
        "chapter-2",
        "chapter-3",
        "chapter-4",
      ]);
    } finally {
      await cleanup();
    }
  });

  test("readLedger returns an empty array before anything has been appended", async () => {
    const { store, volume, cleanup } = await makeHarness();
    try {
      expect(await store.readLedger(volume)).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("loadLookupFor batch-loads exactly the sources/snapshots a sidecar cites", async () => {
    const { store, volume, cleanup } = await makeHarness();
    try {
      const rawPayload = "<html>raw fetched bytes with an ad and a timestamp</html>";
      const digests = computeSnapshotDigests(
        rawPayload,
        "Every measurement is a multiple of four.",
      );
      await store.putSnapshot(volume, digests.normalizedText);
      const source = makeSource({
        snapshot: {
          path: `snapshots/${digests.normalizedTextSha256.slice(7)}.txt`,
          payloadSha256: digests.payloadSha256,
          normalizedTextSha256: digests.normalizedTextSha256,
          normalization: "nfc-ws-v1",
          chars: digests.chars,
        },
      });
      await store.putSource(volume, source);

      const sidecar = makeSidecar({
        claims: [
          makeClaim({
            label: "lin-4px",
            kind: "sourced",
            evidence: [
              makeEvidenceSpan({
                sourceId: source.id,
                snapshotHash: digests.normalizedTextSha256,
                selector: makeSelector({ exact: "multiple of four" }),
              }),
            ],
          }),
        ],
      });

      const lookup = await store.loadLookupFor(volume, sidecar);
      expect(lookup.getSource(source.id)).toEqual(source);
      expect(lookup.getSnapshotText(digests.normalizedTextSha256)).toBe(digests.normalizedText);
    } finally {
      await cleanup();
    }
  });

  test("loadLookupFor tolerates missing sources/snapshots rather than throwing", async () => {
    const { store, volume, cleanup } = await makeHarness();
    try {
      const sidecar = makeSidecar({
        claims: [makeClaim({ label: "x", kind: "sourced", evidence: [makeEvidenceSpan()] })],
      });
      const lookup = await store.loadLookupFor(volume, sidecar);
      expect(lookup.getSource(sidecar.claims[0]?.evidence[0]?.sourceId as never)).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});
