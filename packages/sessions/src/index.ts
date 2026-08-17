/**
 * @shadow/sessions — the transcript of record.
 *
 * The only package that knows the storage format for a chat session:
 * `~/.shadow/sessions/<id>/meta.json` + `events.jsonl` (append-only, `seq`
 * as the replay cursor). Everything else — `@shadow/api`'s
 * `SessionService` (T2.5), the shared event mapper (T2.2), the replay+
 * follow endpoint (T2.7) — depends on `SessionStore`, never on the
 * filesystem layout directly (see `layout.ts`'s module doc).
 */

export {
  InvalidSessionIdError,
  SessionAlreadyExistsError,
  SessionEventsCorruptError,
  SessionNotFoundError,
  ShadowSessionsError,
} from "./errors.ts";
export type {
  AgentStoredEvent,
  OperatorMessageEvent,
  StoredSessionEvent,
  TurnBoundaryEndReason,
  TurnBoundaryEvent,
  UnknownStoredEvent,
} from "./events.ts";
export { FileSystemSessionStore } from "./filesystem-session-store.ts";
export type {
  NewStoredEvent,
  SessionListFilter,
  SessionMeta,
  SessionMetaPatch,
  SessionStore,
  StoredEventRecord,
} from "./session-store.ts";
