/**
 * Makes the `shadow-write-volumes` skill (T3.2, `skills/shadow-write-volumes/SKILL.md`)
 * discoverable by Shadow's own agentic session.
 *
 * **How the session finds `skills/`.** The Agent SDK's `skills` option
 * (`@shadow/model`'s `AgenticSessionOptions.skills`) is a *filter* over
 * skills the CLI discovers on disk — it is not a "load this file" API.
 * Discovery is filesystem-based, under `<cwd>/.claude/skills/<name>/SKILL.md`
 * for project-scope skills (gated by `settingSources` including
 * `"project"`). The monorepo's canonical skill lives at the top-level
 * `skills/shadow-write-volumes/SKILL.md`, *not* under `.claude/`, so Shadow's
 * session cannot see it without a copy landing in the right place first —
 * exactly the same problem `@shadow/cli`'s `shadow install` solves for a
 * *coding agent* consuming `skills/shadow-find/SKILL.md` (see
 * `packages/cli/src/commands/install.ts`). This module is that same move,
 * aimed at Shadow itself: copy the canonical file into
 * `<targetDir>/.claude/skills/shadow-write-volumes/SKILL.md` before creating a
 * session with `cwd: targetDir`.
 *
 * `targetDir` defaults (in `conversation.ts`) to the operator's `~/.shadow`
 * root — the one directory this whole stack already treats as home (D4) —
 * so nothing is written into the monorepo's own working tree. Tests pass an
 * isolated temp directory instead, so `bun test` never touches a real
 * operator's `~/.shadow` or `~/.claude`.
 *
 * Idempotent and cheap (one small Markdown file): called on every session
 * creation rather than once at install time, so an edit to the canonical
 * skill is picked up on Shadow's very next conversation without a separate
 * install step to remember.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SkillInstallError } from "./errors.ts";

const SKILL_NAME = "shadow-write-volumes";

// This file lives at packages/agent/src/skills.ts — two levels below the
// repo root, where `skills/` lives alongside `packages/` (mirrors
// packages/cli/src/commands/install.ts's REPO_ROOT resolution, adjusted for
// this file's shallower nesting: src -> agent -> packages -> root).
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, "..", "..", "..");

function sourceSkillPath(): string {
  return join(REPO_ROOT, "skills", SKILL_NAME, "SKILL.md");
}

export interface EnsureSkillInstalledResult {
  readonly skill: string;
  /** Absolute path the skill was written to. */
  readonly path: string;
}

/**
 * Copy the canonical `shadow-write-volumes` skill into
 * `<targetDir>/.claude/skills/shadow-write-volumes/SKILL.md`.
 *
 * @throws {SkillInstallError} if the canonical skill file cannot be read,
 *   or the destination cannot be written.
 */
export async function ensureWritingVolumesSkillInstalled(
  targetDir: string,
): Promise<EnsureSkillInstalledResult> {
  const destDir = join(targetDir, ".claude", "skills", SKILL_NAME);
  const destPath = join(destDir, "SKILL.md");

  let content: string;
  try {
    content = await readFile(sourceSkillPath(), "utf8");
  } catch (cause) {
    throw new SkillInstallError(SKILL_NAME, sourceSkillPath(), cause);
  }

  try {
    await mkdir(destDir, { recursive: true });
    await writeFile(destPath, content, "utf8");
  } catch (cause) {
    throw new SkillInstallError(SKILL_NAME, sourceSkillPath(), cause);
  }

  return { skill: SKILL_NAME, path: destPath };
}
