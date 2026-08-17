/**
 * Typed error hierarchy for @shadow/api itself — distinct from the typed
 * errors the pillars beneath it throw (`@shadow/core`, `@shadow/evidence`,
 * `@shadow/indexing`, `@shadow/agent`, `@shadow/model`, `@shadow/research`).
 * This package's own errors exist only for things that are genuinely a
 * transport concern: a malformed request body, an unresolvable route, a
 * chat `sessionId` the server no longer holds. Everything else is a pillar
 * error passed through `error-mapping.ts`.
 *
 * `instanceof` is the supported way to branch on these, matching the
 * convention every other package in this monorepo already uses.
 */

/** Base class for every error `@shadow/api` itself originates (not a pillar's). */
export abstract class ShadowApiError extends Error {
  abstract override readonly name: string;
  /** HTTP status this error maps to. */
  abstract readonly status: number;
  /** Stable machine-readable code, `docs/API.md`'s `error.code`. */
  abstract readonly code: string;
}

/**
 * The request body or query string was malformed or missing a required
 * field — operator/client error, never a server fault. Distinct from a
 * pillar's own validation errors (e.g. `InvalidSlugError`), which are
 * mapped separately in `error-mapping.ts`; this is for shape-level
 * problems a pillar never gets the chance to see (missing `message`,
 * invalid JSON, missing `title`, etc).
 */
export class InvalidRequestError extends ShadowApiError {
  override readonly name = "InvalidRequestError";
  readonly status = 400;
  readonly code = "invalid_request";

  constructor(
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** No route matches this method + path. */
export class RouteNotFoundError extends ShadowApiError {
  override readonly name = "RouteNotFoundError";
  readonly status = 404;
  readonly code = "route_not_found";

  constructor(
    public readonly method: string,
    public readonly path: string,
  ) {
    super(`No route for ${method} ${path}`);
  }
}

/**
 * `POST /api/chat` was called with a `sessionId` this server has no
 * `ShadowConversation` for — either it was never issued by this process, or
 * the process restarted (conversations are held in memory; D4's
 * filesystem-is-truth invariant is about volumes, not in-flight chat
 * sessions). Operator-visible, not a fault: the client should start a new
 * conversation.
 */
export class SessionNotFoundError extends ShadowApiError {
  override readonly name = "SessionNotFoundError";
  readonly status = 404;
  readonly code = "session_not_found";

  constructor(public readonly sessionId: string) {
    super(`No conversation with sessionId ${JSON.stringify(sessionId)}`);
  }
}

/**
 * `SessionService.enqueueTurn` (T2.5) was called for a session that already
 * has the maximum number of turns (`SessionLock`'s bound, `session-lock.ts`)
 * queued behind the one currently running. Operator-visible, not a fault:
 * PLAN.md's Tier 2 concurrency model calls this out by name — "queue bound:
 * 4 pending; beyond that `409 turn_queue_busy`" — as an expected outcome of
 * multiple tabs racing one session, not a server error. The client should
 * back off and retry, or simply wait for its own in-flight turn to finish
 * before sending another (today's UI already disables input while its own
 * turn streams, so this is reachable only from a second tab or a client
 * that doesn't honor that).
 */
export class TurnQueueBusyError extends ShadowApiError {
  override readonly name = "TurnQueueBusyError";
  readonly status = 409;
  readonly code = "turn_queue_busy";

  constructor(public readonly sessionId: string) {
    super(`Too many turns already queued for session ${JSON.stringify(sessionId)}`);
  }
}

/**
 * `SessionService.enqueueTurn` (T2.9) was called after `shutdown()` had
 * already begun — the server is winding down and is no longer accepting new
 * turns (PLAN.md's T2.9 entry: "stop accepting turns (`503` on enqueue)").
 * Operator-visible, not a fault: the client should retry once the server has
 * restarted. Reused, not reimplemented, by T3.1's error-mapping table — this
 * is the "shutdown 503" row that block names; there is nothing further for
 * `error-mapping.ts` to add, same as `TurnQueueBusyError`/`SessionNotFoundError`
 * above (`session-service.ts`'s `enqueueTurn` doc: the generic
 * `error instanceof ShadowApiError` branch already maps a subclass's own
 * `status`/`code` fields).
 */
export class ServiceShuttingDownError extends ShadowApiError {
  override readonly name = "ServiceShuttingDownError";
  readonly status = 503;
  readonly code = "shutting_down";

  constructor() {
    super("Server is shutting down; not accepting new turns");
  }
}

/**
 * `SessionService.deleteSession` (T3.1) was called for a session that
 * currently has a turn running or queued (`SessionLock.hasActivity`).
 * Operator-visible, not a fault: PLAN.md's failure table calls this out by
 * name — "Delete while turn running/queued -> 409; delete after it
 * settles." The client should wait for the in-flight turn to finish (or
 * poll `GET /api/sessions/:id/events`) and retry the delete.
 */
export class SessionBusyError extends ShadowApiError {
  override readonly name = "SessionBusyError";
  readonly status = 409;
  readonly code = "session_busy";

  constructor(public readonly sessionId: string) {
    super(
      `Session ${JSON.stringify(sessionId)} has a turn running or queued; delete once it settles`,
    );
  }
}

/**
 * `SessionService.deleteSession` (F1 review fix, T3.1) removed the store
 * row, the registry entry, and published the "ended" bus signal
 * successfully, but at least one of this session's underlying SDK
 * transcripts failed to delete for a reason OTHER than "it was already
 * gone" (`@shadow/model`'s `deleteStoredSession` tolerates that specific
 * case silently — it never reaches here; see that method's doc). Genuine
 * fault, 5xx: the delete itself is NOT reversible or retryable the way a
 * `409 session_busy` is — the store row really is gone, so a retried
 * `DELETE` on the same id now just 404s. Surfaced anyway (rather than
 * swallowed) because an orphaned transcript is exactly the "undeletable
 * forever" shape this whole review fix exists to prevent recurring in a new
 * form — an operator/log consumer that sees this knows there is disk
 * cleanup to investigate, even though the session itself is gone from every
 * list.
 */
export class SessionTranscriptDeletionError extends ShadowApiError {
  override readonly name = "SessionTranscriptDeletionError";
  readonly status = 500;
  readonly code = "session_transcript_deletion_failed";

  constructor(
    public readonly sessionId: string,
    public readonly failedSdkSessionIds: readonly string[],
  ) {
    super(
      `Session ${JSON.stringify(sessionId)} was deleted, but ${failedSdkSessionIds.length} of ` +
        `its SDK transcript(s) could not be removed and may be orphaned: ` +
        `${failedSdkSessionIds.join(", ")}`,
    );
  }
}

/**
 * `GET /api/volumes/:slug/index` (or `/api/lint`) was called before the
 * volume was ever indexed — `VolumeStore.readIndex`/`readCorpusIndex`
 * returned `undefined`. Not a fault: `POST /api/volumes/:slug/reindex`
 * (or publishing a chapter, which reindexes as a side effect) builds it.
 */
export class IndexNotBuiltError extends ShadowApiError {
  override readonly name = "IndexNotBuiltError";
  readonly status = 404;
  readonly code = "index_not_built";

  constructor(public readonly volume: string) {
    super(`Volume ${JSON.stringify(volume)} has not been indexed yet`);
  }
}
