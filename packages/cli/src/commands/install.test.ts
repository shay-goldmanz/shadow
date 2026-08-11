import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SkillAlreadyInstalledError } from "../errors.ts";
import { runInstall } from "./install.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "shadow-install-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("runInstall", () => {
  test("writes the shadow-volumes skill to <target>/.claude/skills/shadow-volumes/SKILL.md", async () => {
    await withTempDir(async (target) => {
      const result = await runInstall({ target });

      expect(result.skill).toBe("shadow-volumes");
      expect(result.written).toBe(join(target, ".claude", "skills", "shadow-volumes", "SKILL.md"));

      const written = await readFile(result.written, "utf8");
      expect(written).toContain("name: shadow-volumes");
      expect(written).toContain("shadow find");
    });
  });

  test("--target is honoured over the default (cwd)", async () => {
    await withTempDir(async (target) => {
      const result = await runInstall({ target });
      expect(result.target).toBe(resolve(target));
    });
  });

  test("defaults the target to the current working directory when --target is omitted", async () => {
    await withTempDir(async (target) => {
      const originalCwd = process.cwd();
      process.chdir(target);
      // `process.cwd()` resolves symlinks (e.g. macOS's /var -> /private/var)
      // while the temp-dir path from `mkdtemp` may not — read it back after
      // `chdir` rather than re-deriving it from `target` with `resolve()`.
      const chdirTarget = process.cwd();
      try {
        const result = await runInstall({});
        expect(result.target).toBe(chdirTarget);
        expect(result.written).toBe(
          join(chdirTarget, ".claude", "skills", "shadow-volumes", "SKILL.md"),
        );
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  test("refuses to clobber an existing skill file without --force", async () => {
    await withTempDir(async (target) => {
      const destDir = join(target, ".claude", "skills", "shadow-volumes");
      await mkdir(destDir, { recursive: true });
      await writeFile(join(destDir, "SKILL.md"), "pre-existing content", "utf8");

      const error = await runInstall({ target }).catch((e) => e);
      expect(error).toBeInstanceOf(SkillAlreadyInstalledError);
      expect(error.nextSteps.length).toBeGreaterThan(0);
      expect(error.nextSteps.join(" ")).toContain("--force");

      // The pre-existing file must be untouched.
      const stillThere = await readFile(join(destDir, "SKILL.md"), "utf8");
      expect(stillThere).toBe("pre-existing content");
    });
  });

  test("--force overwrites an existing skill file", async () => {
    await withTempDir(async (target) => {
      const destDir = join(target, ".claude", "skills", "shadow-volumes");
      await mkdir(destDir, { recursive: true });
      await writeFile(join(destDir, "SKILL.md"), "pre-existing content", "utf8");

      const result = await runInstall({ target, force: true });
      const written = await readFile(result.written, "utf8");
      expect(written).not.toBe("pre-existing content");
      expect(written).toContain("name: shadow-volumes");
    });
  });

  test("--force is a no-op (still succeeds) when no file previously existed", async () => {
    await withTempDir(async (target) => {
      const result = await runInstall({ target, force: true });
      expect(result.skill).toBe("shadow-volumes");
    });
  });

  test("next_steps is present and non-empty on success", async () => {
    await withTempDir(async (target) => {
      const result = await runInstall({ target });
      expect(Array.isArray(result.next_steps)).toBe(true);
      expect(result.next_steps.length).toBeGreaterThan(0);
      for (const step of result.next_steps) {
        expect(typeof step).toBe("string");
        expect(step.length).toBeGreaterThan(0);
      }
    });
  });

  test("next_steps is present and non-empty on the clobber-refused failure", async () => {
    await withTempDir(async (target) => {
      const destDir = join(target, ".claude", "skills", "shadow-volumes");
      await mkdir(destDir, { recursive: true });
      await writeFile(join(destDir, "SKILL.md"), "pre-existing content", "utf8");

      const error: SkillAlreadyInstalledError = await runInstall({ target }).catch((e) => e);
      expect(error.nextSteps.length).toBeGreaterThan(0);
      const envelope = error.toEnvelope();
      expect(envelope.next_steps).toEqual(error.nextSteps);
      expect(envelope.error.name).toBe("SkillAlreadyInstalledError");
    });
  });

  test("creates the .claude/skills directory tree when it does not exist yet", async () => {
    await withTempDir(async (target) => {
      // No .claude directory at all beforehand.
      const result = await runInstall({ target });
      const written = await readFile(result.written, "utf8");
      expect(written.length).toBeGreaterThan(0);
    });
  });
});
