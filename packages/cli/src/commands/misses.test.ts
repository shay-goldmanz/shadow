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
  test("a corrupt line in misses.jsonl loses only that line, not the whole backlog", async () => {
    await withStore(async (store, root) => {
      // Seed valid entries either side of a hand-corrupted line, the way a
      // crash mid-write or a manual edit could produce.
      const log = createMissLog(root);
      await log.append(toFindMissEntry({ query: "before", reason: "no-match" }));
      await mkdir(root, { recursive: true });
      await appendFile(`${root}/misses.jsonl`, "{ not valid json\n", "utf8");
      await log.append(toFindMissEntry({ query: "after", reason: "no-match" }));

      const cap = capture();
      const code = await run(["misses"], { store, root, write: cap.write, writeErr: cap.writeErr });

      // `FileMissLog.readAll()` recovers per line, so one bad line no longer
      // destroys the backlog. That matters because the miss log IS the
      // operator's authoring backlog (D14) and is append-only — losing all
      // of it to a single truncated write is the wrong failure mode for a
      // file whose whole job is to accumulate.
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.stdout.join("")) as {
        misses: { task: string }[];
        count: number;
      };
      expect(parsed.count).toBe(2);
      expect(parsed.misses.map((m) => m.task)).toEqual(["before", "after"]);
    });
  });
});

describe("shadow find and shadow misses agree on where the log lives", () => {
  test("a miss `runFind` writes is immediately visible to `runMisses`", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store, root);
      await runFind(store, root, "sourdough bread baking technique", { none: true });

      const result = await runMisses(root);
      expect(result.count).toBe(1);
      expect(result.misses[0]?.task).toBe("sourdough bread baking technique");
      expect(result.misses[0]?.source).toBe("find");
    });
  });
});
