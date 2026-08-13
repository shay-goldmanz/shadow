/**
 * `shadow install [--target <dir>] [--force]` — places the `shadow-find`
 * consumer skill (D3: "Ship a `shadow` binary plus a `SKILL.md` that `shadow
 * install` drops into a target repo's `.claude/skills/`") into a target
 * repo, so a coding agent working there discovers it and reaches for
 * `shadow` unprompted (`docs/ACCEPTANCE.md`: "Agent invokes the CLI without
 * being explicitly asked to").
 *
 * The skill's source of truth is the top-level `skills/` directory of this
 * monorepo (`docs/PLAN.md` T3.2), not a string embedded here — this command
 * copies it verbatim rather than duplicating its content in TypeScript,
 * which would drift the moment one of the two was edited and not the other.
 * Resolved relative to `import.meta.url` rather than `process.cwd()`,
 * matching D7 (no build step: the source tree *is* what runs) — this file
 * always knows where its own repo root is, regardless of where `shadow` is
 * invoked from.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SkillAlreadyInstalledError } from "../errors.ts";

const SKILL_NAME = "shadow-find";

// This file lives at packages/cli/src/commands/install.ts — four levels
// below the repo root, where `skills/` lives alongside `packages/`.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, "..", "..", "..", "..");

function sourceSkillPath(): string {
  return join(REPO_ROOT, "skills", SKILL_NAME, "SKILL.md");
}

export interface InstallOptions {
  /** Repo to install into. Defaults to the current working directory. */
  readonly target?: string;
  /** Overwrite an existing skill file at the destination. Defaults to `false`. */
  readonly force?: boolean;
}

export interface InstallResult {
  readonly skill: string;
  readonly written: string;
  readonly target: string;
  readonly next_steps: readonly string[];
}

async function fileExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

export async function runInstall(options: InstallOptions): Promise<InstallResult> {
  const targetRoot = resolve(options.target ?? process.cwd());
  const destDir = join(targetRoot, ".claude", "skills", SKILL_NAME);
  const destPath = join(destDir, "SKILL.md");

  if (!options.force && (await fileExists(destPath))) {
    throw new SkillAlreadyInstalledError(destPath);
  }

  const content = await readFile(sourceSkillPath(), "utf8");
  await mkdir(destDir, { recursive: true });
  await writeFile(destPath, content, "utf8");

  return {
    skill: SKILL_NAME,
    written: destPath,
    target: targetRoot,
    next_steps: [
      `Installed the ${SKILL_NAME} skill at ${destPath}.`,
      'A coding agent working in this repo now loads it automatically and should reach for `shadow find "<task>"` unprompted on tasks the operator may have opinions about.',
      "Run `shadow index` (and `shadow volumes`) here to confirm a corpus actually exists for it to find.",
    ],
  };
}
