/**
 * The drift guardrail (T3.2): every `shadow <command>` and `--flag` the
 * `shadow-find` consumer skill tells an agent to run must actually exist
 * on the real CLI. Without this, the skill and `cli.ts` can silently drift
 * apart — someone renames a flag in `cli.ts`, the skill still tells agents
 * to pass the old one, and nothing catches it until an agent hits a real
 * parse error in the field.
 *
 * This does not hardcode a second copy of "the flags that exist" — it
 * extracts every `shadow ...` mention from the skill's own Markdown and
 * drives it through the *real* `run()` dispatch (`cli.ts`), the same
 * function `bin.ts` calls. A command name the switch in `cli.ts` doesn't
 * recognize surfaces as `UsageError: unknown command "..."`; a flag
 * `parseArgs` (`strict: true`) doesn't recognize surfaces as an "Unknown
 * option" failure. Neither of those is treated as a legitimate outcome
 * below — every other failure (missing positional, no index built, bad
 * node_id, ...) is, because it proves the command/flag were *recognized*
 * and dispatch got past parsing.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./cli.ts";
import { withStore } from "./test-fixture.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKILL_PATH = join(REPO_ROOT, "skills", "shadow-find", "SKILL.md");

interface Mention {
  readonly command: string;
  readonly flags: readonly string[];
}

/** One text line -> at most one mention: the first `shadow <word>` on it, plus every `--flag` on that same line. */
function lineToMention(line: string): Mention | undefined {
  const commandMatch = /shadow\s+([a-z][a-z-]*)/.exec(line);
  const command = commandMatch?.[1];
  if (!command) {
    return undefined;
  }
  const flags = [...line.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]);
  return { command, flags };
}

/**
 * Every `shadow <command>` mention, with the `--flag` tokens it carries.
 * Fenced code blocks (the quick-reference table, one command per line, no
 * per-line backticks) and inline single-backtick spans (individually
 * delimited per mention everywhere else in the skill) need different
 * splitting so a flag on one line/span is never attributed to a different
 * command that happens to share the block.
 */
function extractMentions(markdown: string): readonly Mention[] {
  const fencePattern = /```[a-z]*\n([\s\S]*?)```/g;
  const fencedBlocks = [...markdown.matchAll(fencePattern)].map((m) => m[1] ?? "");
  const withoutFences = markdown.replace(fencePattern, "");
  const inlineSpans = [...withoutFences.matchAll(/`([^`\n]*)`/g)].map((m) => m[1] ?? "");

  const fromFences = fencedBlocks.flatMap((block) => block.split("\n"));
  const mentions = [...fromFences, ...inlineSpans]
    .map(lineToMention)
    .filter((m): m is Mention => m !== undefined);
  return mentions;
}

/** Merge mentions of the same command into one flag set, so each command/flag pair is tested once. */
function mergeMentions(mentions: readonly Mention[]): ReadonlyMap<string, ReadonlySet<string>> {
  const merged = new Map<string, Set<string>>();
  for (const mention of mentions) {
    const flags = merged.get(mention.command) ?? new Set<string>();
    for (const flag of mention.flags) {
      flags.add(flag);
    }
    merged.set(mention.command, flags);
  }
  return merged;
}

/** A positional argument that satisfies each command's required `<...>` argument, so parsing gets past the "missing argument" check and flag recognition is what's actually being probed. */
const POSITIONAL: Readonly<Record<string, readonly string[]>> = {
  volumes: [],
  chapters: ["some-volume-id"],
  find: ["some task"],
  read: ["some-node-id"],
  grep: ["some terms"],
  index: [],
};

function isUnknownCommand(stderrText: string): boolean {
  if (!stderrText) {
    return false;
  }
  const parsed = JSON.parse(stderrText) as { error?: { name?: string; message?: string } };
  return (
    parsed.error?.name === "UsageError" && (parsed.error.message ?? "").includes("unknown command")
  );
}

function isUnknownOption(stderrText: string): boolean {
  if (!stderrText) {
    return false;
  }
  const parsed = JSON.parse(stderrText) as { error?: { name?: string; message?: string } };
  return (
    parsed.error?.name === "UnexpectedCliError" &&
    (parsed.error.message ?? "").includes("Unknown option")
  );
}

async function invoke(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  let result = { stdout: "", stderr: "" };
  await withStore(async (store, root) => {
    let stdout = "";
    let stderr = "";
    await run(args, {
      store,
      root,
      write: (chunk) => {
        stdout += chunk;
      },
      writeErr: (chunk) => {
        stderr += chunk;
      },
    });
    result = { stdout, stderr };
  });
  return result;
}

describe("shadow-find skill vs. the real CLI (drift guardrail)", () => {
  test("the skill mentions at least one command and one flag — a sanity check on extraction itself", async () => {
    const markdown = await readFile(SKILL_PATH, "utf8");
    const merged = mergeMentions(extractMentions(markdown));
    expect(merged.size).toBeGreaterThan(0);
    const totalFlags = [...merged.values()].reduce((sum, flags) => sum + flags.size, 0);
    expect(totalFlags).toBeGreaterThan(0);
  });

  test("every mentioned `shadow <command>` is a command the real CLI recognizes", async () => {
    const markdown = await readFile(SKILL_PATH, "utf8");
    const merged = mergeMentions(extractMentions(markdown));

    for (const command of merged.keys()) {
      const positionals = POSITIONAL[command] ?? [];
      const { stderr } = await invoke([command, ...positionals]);
      expect(isUnknownCommand(stderr)).toBe(false);
    }
  });

  test("every mentioned `--flag` is a flag the real CLI's parseArgs recognizes for that command", async () => {
    const markdown = await readFile(SKILL_PATH, "utf8");
    const merged = mergeMentions(extractMentions(markdown));

    for (const [command, flags] of merged) {
      const positionals = POSITIONAL[command];
      if (positionals === undefined) {
        // A command mentioned in the skill that this test doesn't know the
        // calling convention for yet — fail loudly rather than silently
        // skipping it, so a new command mention forces this test to be
        // extended rather than quietly passing.
        throw new Error(
          `skill mentions "shadow ${command}" but skill-drift.test.ts has no POSITIONAL entry for it`,
        );
      }
      for (const flag of flags) {
        const { stderr } = await invoke([command, ...positionals, flag]);
        expect({ command, flag, unknownOption: isUnknownOption(stderr) }).toEqual({
          command,
          flag,
          unknownOption: false,
        });
      }
    }
  });

  test("`--json` (claimed generically for every command) is recognized on every mentioned command", async () => {
    const markdown = await readFile(SKILL_PATH, "utf8");
    const merged = mergeMentions(extractMentions(markdown));
    expect(markdown).toContain("--json");

    for (const command of merged.keys()) {
      const positionals = POSITIONAL[command] ?? [];
      const { stderr } = await invoke([command, ...positionals, "--json"]);
      expect(isUnknownOption(stderr)).toBe(false);
    }
  });
});
