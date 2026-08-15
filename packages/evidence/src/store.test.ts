import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ChapterSlug,
  FileSystemVolumeStore,
  InvalidSlugError,
  toChapterSlug,
  toVolumeSlug,
} from "@shadow/core";
import { type Sha256Digest, sha256Of } from "./digest.ts";
import { InvalidDigestError, InvalidIdError } from "./errors.ts";
import type { SourceId } from "./ids.ts";
import { FileSystemEvidenceStore } from "./store.ts";
import {
  expectRejection,
  makeClaim,
  makeEvidenceSpan,
  makeFileWitness,
  makeRetrievalWitness,
  makeSelector,
  makeSidecar,
  makeSource,
  makeSourceMetadata,
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
  test("putSourceFromRetrieval derives and round-trips a source record (D23)", async () => {
    const { store, volume, cleanup } = await makeHarness();
    try {
      const source = await store.putSourceFromRetrieval(
        volume,
        makeRetrievalWitness(),
        makeSourceMetadata(),
      );
      expect(source.retrieval.transport).toBe("live");
      const roundTripped = await store.getSource(volume, source.id);
      expect(roundTripped).toEqual(source);
    } finally {
      await cleanup();
    }
  });

  test("putSourceFromTranscript derives a source record with transport 'session' (D19/D23)", async () => {
    const { store, volume, cleanup } = await makeHarness();
    try {
      const source = await store.putSourceFromTranscript(
        volume,
        {
          sessionId: "sess_abc",
          transcriptText: "Operator: I prefer borders.",
          capturedAt: new Date().toISOString(),
        },
        makeSourceMetadata({ agent: "shadow-chat" }),
      );
      expect(source.retrieval.transport).toBe("session");
      expect(source.url).toBe("session:sess_abc");
      const roundTripped = await store.getSource(volume, source.id);
      expect(roundTripped).toEqual(source);
    } finally {
      await cleanup();
    }
  });

  test("putSourceFromFile derives a source record with transport 'file'", async () => {
    const { store, volume, cleanup } = await makeHarness();
    try {
      const source = await store.putSourceFromFile(
        volume,
        makeFileWitness({ path: "/tmp/rnb_loan.pdf" }),
        makeSourceMetadata({ agent: "@shadow/rulebook/ingest" }),
      );
      expect(source.retrieval.transport).toBe("file");
      expect(source.url).toBe("file:///tmp/rnb_loan.pdf");
      expect(source.retrieval.httpStatus).toBeNull();
      expect(source.retrieval.contentType).toBeNull();
      const roundTripped = await store.getSource(volume, source.id);
      expect(roundTripped).toEqual(source);
      expect(await store.getSnapshotText(volume, source.snapshot.normalizedTextSha256)).toBe(
        "Every measurement in the sidebar is a multiple of four.",
      );
    } finally {
      await cleanup();
    }
  });

  test("listSources returns sources sorted by id", async () => {
    const { store, volume, cleanup } = await makeHarness();
    try {
      const a = await store.putSourceFromRetrieval(
        volume,
        makeRetrievalWitness({ extractedText: "First fixture snapshot text." }),
        makeSourceMetadata(),
      );
      const b = await store.putSourceFromRetrieval(
        volume,
        makeRetrievalWitness({ extractedText: "Second fixture snapshot text." }),
        makeSourceMetadata(),
      );
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
      const source = await store.putSourceFromRetrieval(
        volume,
        makeRetrievalWitness({
          bytes: new TextEncoder().encode(
            "<html>raw fetched bytes with an ad and a timestamp</html>",
          ),
          extractedText: "Every measurement is a multiple of four.",
        }),
        makeSourceMetadata(),
      );
      const normalizedTextSha256 = source.snapshot.normalizedTextSha256;

      const sidecar = makeSidecar({
        claims: [
          makeClaim({
            label: "lin-4px",
            kind: "sourced",
            evidence: [
              makeEvidenceSpan({
                sourceId: source.id,
                snapshotHash: normalizedTextSha256,
                selector: makeSelector({ exact: "multiple of four" }),
              }),
            ],
          }),
        ],
      });

      const lookup = await store.loadLookupFor(volume, sidecar);
      expect(lookup.getSource(source.id)).toEqual(source);
      expect(lookup.getSnapshotText(normalizedTextSha256)).toBe(
        "Every measurement is a multiple of four.",
      );
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

  // ---- C-3 (Wave 1 review): forged identifiers cannot escape the store ----
  //
  // Mirrors `packages/core/src/filesystem-volume-store.test.ts`'s
  // "security boundary" test: a value that skipped `toChapterSlug`/
  // `toSourceId`/`toDigest` (an unsafe cast, or JSON deserialized straight
  // into a typed field — exactly what an LLM-authored sidecar produces in
  // Wave 2) must still be rejected at the path-building layer, because the
  // brand on `ChapterSlug`/`SourceId`/`Sha256Digest` is erased at runtime.
  test("security boundary: forged identifiers that bypass the branded constructors are still rejected", async () => {
    const { store, volume, cleanup } = await makeHarness();
    try {
      const forgedChapter = "../../../../tmp/pwn" as unknown as ChapterSlug;
      const forgedSourceId = "../../../../tmp/pwn" as unknown as SourceId;
      const forgedDigest = "sha256:../../../../tmp/pwn" as unknown as Sha256Digest;

      await expectRejection(store.getClaims(volume, forgedChapter), InvalidSlugError);
      await expectRejection(
        store.putClaims(volume, makeSidecar({ chapter: "../../../../tmp/pwn" })),
        InvalidSlugError,
      );
      await expectRejection(store.getAudit(volume, forgedChapter), InvalidSlugError);
      await expectRejection(store.getSource(volume, forgedSourceId), InvalidIdError);
      await expectRejection(store.getSnapshotText(volume, forgedDigest), InvalidDigestError);
      await expectRejection(store.hasSnapshot(volume, forgedDigest), InvalidDigestError);

      // Confirm nothing escaped: no file was ever written outside the volume's evidence dir.
      expect(await Bun.file("/tmp/pwn.claims.json").exists()).toBe(false);
      expect(await Bun.file("/tmp/pwn.audit.json").exists()).toBe(false);
      expect(await Bun.file("/tmp/pwn.txt").exists()).toBe(false);
      expect(await Bun.file("/tmp/pwn.json").exists()).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
