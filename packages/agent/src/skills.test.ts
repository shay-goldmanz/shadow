import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWritingVolumesSkillInstalled } from "./skills.ts";

describe("ensureWritingVolumesSkillInstalled", () => {
  test("copies the canonical skills/writing-volumes/SKILL.md into <targetDir>/.claude/skills/writing-volumes/SKILL.md", async () => {
    const targetDir = await mkdtemp(join(tmpdir(), "shadow-agent-skill-install-"));
    try {
      const result = await ensureWritingVolumesSkillInstalled(targetDir);
      expect(result.skill).toBe("writing-volumes");
      expect(result.path).toBe(join(targetDir, ".claude", "skills", "writing-volumes", "SKILL.md"));

      const written = await readFile(result.path, "utf8");
      const canonical = await readFile(
        join(import.meta.dir, "..", "..", "..", "skills", "writing-volumes", "SKILL.md"),
        "utf8",
      );
      expect(written).toBe(canonical);
      // The canonical skill file's own frontmatter — spot-check it round-tripped verbatim.
      expect(written).toContain("name: writing-volumes");
      expect(written).toContain("when_to_use");
    } finally {
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  test("is idempotent: calling twice leaves the same content in place", async () => {
    const targetDir = await mkdtemp(join(tmpdir(), "shadow-agent-skill-install-"));
    try {
      const first = await ensureWritingVolumesSkillInstalled(targetDir);
      const second = await ensureWritingVolumesSkillInstalled(targetDir);
      expect(second.path).toBe(first.path);
      const content = await readFile(second.path, "utf8");
      expect(content.length).toBeGreaterThan(0);
    } finally {
      await rm(targetDir, { recursive: true, force: true });
    }
  });
});
