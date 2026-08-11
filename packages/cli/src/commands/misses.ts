/**
 * `shadow misses` — read the operator's authoring backlog back (D14). The
 * miss log exists to be read (T2.7): `shadow find`'s `not-in-corpus`
 * verdicts and `shadow lint`'s self-retrieval failures now share one
 * `FileMissLog` (`../miss-log.ts`), so this command is the one place both
 * writers' entries surface together, oldest first, exactly as persisted.
 */

import { createMissLog, isFindMiss, type ShadowMissEntry, widenMisses } from "../miss-log.ts";

export interface MissesResult {
  readonly misses: readonly ShadowMissEntry[];
  readonly count: number;
  readonly next_steps: readonly string[];
}

function nextSteps(misses: readonly ShadowMissEntry[]): readonly string[] {
  if (misses.length === 0) {
    return [
      "No misses logged yet — every `shadow find` and `shadow lint` run so far found an answer.",
      'Nothing to do here; `shadow find "<task>"` is still the way to check a specific task.',
    ];
  }
  const liveMiss = misses.find(isFindMiss);
  const highlighted = liveMiss ?? misses[0];
  return [
    highlighted
      ? `Write a chapter answering "${highlighted.task}" (or another entry below), then run \`shadow index\` to pick it up.`
      : "Write a chapter answering one of the entries below, then run `shadow index` to pick it up.",
    "Each entry's `source` says whether an agent hit this live (`find`) or a chapter failed to retrieve itself (`lint`) — `find` misses are real usage and worth prioritizing over `lint` misses.",
  ];
}

/** Read every entry the shared miss log has recorded, oldest first. */
export async function runMisses(root: string): Promise<MissesResult> {
  const raw = await createMissLog(root).readAll();
  const misses = widenMisses(raw);
  return { misses, count: misses.length, next_steps: nextSteps(misses) };
}
