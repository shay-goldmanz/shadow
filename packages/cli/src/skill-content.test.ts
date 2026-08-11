/**
 * Validates the two skills that live in the top-level `skills/` directory
 * (`docs/PLAN.md` T3.2): `writing-volumes` (guides Shadow while authoring
 * chapters) and `shadow-volumes` (the consumer skill `shadow install`
 * ships into other repos). Lives here, in `@shadow/cli`, because this
 * package is what has Bun's native YAML parser and a test runner wired up
 * — `skills/` itself is plain Markdown with no build tooling of its own.
 *
 * Two properties matter enough to assert directly:
 * 1. Both files are valid `SKILL.md`s — YAML frontmatter + Markdown body —
 *    carrying at least `name` and `description`, per Claude Code's skill
 *    format.
 * 2. `shadow-volumes`'s `description` is what makes unprompted invocation
 *    happen at all (D3) — it must actually describe *when* to reach for the
 *    skill, not just what it is.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

interface ParsedSkill {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

async function parseSkill(name: string): Promise<ParsedSkill> {
  const raw = await readFile(join(REPO_ROOT, "skills", name, "SKILL.md"), "utf8");
  const match = FRONTMATTER_PATTERN.exec(raw);
  if (!match) {
    throw new Error(`${name}/SKILL.md is missing a --- delimited YAML frontmatter block`);
  }
  const [, yamlSource, body] = match;
  const parsed = Bun.YAML.parse(yamlSource ?? "");
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${name}/SKILL.md frontmatter did not parse to a mapping`);
  }
  return { frontmatter: parsed as Record<string, unknown>, body: body ?? "" };
}

describe.each([["writing-volumes"], ["shadow-volumes"]])("skills/%s/SKILL.md", (name) => {
  test("parses as valid YAML frontmatter + Markdown body", async () => {
    const skill = await parseSkill(name);
    expect(typeof skill.frontmatter).toBe("object");
    expect(skill.body.length).toBeGreaterThan(0);
  });

  test("carries required `name` and `description` fields", async () => {
    const { frontmatter } = await parseSkill(name);
    expect(typeof frontmatter.name).toBe("string");
    expect((frontmatter.name as string).length).toBeGreaterThan(0);
    expect(typeof frontmatter.description).toBe("string");
    expect((frontmatter.description as string).length).toBeGreaterThan(0);
  });

  test("`name` matches its directory", async () => {
    const { frontmatter } = await parseSkill(name);
    expect(frontmatter.name).toBe(name);
  });
});

describe("writing-volumes content", () => {
  test("teaches the frontmatter contract: when_to_use is about applicability, not summary", async () => {
    const { body } = await parseSkill("writing-volumes");
    expect(body).toContain("when_to_use");
    expect(body).toContain("not_for");
    expect(body.toLowerCase()).toContain("0.85");
  });

  test("teaches claim marking: sourced/derived/operator footnote syntax", async () => {
    const { body } = await parseSkill("writing-volumes");
    expect(body).toContain("[^label]");
    expect(body).toContain("[^=label]");
    expect(body).toContain("[^~label]");
  });

  test("states plainly that the writer does not decide what needs evidence", async () => {
    const { body } = await parseSkill("writing-volumes");
    expect(body.toLowerCase()).toContain("you do not decide");
  });

  test("warns against citation padding, citing the extractiveness guardrail", async () => {
    const { body } = await parseSkill("writing-volumes");
    expect(body).toContain("−0.96");
  });
});

describe("shadow-volumes content", () => {
  test("description drives unprompted invocation: mentions reaching for it before improvising", async () => {
    const { frontmatter } = await parseSkill("shadow-volumes");
    const description = (frontmatter.description as string).toLowerCase();
    expect(description).toContain("before");
    expect(description).toMatch(/design|writing|architecture|process/);
  });

  test("teaches reading next_steps rather than guessing the next command", async () => {
    const { body } = await parseSkill("shadow-volumes");
    expect(body).toContain("next_steps");
  });

  test("documents all four find stages", async () => {
    const { body } = await parseSkill("shadow-volumes");
    for (const stage of ["route", "navigate", "promoted", "verdict"]) {
      expect(body).toContain(stage);
    }
  });

  test("flags `promoted` as a weak signal to verify before trusting", async () => {
    const { body } = await parseSkill("shadow-volumes");
    expect(body.toLowerCase()).toContain("weak");
  });

  test("flags not-in-corpus verdicts as final for that query", async () => {
    const { body } = await parseSkill("shadow-volumes");
    expect(body).toContain("not-in-corpus");
    expect(body.toLowerCase()).toContain("final");
  });

  test("names grep and chapters --rank as escape hatches, not the default path", async () => {
    const { body } = await parseSkill("shadow-volumes");
    expect(body).toContain("shadow grep");
    expect(body).toContain("--rank");
    expect(body.toLowerCase()).toContain("escape hatch");
  });
});
