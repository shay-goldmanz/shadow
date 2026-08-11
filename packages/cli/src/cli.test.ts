import { describe, expect, test } from "bun:test";
import { run } from "./cli.ts";
import { buildSmallFixture, withStore } from "./test-fixture.ts";

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

describe("run — dispatch, exit codes, and the stdout/stderr split", () => {
  test("no arguments: prints usage to stdout, exit 0", async () => {
    await withStore(async (store, root) => {
      const cap = capture();
      const code = await run([], { store, root, write: cap.write, writeErr: cap.writeErr });
      expect(code).toBe(0);
      expect(cap.stdout.join("")).toContain("volumes");
      expect(cap.stderr).toEqual([]);
    });
  });

  test("an unknown subcommand is a usage error on stderr, exit 2, with next_steps", async () => {
    await withStore(async (store, root) => {
      const cap = capture();
      const code = await run(["bogus"], { store, root, write: cap.write, writeErr: cap.writeErr });
      expect(code).toBe(2);
      expect(cap.stdout).toEqual([]);
      const parsed = JSON.parse(cap.stderr.join(""));
      expect(parsed.next_steps.length).toBeGreaterThan(0);
    });
  });

  test("`volumes` succeeds: JSON on stdout, exit 0, nothing on stderr", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store);
      const cap = capture();
      const code = await run(["volumes"], {
        store,
        root,
        write: cap.write,
        writeErr: cap.writeErr,
      });
      expect(code).toBe(0);
      expect(cap.stderr).toEqual([]);
      const parsed = JSON.parse(cap.stdout.join(""));
      expect(parsed.volumes.length).toBe(2);
    });
  });

  test("`volumes` before `shadow index`: IndexMissingError on stderr, exit 4", async () => {
    await withStore(async (store, root) => {
      const cap = capture();
      const code = await run(["volumes"], {
        store,
        root,
        write: cap.write,
        writeErr: cap.writeErr,
      });
      expect(code).toBe(4);
      const parsed = JSON.parse(cap.stderr.join(""));
      expect(parsed.error.name).toBe("IndexMissingError");
      expect(parsed.next_steps.length).toBeGreaterThan(0);
    });
  });

  test("`chapters` with no volume argument is a usage error, exit 2", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store);
      const cap = capture();
      const code = await run(["chapters"], {
        store,
        root,
        write: cap.write,
        writeErr: cap.writeErr,
      });
      expect(code).toBe(2);
    });
  });

  test("`chapters <volume> --rank` ranks and returns exit 0", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store);
      const cap = capture();
      const code = await run(["chapters", "ui-design", "--rank", "dense table"], {
        store,
        root,
        write: cap.write,
        writeErr: cap.writeErr,
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.stdout.join(""));
      expect(parsed.chapters[0]?.score).toBeGreaterThan(0);
    });
  });

  test("`chapters` on an unknown volume is a not-found error, exit 3", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store);
      const cap = capture();
      const code = await run(["chapters", "nope"], {
        store,
        root,
        write: cap.write,
        writeErr: cap.writeErr,
      });
      expect(code).toBe(3);
    });
  });

  test("`find` with a quoted task string returns navigate JSON, exit 0", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store);
      const cap = capture();
      const code = await run(["find", "dense table row height"], {
        store,
        root,
        write: cap.write,
        writeErr: cap.writeErr,
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.stdout.join(""));
      expect(parsed.stage).toBe("navigate");
    });
  });

  test("`find` round-trips --visited/--round flags", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store);
      const cap1 = capture();
      await run(["find", "dense table row height"], {
        store,
        root,
        write: cap1.write,
        writeErr: cap1.writeErr,
      });
      const round1 = JSON.parse(cap1.stdout.join(""));
      const firstId: string = round1.chapters[0].node_id;

      const cap2 = capture();
      const code = await run(
        ["find", "dense table row height", "--visited", firstId, "--round", "2"],
        { store, root, write: cap2.write, writeErr: cap2.writeErr },
      );
      expect(code).toBe(0);
      const round2 = JSON.parse(cap2.stdout.join(""));
      expect(round2.round).toBe(2);
      expect(round2.visited).toEqual([firstId]);
    });
  });

  test("`read <node_id>` returns body JSON, exit 0", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store);
      const findCap = capture();
      await run(["find", "dense table"], {
        store,
        root,
        write: findCap.write,
        writeErr: findCap.writeErr,
      });
      const nodeId: string = JSON.parse(findCap.stdout.join("")).chapters[0].node_id;

      const cap = capture();
      const code = await run(["read", nodeId], {
        store,
        root,
        write: cap.write,
        writeErr: cap.writeErr,
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.stdout.join(""));
      expect(typeof parsed.body).toBe("string");
      expect(parsed.parent_when_to_use).toBeUndefined();
    });
  });

  test("`read <node_id> --with-parents` includes parent_when_to_use", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store);
      const findCap = capture();
      await run(["find", "dense table"], {
        store,
        root,
        write: findCap.write,
        writeErr: findCap.writeErr,
      });
      const nodeId: string = JSON.parse(findCap.stdout.join("")).chapters[0].node_id;

      const cap = capture();
      await run(["read", nodeId, "--with-parents"], {
        store,
        root,
        write: cap.write,
        writeErr: cap.writeErr,
      });
      const parsed = JSON.parse(cap.stdout.join(""));
      expect(typeof parsed.parent_when_to_use).toBe("string");
    });
  });

  test("`read` on a bad node_id is a not-found error, exit 3", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store);
      const cap = capture();
      const code = await run(["read", "bogus-node-id"], {
        store,
        root,
        write: cap.write,
        writeErr: cap.writeErr,
      });
      expect(code).toBe(3);
    });
  });

  test("`grep <terms>` returns hits JSON, exit 0", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store);
      const cap = capture();
      const code = await run(["grep", "pull quote editorial"], {
        store,
        root,
        write: cap.write,
        writeErr: cap.writeErr,
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.stdout.join(""));
      expect(Array.isArray(parsed.hits)).toBe(true);
    });
  });

  test("`index` builds and persists, exit 0", async () => {
    await withStore(async (store, root) => {
      const { toChapterSlug, toVolumeSlug } = await import("@shadow/core");
      await store.createVolume({ slug: toVolumeSlug("v"), title: "V" });
      await store.putChapter(toVolumeSlug("v"), {
        slug: toChapterSlug("c"),
        title: "C",
        body: "b",
      });

      const cap = capture();
      const code = await run(["index"], { store, root, write: cap.write, writeErr: cap.writeErr });
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.stdout.join(""));
      expect(parsed.stats.chapters).toBe(1);
    });
  });

  test("`index --check` on a never-built corpus is stale, exit 5", async () => {
    await withStore(async (store, root) => {
      const { toVolumeSlug } = await import("@shadow/core");
      await store.createVolume({ slug: toVolumeSlug("v"), title: "V" });
      const cap = capture();
      const code = await run(["index", "--check"], {
        store,
        root,
        write: cap.write,
        writeErr: cap.writeErr,
      });
      expect(code).toBe(5);
    });
  });

  test("--json produces pretty-printed (multi-line) output", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store);
      const cap = capture();
      await run(["volumes", "--json"], { store, root, write: cap.write, writeErr: cap.writeErr });
      expect(cap.stdout.join("")).toContain("\n  ");
    });
  });
});
