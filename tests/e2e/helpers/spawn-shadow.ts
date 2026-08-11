/**
 * Spawns the real `shadow` executable (`packages/cli/src/bin.ts`, honored
 * via its shebang, not `bun run`) as a subprocess — argv in, stdout/stderr
 * JSON out — exactly the contract a foreign coding agent gets when it shells
 * out to `shadow`. Mirrors `packages/cli/src/bin.e2e.test.ts`'s own
 * `spawnShadow` helper, relocated here because this suite may not import
 * anything from `packages/cli` (it is off limits to modify, and driving it
 * in-process would defeat the point of an e2e test over the real contract).
 *
 * Nothing in this file imports `packages/cli/src/*` — only its compiled
 * entry point is invoked, as a path, the same way an operator's `$PATH`
 * would resolve `shadow` after `bun link` or a global install.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HELPERS_DIR = dirname(fileURLToPath(import.meta.url));
export const BIN_PATH = join(HELPERS_DIR, "..", "..", "..", "packages", "cli", "src", "bin.ts");

export interface ShadowInvocation {
  readonly argv: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Spawn `shadow <args>` with `SHADOW_HOME` pointed at `root` (D4's
 * `--target`-independent isolation knob; see `packages/cli/src/context.ts`).
 * Returns raw stdout/stderr/exitCode — parsing is the caller's job, exactly
 * as it would be an agent's.
 */
export async function spawnShadow(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<ShadowInvocation> {
  const proc = Bun.spawn([BIN_PATH, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { argv: args, stdout, stderr, exitCode };
}

/** Parse a successful invocation's compact-JSON stdout. Throws if stdout isn't JSON — a real agent's parser would fail the same way. */
export function parseStdout<T = unknown>(invocation: ShadowInvocation): T {
  return JSON.parse(invocation.stdout) as T;
}

/** Parse a failed invocation's `{ error, next_steps }` envelope from stderr (D12). */
export function parseStderr<T = unknown>(
  invocation: ShadowInvocation,
): T & { error: { name: string; message: string }; next_steps: readonly string[] } {
  return JSON.parse(invocation.stderr) as T & {
    error: { name: string; message: string };
    next_steps: readonly string[];
  };
}
