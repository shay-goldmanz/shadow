import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMissLog, InMemoryMissLog, type MissLogEntry } from "./lint-miss-log.ts";

async function withTmpFile(fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "shadow-misslog-test-"));
  try {
    await fn(join(dir, "misses.jsonl"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const entry = (task: string, sourceChapterId = "C1"): MissLogEntry => ({
  task,
  sourceChapterId,
  recordedAt: "2026-08-11T00:00:00.000Z",
});

describe("InMemoryMissLog", () => {
  test("append then readAll round-trips, in order", async () => {
    const log = new InMemoryMissLog();
    await log.append(entry("design a one-pager"));
    await log.append(entry("choose a table row height"));

    const all = await log.readAll();
    expect(all).toHaveLength(2);
    expect(all[0]?.task).toBe("design a one-pager");
    expect(all[1]?.task).toBe("choose a table row height");
  });

  test("readAll on an empty log returns an empty array", async () => {
    expect(await new InMemoryMissLog().readAll()).toEqual([]);
  });
});

describe("FileMissLog", () => {
  test("append is append-only and survives repeated runs (fresh instances re-reading the same file)", async () => {
    await withTmpFile(async (path) => {
      const first = new FileMissLog(path);
      await first.append(entry("design a one-pager", "C1"));

      // A brand new instance over the same path — simulating a second,
      // later `shadow lint` invocation — sees the prior entry and can
      // append its own without disturbing it.
      const second = new FileMissLog(path);
      await second.append(entry("pick a font scale", "C2"));

      const all = await second.readAll();
      expect(all).toHaveLength(2);
      expect(all[0]).toEqual(entry("design a one-pager", "C1"));
      expect(all[1]).toEqual(entry("pick a font scale", "C2"));
    });
  });

  test("readAll on a file that has never been written returns an empty array, not an error", async () => {
    await withTmpFile(async (path) => {
      expect(await new FileMissLog(path).readAll()).toEqual([]);
    });
  });

  test("creates parent directories on first append", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shadow-misslog-nested-"));
    try {
      const path = join(dir, "nested", "deeper", "misses.jsonl");
      const log = new FileMissLog(path);
      await log.append(entry("a task"));
      expect(await log.readAll()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("entries are newline-delimited JSON, one object per line", async () => {
    await withTmpFile(async (path) => {
      const log = new FileMissLog(path);
      await log.append(entry("first"));
      await log.append(entry("second"));

      const raw = await Bun.file(path).text();
      const lines = raw.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0] as string).task).toBe("first");
      expect(JSON.parse(lines[1] as string).task).toBe("second");
    });
  });
});
