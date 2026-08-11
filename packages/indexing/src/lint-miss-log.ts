/**
 * Check 5 — the miss log (D14): "every `not-in-corpus` verdict appended to
 * a miss log... the operator's authoring backlog — it says which belief
 * to distill next." Populated by the self-retrieval check (`lint-self-
 * retrieval.ts`) whenever one of its own probes comes back
 * `not-in-corpus`: even a task generated *from* a chapter's own
 * `when_to_use` found nothing, which is a stronger signal than merely
 * failing to retrieve itself.
 *
 * **Where this lives on disk.** `docs/INDEXING.md` names the file
 * (`misses.jsonl`) but not its location, and nothing in `@shadow/core`'s
 * `VolumeStore` exposes a path for it — `writeIndex`/`writeCorpusIndex`
 * are the only writable slots it offers, both already spoken for by
 * `index.json` (`ARCHITECTURE.md`: "the filesystem layout is an
 * implementation detail of `@shadow/core`. No other package builds a
 * path.") Adding a slot for this is `@shadow/core` surface, out of this
 * task's boundary (`packages/core` is complete; this task only owns
 * `packages/indexing`). So the miss log is a port (`MissLogStore`) like
 * `@shadow/evidence`'s `EvidenceLookup` — this package depends on the
 * interface, never a hardcoded path. `FileMissLog` below is a minimal,
 * self-contained NDJSON implementation over an **explicit path the
 * caller supplies** (a test's tmpdir today; T3.1's CLI, when it wires the
 * real `shadow lint` command, is who should decide the real on-disk
 * location — e.g. beside the corpus `index.json` — since only it composes
 * `@shadow/core`'s root path with anything). `InMemoryMissLog` is the
 * default for tests and for any caller that doesn't want persistence.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface MissLogEntry {
  /** The probe task that came back `not-in-corpus`. */
  readonly task: string;
  /** The chapter self-retrieval generated `task` for, if this entry came from check 2 (always true in practice — nothing else in this package writes here, but the field stays optional so a future caller logging a real `shadow find` miss isn't forced to invent a chapter). */
  readonly sourceChapterId?: string;
  /** ISO 8601, when the verdict was recorded. */
  readonly recordedAt: string;
}

/** Append-only sink for `not-in-corpus` verdicts. `append` never overwrites or reorders prior entries — "append-only, survives repeated runs" (the brief's own words). */
export interface MissLogStore {
  append(entry: MissLogEntry): Promise<void>;
  readAll(): Promise<readonly MissLogEntry[]>;
}

/** In-memory `MissLogStore` — the default for tests, and for any caller that has nowhere durable to put one. Never touches the filesystem. */
export class InMemoryMissLog implements MissLogStore {
  private readonly entries: MissLogEntry[] = [];

  async append(entry: MissLogEntry): Promise<void> {
    this.entries.push(entry);
  }

  async readAll(): Promise<readonly MissLogEntry[]> {
    return [...this.entries];
  }
}

/**
 * NDJSON-on-disk `MissLogStore`, one JSON object per line, over a caller-
 * supplied absolute path — see this module's doc comment for why the path
 * is the caller's to choose rather than something this package derives.
 * Appends are real `O_APPEND` writes (`node:fs/promises`'s `appendFile`),
 * so concurrent lint runs cannot truncate each other's entries the way a
 * read-modify-write-whole-file approach could.
 */
export class FileMissLog implements MissLogStore {
  constructor(private readonly path: string) {}

  async append(entry: MissLogEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, "utf8");
  }

  async readAll(): Promise<readonly MissLogEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as MissLogEntry);
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
