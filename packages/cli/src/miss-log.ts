/**
 * The miss log (D14): "every `not-in-corpus` verdict appended to
 * `misses.jsonl`" — the operator's authoring backlog, and how Shadow closes
 * its own loop instead of waiting to be asked what belief to distill next.
 *
 * `docs/INDEXING.md` places this alongside the corpus index rather than
 * inside a single volume (a miss is not about one volume, it's about the
 * whole corpus not having an answer), so it lives at `<root>/misses.jsonl`,
 * a sibling of `<root>/index.json` — the same root `context.ts` resolves,
 * kept out of `@shadow/core` because `VolumeStore` has no slot for a
 * cross-volume append log and core is not this package's to extend.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type MissReason = "no-match" | "empty-corpus" | "rounds-exhausted";

export interface MissEntry {
  readonly query: string;
  readonly reason: MissReason;
  readonly round?: number;
}

/** A logged miss, with the timestamp `appendMiss` stamped on write. */
export interface LoggedMiss extends MissEntry {
  readonly ts: string;
}

function missLogPath(root: string): string {
  return join(root, "misses.jsonl");
}

/** Append one miss as a JSON line. Creates `root` (and any missing parents) on first use. */
export async function appendMiss(root: string, entry: MissEntry): Promise<void> {
  await mkdir(root, { recursive: true });
  const logged: LoggedMiss = { ts: new Date().toISOString(), ...entry };
  await appendFile(missLogPath(root), `${JSON.stringify(logged)}\n`, "utf8");
}

/** Read every logged miss, oldest first. `[]` if the log does not exist yet. */
export async function readMisses(root: string): Promise<readonly LoggedMiss[]> {
  const file = Bun.file(missLogPath(root));
  if (!(await file.exists())) {
    return [];
  }
  const text = await readFile(missLogPath(root), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LoggedMiss);
}
