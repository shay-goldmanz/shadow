/**
 * Typed error hierarchy for @shadow/rulebook, matching the convention
 * established in `@shadow/core` and `@shadow/evidence`: `instanceof` checks
 * against structured fields, never string-matching `error.message`.
 */

/** Base class for every error this package throws. */
export abstract class ShadowRulebookError extends Error {
  abstract override readonly name: string;
}

/** `ingestDocument`'s target path does not exist (or is not a regular, readable file). */
export class DocumentNotFoundError extends ShadowRulebookError {
  override readonly name = "DocumentNotFoundError";

  constructor(
    public readonly path: string,
    cause?: unknown,
  ) {
    super(`Document not found: ${path}`, { cause });
  }
}

/** `ingestDocument`'s target file exceeds the ingestion size cap. */
export class DocumentTooLargeError extends ShadowRulebookError {
  override readonly name = "DocumentTooLargeError";

  constructor(
    public readonly path: string,
    public readonly sizeBytes: number,
    public readonly maxBytes: number,
  ) {
    super(`Document too large: ${path} (${sizeBytes} bytes, max ${maxBytes} bytes)`);
  }
}

/** `ingestDocument`'s target file has an extension outside `.md`/`.markdown`/`.txt`/`.pdf`. */
export class DocumentUnsupportedError extends ShadowRulebookError {
  override readonly name = "DocumentUnsupportedError";

  constructor(
    public readonly path: string,
    public readonly extension: string,
  ) {
    super(`Unsupported document extension ${JSON.stringify(extension)}: ${path}`);
  }
}

/**
 * A `.md`/`.markdown`/`.txt` file's bytes are not valid UTF-8. Ingestion is
 * Markdown/plain-text only (deliberately narrow — PDF→Markdown
 * conversion happens outside this feature), so this is the only decode
 * failure mode.
 */
export class DocumentDecodeError extends ShadowRulebookError {
  override readonly name = "DocumentDecodeError";

  constructor(
    public readonly path: string,
    public readonly reason: string,
    cause?: unknown,
  ) {
    super(`Failed to decode document ${path}: ${reason}`, { cause });
  }
}

/**
 * `publishGroup` was called for a group that has never been assembled
 * — no claim sidecar exists yet. Mirrors `@shadow/agent`'s
 * `ChapterHasNoClaimsError`, duplicated rather than imported since this
 * package does not depend on `@shadow/agent`: rule books are their own
 * deliverable, wired into the chat/agent package only by a directive that
 * consumes this package from the outside.
 */
export class GroupHasNoClaimsError extends ShadowRulebookError {
  override readonly name = "GroupHasNoClaimsError";

  constructor(
    public readonly rulebookSlug: string,
    public readonly groupSlug: string,
  ) {
    super(
      `Group "${groupSlug}" in rule book "${rulebookSlug}" has no claim sidecar — assemble it first`,
    );
  }
}
