/**
 * Output rendering — kept separate from argument parsing (`cli.ts`) and
 * command orchestration (`commands/*.ts`) so the three are independently
 * testable (SOLID: single responsibility per module).
 *
 * Output rule: **compact single-line JSON on stdout by default** — the
 * consumer is a language model with a token budget, not a human scanning a
 * terminal (D12). `--json` (documented on `find`, applied uniformly here so
 * every command behaves the same way) switches to pretty-printed JSON for a
 * human debugging by eye; it does not change *what* is emitted, only its
 * whitespace.
 */

import type { ShadowCliError } from "./errors.ts";

export interface RenderOptions {
  readonly pretty: boolean;
}

function toJson(value: unknown, pretty: boolean): string {
  return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

/** A successful command's result, terminated by a trailing newline (stdout). */
export function renderSuccess(value: unknown, options: RenderOptions): string {
  return `${toJson(value, options.pretty)}\n`;
}

/** An error's envelope (`error` + `next_steps`), terminated by a trailing newline (stderr). */
export function renderError(error: ShadowCliError, options: RenderOptions): string {
  return `${toJson(error.toEnvelope(), options.pretty)}\n`;
}
