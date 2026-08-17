/**
 * The tolerant `events.jsonl` reader shared by `FileSystemSessionStore`'s
 * `readEvents` (which only needs `records`) and `append` (which also needs
 * `cleanText` to self-heal a torn tail — see that method's doc). Split out
 * on its own so the crash-tolerance policy lives in exactly one place.
 */

import { SessionEventsCorruptError } from "./errors.ts";
import type { StoredEventRecord } from "./session-store.ts";

export interface EventLogReadResult {
  /** Every record successfully parsed, in file order (== `seq` order, since this store never reorders or renumbers). */
  readonly records: StoredEventRecord[];
  /**
   * The exact text `records` was parsed from: every valid line, each still
   * terminated by its own `"\n"`, with any torn trailing line dropped.
   * `""` if the file doesn't exist or has no valid lines yet. Appending to
   * *this* (never to the file's raw on-disk bytes) is what keeps a torn
   * tail from ever being written over — see `filesystem-session-store.ts`'s
   * `append`.
   */
  readonly cleanText: string;
}

/**
 * Read `path` as newline-delimited `StoredEventRecord` JSON, tolerating a
 * torn *last* line (an expected artifact of a process killed mid-`append`
 * — see `SessionEventsCorruptError`'s doc for the full contrast with
 * `@shadow/evidence`'s `LedgerCorruptError`) but failing loudly on a
 * malformed line anywhere else, since nothing but this package's own
 * `append` ever writes to `events.jsonl` and `append` never writes into
 * the middle of the file — a corrupt non-last line has no crash
 * explanation.
 *
 * @throws {SessionEventsCorruptError} if a line other than the last is malformed.
 */
export async function readEventLog(path: string, sessionId: string): Promise<EventLogReadResult> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { records: [], cleanText: "" };
  }

  const text = await file.text();
  let lines = text.split("\n");
  // A well-formed file (every line written by `append`, which always ends
  // a line with "\n") splits into one trailing "" — drop it so `lines`
  // holds exactly the file's logical lines, blank or not.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines = lines.slice(0, -1);
  }

  const records: StoredEventRecord[] = [];
  const validLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      // This store never writes a blank line; tolerate one defensively
      // (skip it) rather than choke on it, matching
      // `@shadow/evidence`'s `readLedger`.
      continue;
    }
    try {
      records.push(JSON.parse(trimmed) as StoredEventRecord);
      validLines.push(line);
    } catch (cause) {
      const isLastLine = i === lines.length - 1;
      if (isLastLine) {
        // Torn tail: an expected crash-mid-append artifact. Stop here —
        // everything parsed so far is the readable prefix.
        break;
      }
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new SessionEventsCorruptError(sessionId, i + 1, reason);
    }
  }

  const cleanText = validLines.length > 0 ? `${validLines.join("\n")}\n` : "";
  return { records, cleanText };
}
