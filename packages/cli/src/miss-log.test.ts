import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMissLog } from "@shadow/indexing";
import {
  createMissLog,
  isFindMiss,
  missLogPath,
  toFindMissEntry,
  widenMisses,
} from "./miss-log.ts";

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shadow-miss-log-test-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("missLogPath", () => {
  test("is a sibling of the corpus index, at <root>/misses.jsonl", () => {
    expect(missLogPath("/some/root")).toBe(join("/some/root", "misses.jsonl"));
  });
});

describe("createMissLog", () => {
  test("returns a MissLogStore backed by @shadow/indexing's FileMissLog at missLogPath(root)", async () => {
    await withRoot(async (root) => {
      const log = createMissLog(root);
      await log.append(toFindMissEntry({ query: "q", reason: "no-match" }));

      // Read through a fresh FileMissLog over the exact path createMissLog
      // should have used — proves this isn't a parallel implementation.
      const direct = new FileMissLog(missLogPath(root));
      const all = await direct.readAll();
      expect(all).toHaveLength(1);
      expect(all[0]?.task).toBe("q");
    });
  });
});

describe("toFindMissEntry", () => {
  test("carries task/reason/round/source, stamped with the given clock", () => {
    const entry = toFindMissEntry({
      query: "how to bake bread",
      reason: "no-match",
      round: 2,
      now: () => new Date("2026-08-11T00:00:00.000Z"),
    });
    expect(entry).toEqual({
      task: "how to bake bread",
      source: "find",
      reason: "no-match",
      round: 2,
      recordedAt: "2026-08-11T00:00:00.000Z",
    });
  });

  test("omits round when not given — JSON.stringify drops it rather than persisting `round: undefined`", () => {
    const entry = toFindMissEntry({ query: "q", reason: "empty-corpus" });
    expect(JSON.parse(JSON.stringify(entry))).not.toHaveProperty("round");
  });
});

describe("isFindMiss / widenMisses", () => {
  test("isFindMiss is true for find-shaped entries, false for lint-shaped entries", () => {
    const find = toFindMissEntry({ query: "q", reason: "no-match" });
    const lint = { task: "t", sourceChapterId: "C1", recordedAt: "2026-08-11T00:00:00.000Z" };
    const [widenedFind, widenedLint] = widenMisses([find, lint]);
    expect(widenedFind && isFindMiss(widenedFind)).toBe(true);
    expect(widenedLint && isFindMiss(widenedLint)).toBe(false);
  });
});
