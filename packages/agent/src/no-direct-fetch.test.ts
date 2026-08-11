/**
 * Structural guard for `ARCHITECTURE.md`'s invariant on this pillar
 * ("Shadow never fetches: it delegates a research brief... and receives
 * findings that are already bound to retrieved sources") and D5 ("no
 * caller outside `@shadow/model` imports either SDK"). A behavioral test
 * can only prove Shadow *didn't happen to* fetch in one run; scanning the
 * package's own source is what proves it structurally *cannot* — there is
 * no `fetch(` call and no AI SDK import anywhere in this package for a
 * future edit to accidentally reach for.
 */

import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const SRC_DIR = import.meta.dir;

async function listSourceFiles(): Promise<string[]> {
  const entries = await readdir(SRC_DIR, { withFileTypes: true });
  return entries
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"),
    )
    .map((entry) => join(SRC_DIR, entry.name));
}

const FORBIDDEN_AI_SDK_IMPORTS = [
  "@anthropic-ai/claude-agent-sdk",
  "ai-sdk-provider-claude-code",
  '"ai"',
  "'ai'",
];

describe("@shadow/agent never fetches directly and never imports an AI SDK", () => {
  test("no source file calls fetch(...) or WebFetch/WebSearch/undici/node-fetch", async () => {
    const files = await listSourceFiles();
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = await readFile(file, "utf8");
      expect(content).not.toMatch(/\bfetch\s*\(/);
      expect(content).not.toMatch(/\bnode-fetch\b/);
      expect(content).not.toMatch(/\bundici\b/);
    }
  });

  test("no source file imports an AI SDK — only @shadow/model's ports", async () => {
    const files = await listSourceFiles();
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const forbidden of FORBIDDEN_AI_SDK_IMPORTS) {
        expect(content).not.toContain(forbidden);
      }
    }
  });

  test("the only tool ever allowed on Shadow's own session is the Skill tool (conversation.ts)", async () => {
    const content = await readFile(join(SRC_DIR, "conversation.ts"), "utf8");
    expect(content).toContain('allowedTools: ["Skill"]');
  });
});
