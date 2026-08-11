/**
 * D19/D23's second legitimate origin of a source record: a session turn.
 * These tests exercise `recordSessionTranscriptSource` against a real
 * `FileSystemEvidenceStore`, proving the resulting record is exactly what
 * `@shadow/evidence`'s operator-claim verification requires (`transport ===
 * "session"`) and that the operator's exact words resolve in the ledger —
 * the same bar `retrieval-tools.test.ts` holds retrieval-origin sources to.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemVolumeStore, toVolumeSlug } from "@shadow/core";
import { FileSystemEvidenceStore } from "@shadow/evidence";
import { recordSessionTranscriptSource } from "./transcript-source.ts";

async function withVolume<T>(
  fn: (store: FileSystemEvidenceStore, volume: ReturnType<typeof toVolumeSlug>) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "shadow-research-transcript-"));
  try {
    const volumeStore = new FileSystemVolumeStore(root);
    const volume = toVolumeSlug("test-volume");
    await volumeStore.createVolume({ slug: volume, title: "Test Volume" });
    return await fn(new FileSystemEvidenceStore(volumeStore), volume);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("recordSessionTranscriptSource", () => {
  test("records a source with transport 'session', the only transport an operator claim may cite", async () => {
    await withVolume(async (store, volume) => {
      const record = await recordSessionTranscriptSource(store, volume, {
        sessionId: "sess_abc123",
        turnText: "Operator: I really prefer borders over drop shadows for cards.",
      });

      expect(record.retrieval.transport).toBe("session");
      expect(record.url).toBe("session:sess_abc123");
      expect(record.authority.tier).toBe("primary");
      expect(record.volatility).toBe("never");
    });
  });

  test("the operator's exact words resolve in the persisted snapshot", async () => {
    await withVolume(async (store, volume) => {
      const record = await recordSessionTranscriptSource(store, volume, {
        sessionId: "sess_abc123",
        turnText: "Operator: I really prefer borders over drop shadows for cards.",
      });

      const snapshotText = await store.getSnapshotText(
        volume,
        record.snapshot.normalizedTextSha256,
      );
      expect(snapshotText).toContain("I really prefer borders over drop shadows for cards.");
    });
  });

  test("defaults agent/title sensibly but both are overridable", async () => {
    await withVolume(async (store, volume) => {
      const defaulted = await recordSessionTranscriptSource(store, volume, {
        sessionId: "sess_1",
        turnText: "text",
      });
      expect(defaulted.retrieval.agent).toBe("@shadow/agent/shadow-chat");
      expect(defaulted.title).toBe("Session transcript sess_1");

      const overridden = await recordSessionTranscriptSource(store, volume, {
        sessionId: "sess_2",
        turnText: "text",
        agent: "@shadow/agent/shadow-chat@1.2.3",
        title: "Operator belief: borders over shadows",
      });
      expect(overridden.retrieval.agent).toBe("@shadow/agent/shadow-chat@1.2.3");
      expect(overridden.title).toBe("Operator belief: borders over shadows");
    });
  });

  test("two turns from the same session get distinct source ids", async () => {
    await withVolume(async (store, volume) => {
      const first = await recordSessionTranscriptSource(store, volume, {
        sessionId: "sess_1",
        turnText: "I prefer borders.",
      });
      const second = await recordSessionTranscriptSource(store, volume, {
        sessionId: "sess_1",
        turnText: "I also prefer sage green accents.",
      });
      expect(first.id).not.toBe(second.id);
    });
  });
});
