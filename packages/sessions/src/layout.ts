/**
 * Owns the on-disk layout described in T2.1:
 *
 * ```
 * <root>/
 *   sessions/<session-id>/
 *     meta.json
 *     events.jsonl
 * ```
 *
 * This is the *only* place in the package that joins a session id onto a
 * path — `FileSystemSessionStore` is the only consumer, mirroring
 * `@shadow/core`'s `VolumeLayout` (see that file's module doc for the
 * fuller rationale) and `@shadow/evidence`'s `EvidenceLayout`.
 *
 * Session ids are plain `string` in the `SessionStore` port (not a branded
 * type like `VolumeSlug`/`ChapterSlug` — see `errors.ts`'s
 * `InvalidSessionIdError` doc for why), so there is no compile-time brand
 * to defeat in the first place; the check below is the *only* line of
 * defense between an id and the filesystem, which is exactly why it lives
 * at the path-building boundary rather than being trusted from callers.
 */

import { join } from "node:path";
import { InvalidSessionIdError } from "./errors.ts";

/**
 * Reject anything that could escape `sessions/` when joined onto a path:
 * empty, a path separator, `.`/`..`, or a null byte. Deliberately more
 * permissive than `@shadow/core`'s slug charset (lowercase-alnum-hyphen
 * only) — session ids are opaque identifiers minted by `@shadow/api`
 * (a ULID or similar), not operator-authored titles, so there's no reason
 * to fold a title-slugging charset onto them; only actual path-traversal
 * shapes are rejected.
 *
 * @throws {InvalidSessionIdError} if `id` fails the check.
 */
function assertSafeSessionId(id: string): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new InvalidSessionIdError(id, "must be a non-empty string");
  }
  if (id.includes("\0")) {
    throw new InvalidSessionIdError(id, "must not contain a null byte");
  }
  if (id.includes("/") || id.includes("\\")) {
    throw new InvalidSessionIdError(id, "must not contain a path separator");
  }
  if (id === "." || id === "..") {
    throw new InvalidSessionIdError(id, 'must not be "." or ".."');
  }
}

export class SessionsLayout {
  constructor(private readonly root: string) {}

  sessionsDir(): string {
    return join(this.root, "sessions");
  }

  /** @throws {InvalidSessionIdError} if `id` fails the path-safety check. */
  sessionDir(id: string): string {
    assertSafeSessionId(id);
    return join(this.sessionsDir(), id);
  }

  /** @throws {InvalidSessionIdError} if `id` fails the path-safety check. */
  metaPath(id: string): string {
    return join(this.sessionDir(id), "meta.json");
  }

  /** @throws {InvalidSessionIdError} if `id` fails the path-safety check. */
  eventsPath(id: string): string {
    return join(this.sessionDir(id), "events.jsonl");
  }
}
