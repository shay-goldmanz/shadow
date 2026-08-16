/**
 * One real end-to-end test: spawn the actual `bin.ts` executable (via its
 * shebang, not `bun run`) as a subprocess and read real stdout/stderr/exit
 * code. Everything else in this package tests the command layer directly
 * (`cli.test.ts`, `commands/*.test.ts`) — this is the one test that proves
 * the wiring (shebang, `process.argv`/`stdout`/`exit`) actually works when
 * run the way an agent's shell would run it.
 */

import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileSystemVolumeStore } from "@shadow/core";
import { buildSmallFixture } from "./test-fixture.ts";

const BIN_PATH = join(dirname(fileURLToPath(import.meta.url)), "bin.ts");

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shadow-cli-e2e-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function spawnShadow(
  args: readonly string[],
  root: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([BIN_PATH, ...args], {
    env: { ...process.env, SHADOW_HOME: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("bin.ts — real subprocess, real shebang", () => {
  test("the file is executable directly (shebang honored, not just `bun run`)", async () => {
    // chmod defensively — the file should already be +x, but a fresh
    // checkout can lose the bit, and this test's whole point is to prove
    // direct execution works.
    await chmod(BIN_PATH, 0o755);
    await withRoot(async (root) => {
      const { stdout, exitCode } = await spawnShadow([], root);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout).commands).toBeDefined();
    });
  });

  test("`shadow volumes` before indexing exits 4 with a JSON error envelope on stderr", async () => {
    await withRoot(async (root) => {
      const { stdout, stderr, exitCode } = await spawnShadow(["volumes"], root);
      expect(exitCode).toBe(4);
      expect(stdout).toBe("");
      const parsed = JSON.parse(stderr);
      expect(parsed.error.name).toBe("IndexMissingError");
      expect(parsed.next_steps.length).toBeGreaterThan(0);
    });
  });

  test("shadow index, then shadow find, then shadow read — a full real session", async () => {
    await withRoot(async (root) => {
      const store = new FileSystemVolumeStore(root);
      await buildSmallFixture(store, root);

      const indexed = await spawnShadow(["index"], root);
      expect(indexed.exitCode).toBe(0);
      expect(JSON.parse(indexed.stdout).stats.chapters).toBe(3);

      const found = await spawnShadow(["find", "dense table row height"], root);
      expect(found.exitCode).toBe(0);
      const findResult = JSON.parse(found.stdout);
      expect(findResult.stage).toBe("navigate");
      const nodeId = findResult.chapters[0].node_id;

      const read = await spawnShadow(["read", nodeId], root);
      expect(read.exitCode).toBe(0);
      expect(JSON.parse(read.stdout).body).toContain("Linear renders table rows");
    });
  });
});
