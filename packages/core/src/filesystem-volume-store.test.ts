import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidSlugError, VolumeNotFoundError } from "./errors.ts";
import { FileSystemVolumeStore } from "./filesystem-volume-store.ts";
import { toChapterSlug, toVolumeSlug, type VolumeSlug } from "./slug.ts";
import { expectRejection } from "./test-helpers.ts";
import { runVolumeStoreContractTests, type VolumeStoreHarness } from "./volume-store.contract.ts";

async function makeTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "shadow-core-test-"));
}

async function makeHarness(): Promise<VolumeStoreHarness> {
  const root = await makeTempRoot();
  return {
    store: new FileSystemVolumeStore(root),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

// Runs the full implementation-agnostic suite against the filesystem backend.
runVolumeStoreContractTests("FileSystemVolumeStore", makeHarness);

describe("FileSystemVolumeStore (filesystem-specific)", () => {
  test("defaults to ~/.shadow without touching disk at construction time", () => {
    // Construction is pure (no I/O), so this is safe to run without
    // sandboxing the real home directory.
    expect(() => new FileSystemVolumeStore()).not.toThrow();
  });

  test("on-disk layout matches <root>/volumes/<slug>/{VOLUME.md,chapters/<slug>.md,index.json,evidence/}", async () => {
    const root = await makeTempRoot();
    try {
      const store = new FileSystemVolumeStore(root);
      const volume = toVolumeSlug("layout-check");
      await store.createVolume({ slug: volume, title: "Layout Check" });
      await store.putChapter(volume, { slug: toChapterSlug("intro"), title: "Intro", body: "hi" });
      await store.writeIndex(volume, { ok: true });
      await store.ensureEvidenceDir(volume);

      const volumeDir = join(root, "volumes", volume);
      expect(await Bun.file(join(volumeDir, "VOLUME.md")).exists()).toBe(true);
      expect(await Bun.file(join(volumeDir, "chapters", "intro.md")).exists()).toBe(true);
      expect(await Bun.file(join(volumeDir, "index.json")).exists()).toBe(true);
      expect((await stat(join(volumeDir, "evidence"))).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("evidenceDir is pure path arithmetic: no I/O, no existence check, deterministic", async () => {
    const root = await makeTempRoot();
    try {
      const store = new FileSystemVolumeStore(root);
      const volume = toVolumeSlug("never-created");
      // The volume was never created; this must not throw or touch disk.
      const path = store.evidenceDir(volume);
      expect(path).toBe(join(root, "volumes", "never-created", "evidence"));
      await expectRejection(stat(path), Error);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ensureEvidenceDir creates the directory and requires the volume to exist", async () => {
    const root = await makeTempRoot();
    try {
      const store = new FileSystemVolumeStore(root);
      const volume = toVolumeSlug("ev");

      await expectRejection(store.ensureEvidenceDir(volume), VolumeNotFoundError);

      await store.createVolume({ slug: volume, title: "Ev" });
      const dir = await store.ensureEvidenceDir(volume);
      expect(dir).toBe(store.evidenceDir(volume));
      expect((await stat(dir)).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("security boundary: a forged slug that bypasses toVolumeSlug is still rejected at the path-building layer", async () => {
    const root = await makeTempRoot();
    try {
      const store = new FileSystemVolumeStore(root);
      // Simulates a value that skipped validation (e.g. an unsafe cast, or
      // JSON deserialized straight into a typed field). The brand is
      // erased at runtime, so nothing but re-validation here can catch it.
      const forgedTraversal = "../../etc/passwd" as unknown as VolumeSlug;
      const forgedAbsolute = "/etc/passwd" as unknown as VolumeSlug;
      const forgedNullByte = "abc\0def" as unknown as VolumeSlug;
      const forgedDotDot = ".." as unknown as VolumeSlug;

      await expectRejection(store.getVolume(forgedTraversal), InvalidSlugError);
      await expectRejection(store.getVolume(forgedAbsolute), InvalidSlugError);
      await expectRejection(store.getVolume(forgedNullByte), InvalidSlugError);
      await expectRejection(store.getVolume(forgedDotDot), InvalidSlugError);
      await expectRejection(
        store.createVolume({ slug: forgedTraversal, title: "Escape attempt" }),
        InvalidSlugError,
      );

      // Confirm nothing escaped the root: only the volumes dir exists, and it's empty.
      expect(await store.listVolumes()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
