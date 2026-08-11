/**
 * Extracts `shadow <command> [--flag ...]` mentions out of a skill's
 * Markdown, for the T4.5 "would the skill actually fire" check: install the
 * skill into a temp repo, then confirm every command/flag it names is one
 * the real CLI accepts.
 *
 * `packages/cli/src/skill-drift.test.ts` (T3.2) already does an in-package
 * version of this against the *source* `skills/shadow-volumes/SKILL.md` by
 * driving `run()` in-process. This is deliberately not a reuse of that
 * file (`packages/cli` is off limits to modify, and importing its
 * internals would also violate this suite's own "argv in, JSON out"
 * subprocess-only rule for exercising the CLI) — it is a small, independent
 * re-implementation that instead drives the *installed copy* — the file
 * `shadow install` actually wrote into a fresh target repo — through real
 * subprocess invocations. Two independent implementations of the same
 * extraction logic agreeing is itself weak evidence the logic is right;
 * more importantly, this one proves the *installed artifact*, not just the
 * source file, is wired correctly end to end.
 */

export interface Mention {
  readonly command: string;
  readonly flags: readonly string[];
}

function lineToMention(line: string): Mention | undefined {
  const commandMatch = /shadow\s+([a-z][a-z-]*)/.exec(line);
  const command = commandMatch?.[1];
  if (!command) {
    return undefined;
  }
  const flags = [...line.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]);
  return { command, flags };
}

/** Every `shadow <command>` mention in `markdown`, with the `--flag`s on its own line/span, merged per command. Fenced blocks and inline `` `spans` `` are split separately so a flag never gets attributed to the wrong command. */
export function extractSkillMentions(markdown: string): ReadonlyMap<string, ReadonlySet<string>> {
  const fencePattern = /```[a-z]*\n([\s\S]*?)```/g;
  const fencedBlocks = [...markdown.matchAll(fencePattern)].map((m) => m[1] ?? "");
  const withoutFences = markdown.replace(fencePattern, "");
  const inlineSpans = [...withoutFences.matchAll(/`([^`\n]*)`/g)].map((m) => m[1] ?? "");

  const lines = [...fencedBlocks.flatMap((block) => block.split("\n")), ...inlineSpans];
  const merged = new Map<string, Set<string>>();
  for (const line of lines) {
    const mention = lineToMention(line);
    if (!mention) {
      continue;
    }
    const flags = merged.get(mention.command) ?? new Set<string>();
    for (const flag of mention.flags) {
      flags.add(flag);
    }
    merged.set(mention.command, flags);
  }
  return merged;
}
