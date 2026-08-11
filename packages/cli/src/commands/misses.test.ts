import { describe, expect, test } from "bun:test";
import { appendFile, mkdir } from "node:fs/promises";
import { run } from "../cli.ts";
import { createMissLog, toFindMissEntry } from "../miss-log.ts";
import { buildSmallFixture, withStore } from "../test-fixture.ts";
import { runFind } from "./find.ts";
import { runMisses } from "./misses.ts";

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    write: (s: string) => stdout.push(s),
    writeErr: (s: string) => stderr.push(s),
  };
}

describe("runMisses", () => {
  test("an empty backlog renders [] with guidance next_steps, not an error", async () => {
    await withStore(async (_store, root) => {
      const result = await runMisses(root);
      expect(result.misses).toEqual([]);
      expect(result.count).toBe(0);
      expect(result.next_steps.length).toBeGreaterThan(0);
    });
  });

  test("reads back an entry `shadow find` wrote, with reason/round/source intact", async () => {
    await withStore(async (_store, root) => {
      await createMissLog(root).append(
        toFindMissEntry({ query: "sourdough bread", reason: "no-match", round: 2 }),
      );

      const result = await runMisses(root);
      expect(result.count).toBe(1);
      expect(result.misses[0]?.task).toBe("sourdough bread");
      expect(result.misses[0]?.reason).toBe("no-match");
      expect(result.misses[0]?.round).toBe(2);
      expect(result.misses[0]?.source).toBe("find");
      expect(result.next_steps.length).toBeGreaterThan(0);
    });
  });

  test("reads back a lint-shaped entry (no reason/round/source) without error", async () => {
    await withStore(async (_store, root) => {
      await createMissLog(root).append({
        task: "design a one-pager",
        sourceChapterId: "C1",
        recordedAt: "2026-08-11T00:00:00.000Z",
      });

      const result = await runMisses(root);
      expect(result.count).toBe(1);
      expect(result.misses[0]?.task).toBe("design a one-pager");
      expect(result.misses[0]?.reason).toBeUndefined();
      expect(result.misses[0]?.sourceChapterId).toBe("C1");
    });
  });
});

describe("shadow misses via the CLI dispatcher — survives a malformed line", () => {
  test("a corrupt line in misses.jsonl does not crash the process: run() still returns a clean error envelope", async () => {
    await withStore(async (store, root) => {
      // Seed one valid entry, then hand-corrupt the file the way a crash
      // mid-write or a manual edit could.
      await createMissLog(root).append(toFindMissEntry({ query: "q", reason: "no-match" }));
      await mkdir(root, { recursive: true });
      await appendFile(`${root}/misses.jsonl`, "{ not valid json\n", "utf8");

      const cap = capture();
      const code = await run(["misses"], { store, root, write: cap.write, writeErr: cap.writeErr });

      // FileMissLog.readAll() has no per-line recovery (see this task's
      // report) — it rejects on the bad line. What matters here is that
      // the CLI process itself never throws an uncaught exception or
      // prints a raw stack trace: `run()` still resolves, exits non-zero,
      // and stderr is a well-formed JSON error envelope with next_steps.
      expect(code).not.toBe(0);
      expect(cap.stdout).toEqual([]);
      const parsed = JSON.parse(cap.stderr.join(""));
      expect(typeof parsed.error.name).toBe("string");
      expect(parsed.next_steps.length).toBeGreaterThan(0);
    });
  });
});

describe("shadow find and shadow misses agree on where the log lives", () => {
  test("a miss `runFind` writes is immediately visible to `runMisses`", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store);
      await runFind(store, root, "sourdough bread baking technique", { none: true });

      const result = await runMisses(root);
      expect(result.count).toBe(1);
      expect(result.misses[0]?.task).toBe("sourdough bread baking technique");
      expect(result.misses[0]?.source).toBe("find");
    });
  });
});
