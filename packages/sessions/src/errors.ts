/**
 * Typed error hierarchy for @shadow/sessions, mirroring the convention
 * established in `@shadow/core`, `@shadow/evidence`, and `@shadow/agent`:
 * every failure mode a caller needs to branch on gets its own class with
 * structured fields, checked via `instanceof` rather than string-matching
 * `error.message`.
 */

/** Base class for every error this package throws. */
export abstract class ShadowSessionsError extends Error {
  abstract override readonly name: string;
}

/**
 * A session id failed the path-safety check at the layout boundary
 * (`layout.ts`) — e.g. it contains a path separator, a null byte, or is
 * `.`/`..`. Unlike `@shadow/core`'s `VolumeSlug`/`ChapterSlug`, session ids
 * are not a branded type here (the plan's `SessionStore` interface types
 * them as plain `string`, since they are minted by `@shadow/api`'s
 * `SessionService`, not authored by an operator or an LLM the way a slug
 * is) — so this check happens once, at the one place an id is ever joined
 * onto a filesystem path, the same defense-in-depth posture
 * `VolumeLayout`/`EvidenceLayout` document for their own identifiers.
 */
export class InvalidSessionIdError extends ShadowSessionsError {
  override readonly name = "InvalidSessionIdError";

  constructor(
    public readonly input: string,
    public readonly reason: string,
  ) {
    super(`Invalid session id ${JSON.stringify(input)}: ${reason}`);
  }
}

/** `get`'s soft-miss aside, every other `SessionStore` method that targets an existing session throws this when the id has no session on disk. */
export class SessionNotFoundError extends ShadowSessionsError {
  override readonly name = "SessionNotFoundError";

  constructor(public readonly id: string) {
    super(`Session not found: ${id}`);
  }
}

/** `create` targeted an id that already has a session on disk. */
export class SessionAlreadyExistsError extends ShadowSessionsError {
  override readonly name = "SessionAlreadyExistsError";

  constructor(public readonly id: string) {
    super(`Session already exists: ${id}`);
  }
}

/**
 * `readEvents` (directly, or via `append`'s internal read of the existing
 * log) hit a malformed line in `events.jsonl` that is **not** the last
 * line.
 *
 * Contrast with `@shadow/evidence`'s `LedgerCorruptError`, which fails
 * loudly on *any* malformed ledger line, torn tail or not: the evidence
 * ledger is meant to be hand-editable (D4), so a corrupt line there always
 * means a mistake worth surfacing immediately, with no automatic recovery.
 * `events.jsonl` is never hand-edited — every line is written by this
 * package alone — so the *only* way a line goes bad is a process crash
 * mid-write, and a crash can only ever tear the *last* line (nothing
 * appends into the middle of the file). `readEvents` therefore treats a
 * torn last line as an expected crash artifact and silently returns the
 * readable prefix (see `read-event-log.ts`'s `readEventLog`), but a corrupt
 * line anywhere else has no such explanation — it did not come from an
 * interrupted `append`, so something else touched the file, and this error
 * exists so that failure mode is never mistaken for the tolerated one.
 */
export class SessionEventsCorruptError extends ShadowSessionsError {
  override readonly name = "SessionEventsCorruptError";

  constructor(
    public readonly id: string,
    public readonly lineNumber: number,
    public readonly reason: string,
  ) {
    super(`events.jsonl corrupt for session ${id} at line ${lineNumber}: ${reason}`);
  }
}
