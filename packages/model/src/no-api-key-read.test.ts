import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * D5's guardrail, rule 2, enforced statically: "Our code must never read
 * `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` itself." Every adapter
 * resolves auth from a signal the SDK reports (see `guardrail.ts`), never
 * by inspecting these env vars directly. If either variable name is ever
 * *read off an environment object* in our implementation source, this test
 * fails the build before that code ships.
 *
 * Deliberately narrower than a bare substring search: `errors.ts` and
 * `guardrail.ts` legitimately *name* both variables in doc comments and
 * error messages (explaining what a caller should unset), which is
 * documentation, not a read. What must never appear is an actual access
 * pattern — `process.env.ANTHROPIC_API_KEY`, `Bun.env["ANTHROPIC_AUTH_TOKEN"]`,
 * a destructure off `process.env`, and so on.
 *
 * Scoped to `src/**\/*.ts` excluding `*.test.ts`: this test file names both
 * strings in its own source (it's the scanner), and `guardrail.test.ts`
 * legitimately sets/restores them via `process.env.ANTHROPIC_API_KEY = ...`
 * to *prove* the guardrail doesn't consult the environment — that's a test
 * fixture writing to the environment, not implementation code reading it.
 */
describe("no source file reads ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN", () => {
  test("static scan of src/**/*.ts (excluding *.test.ts)", async () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const glob = new Bun.Glob("**/*.ts");
    const offenders: string[] = [];

    // Matches `<something>env.ANTHROPIC_API_KEY`, `<something>env["ANTHROPIC_AUTH_TOKEN"]`,
    // `<something>env['ANTHROPIC_API_KEY']` — an access off any object whose
    // name ends in `env` (process.env, Bun.env, import.meta.env, ...).
    const readPattern = /\benv(?:\.|\[\s*['"])ANTHROPIC_(?:API_KEY|AUTH_TOKEN)\b/;
    // Matches a destructure off such an object: `{ ANTHROPIC_API_KEY } = process.env`.
    const destructurePattern = /\{[^}]*\bANTHROPIC_(?:API_KEY|AUTH_TOKEN)\b[^}]*\}\s*=\s*\S*env\b/;

    for await (const relativePath of glob.scan({ cwd: srcDir })) {
      if (relativePath.endsWith(".test.ts")) {
        continue;
      }
      const absolutePath = join(srcDir, relativePath);
      const contents = await readFile(absolutePath, "utf8");
      if (readPattern.test(contents) || destructurePattern.test(contents)) {
        offenders.push(relativePath);
      }
    }

    expect(offenders).toEqual([]);
  });
});
