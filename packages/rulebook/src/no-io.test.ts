/**
 * Structural guard for this package's core promise: everything in `src/`
 * except a small, explicit whitelist is pure and offline — no filesystem,
 * no network. Chunking, validation, merging, and labeling all have to work
 * identically whether called from a real pipeline or a test fixture; the
 * only place that's allowed to change is `ingest.ts` (its job — reading
 * the source Markdown/plain text off disk). Copied from `@shadow/agent`'s
 * `no-direct-fetch.test.ts` pattern: a behavioral test can only prove a
 * given run *didn't happen to* touch I/O; scanning the package's own
 * source is what proves it structurally *cannot*.
 *
 * `test-helpers.ts` is also whitelisted: it's test-only harness code
 * (temp-dir setup/teardown for `withRulebookHarness`), never imported by
 * the pipeline itself, so it sits outside the "pure pipeline" invariant this
 * guard exists to enforce — the same reason `@shadow/agent`'s and
 * `@shadow/core`'s own `test-helpers.ts` files aren't held to their
 * packages' purity conventions either.
 */

import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const SRC_DIR = import.meta.dir;
const IO_ALLOWED = new Set(["ingest.ts", "test-helpers.ts"]);

async function listGuardedSourceFiles(): Promise<string[]> {
  const entries = await readdir(SRC_DIR, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !IO_ALLOWED.has(entry.name),
    )
    .map((entry) => join(SRC_DIR, entry.name));
}

describe("@shadow/rulebook's pure pipeline stays free of I/O outside ingest.ts", () => {
  test("no guarded source file imports node:fs, calls Bun.file(...), or calls fetch(...)", async () => {
    const files = await listGuardedSourceFiles();
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = await readFile(file, "utf8");
      expect(content).not.toMatch(/from\s+["']node:fs/);
      expect(content).not.toMatch(/require\(\s*["']node:fs/);
      expect(content).not.toMatch(/\bBun\.file\s*\(/);
      expect(content).not.toMatch(/\bfetch\s*\(/);
    }
  });
});
