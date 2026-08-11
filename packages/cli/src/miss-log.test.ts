import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMiss, readMisses } from "./miss-log.ts";

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shadow-miss-log-test-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("appendMiss / readMisses", () => {
  test("readMisses returns [] when no log exists yet", async () => {
    await withRoot(async (root) => {
      expect(await readMisses(root)).toEqual([]);
    });
  });

  test("appendMiss writes a JSON line the operator's backlog can read back", async () => {
    await withRoot(async (root) => {
      await appendMiss(root, { query: "how to bake bread", reason: "no-match" });
      const misses = await readMisses(root);
      expect(misses).toHaveLength(1);
      expect(misses[0]?.query).toBe("how to bake bread");
      expect(misses[0]?.reason).toBe("no-match");
      expect(typeof misses[0]?.ts).toBe("string");
    });
  });

  test("appends across calls, in order, without clobbering prior entries", async () => {
    await withRoot(async (root) => {
      await appendMiss(root, { query: "first", reason: "no-match" });
      await appendMiss(root, { query: "second", reason: "empty-corpus" });
      const misses = await readMisses(root);
      expect(misses.map((m) => m.query)).toEqual(["first", "second"]);
    });
  });

  test("creates the root directory if it does not exist yet", async () => {
    await withRoot(async (root) => {
      const nested = join(root, "nested", "deeper");
      await appendMiss(nested, { query: "q", reason: "no-match" });
      expect(await readMisses(nested)).toHaveLength(1);
    });
  });
});
