import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Asserts the shipped stylesheet produces exactly D10's token table — light
 * and dark — by reading the actual CSS file rather than a parallel TS copy
 * of the values, so there is one source of truth and no drift is possible
 * between "what D10 says" and "what test passes".
 */

const css = readFileSync(join(import.meta.dir, "theme.css"), "utf-8");

/** D10's token table (docs/DECISIONS.md), verbatim. */
const D10_LIGHT: Record<string, string> = {
  "--bg": "#fbfaf7",
  "--surface": "#ffffff",
  "--surface-sunken": "#f4f2ed",
  "--border": "#e6e2d9",
  "--text": "#1f2429",
  "--text-muted": "#6b7280",
  "--accent": "#7c9885",
  "--accent-soft": "#e8efe9",
  "--clay": "#c08a72",
  "--warn": "#c9a227",
  "--danger": "#b4685e",
};

const D10_DARK: Record<string, string> = {
  "--bg": "#14161a",
  "--surface": "#1b1e23",
  "--surface-sunken": "#101216",
  "--border": "#2a2e35",
  "--text": "#e8e6e1",
  "--text-muted": "#9aa0a8",
  "--accent": "#8fae97",
  "--accent-soft": "#232b26",
  "--clay": "#ce9a83",
  "--warn": "#d9b540",
  "--danger": "#c87c71",
};

/** Extracts the body of the first `{selectorLiteral} { ... }` block (flat, non-nested rules only). */
function extractBlock(source: string, selectorLiteral: string): string {
  const startOfSelector = source.indexOf(selectorLiteral);
  if (startOfSelector === -1) {
    throw new Error(`selector not found in theme.css: ${selectorLiteral}`);
  }
  const openBrace = source.indexOf("{", startOfSelector);
  const closeBrace = source.indexOf("}", openBrace);
  return source.slice(openBrace + 1, closeBrace);
}

function assertTokens(block: string, expected: Record<string, string>): void {
  for (const [token, hex] of Object.entries(expected)) {
    const pattern = new RegExp(`${token}:\\s*${hex}\\b`, "i");
    expect(block).toMatch(pattern);
  }
}

describe("D10 design tokens", () => {
  test("light theme (:root) matches D10's table", () => {
    const root = extractBlock(css, ":root {");
    assertTokens(root, D10_LIGHT);
  });

  test("dark theme, system default (prefers-color-scheme) matches D10's table", () => {
    const dark = extractBlock(css, ':root:not([data-theme="light"]) {');
    assertTokens(dark, D10_DARK);
  });

  test("dark theme, explicit toggle ([data-theme=dark]) matches D10's table", () => {
    const dark = extractBlock(css, ':root[data-theme="dark"] {');
    assertTokens(dark, D10_DARK);
  });

  test("radius is 6px, 8px on cards (D10 form)", () => {
    const root = extractBlock(css, ":root {");
    expect(root).toMatch(/--radius:\s*6px/);
    expect(root).toMatch(/--radius-card:\s*8px/);
  });

  test("spacing is on a 4px scale (D10 form)", () => {
    const root = extractBlock(css, ":root {");
    expect(root).toMatch(/--space-1:\s*4px/);
    expect(root).toMatch(/--space-2:\s*8px/);
    expect(root).toMatch(/--space-4:\s*16px/);
  });

  test("motion durations stay under 150ms (D10 form)", () => {
    const root = extractBlock(css, ":root {");
    const durations = [...root.matchAll(/--motion-[\w-]+:\s*(\d+)ms/g)].map((m) => Number(m[1]));
    expect(durations.length).toBeGreaterThan(0);
    for (const ms of durations) {
      expect(ms).toBeLessThan(150);
    }
  });

  test("prefers-reduced-motion is honoured", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)/);
    const reduced = extractBlock(
      css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)")),
      "{",
    );
    expect(reduced).toMatch(/animation-duration:\s*0\.001ms/);
    expect(reduced).toMatch(/transition-duration:\s*0\.001ms/);
  });

  test("chapter serif, UI sans, and identifier mono are three distinct stacks (D10 typography)", () => {
    const root = extractBlock(css, ":root {");
    const serif = /--font-serif:\s*([^;]+);/.exec(root)?.[1];
    const sans = /--font-sans:\s*([^;]+);/.exec(root)?.[1];
    const mono = /--font-mono:\s*([^;]+);/.exec(root)?.[1];
    expect(serif).toBeTruthy();
    expect(sans).toBeTruthy();
    expect(mono).toBeTruthy();
    expect(serif).not.toBe(sans);
    expect(sans).not.toBe(mono);
    expect(/serif/i.test(serif ?? "")).toBe(true);
    expect(/mono/i.test(mono ?? "")).toBe(true);
  });
});
