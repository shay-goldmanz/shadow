import { useEffect, useRef, useState } from "react";
import type { ShadowApiClient } from "../api/client.ts";
import { ApiError, type SessionSummary } from "../api/types.ts";
import type { NavigateOptions, Route } from "../routing/useHashRoute.ts";

/**
 * T3.2 — the chat screen's session list, scoped to the current volume:
 * title, last-active, resume (navigate to the session's own URL — the F6
 * route-keying fix makes that remount correctly), inline rename, delete
 * behind a confirm. Lives above the transcript on `ChatPage` (D10: no new
 * shell — this is a section in the same single-column layout every other
 * screen uses, the same way `chapter-page__history` sits above its own
 * content).
 *
 * ## Refresh strategy
 *
 * Fetches on mount and whenever `refreshToken` changes — `ChatPage` bumps
 * that after its own first send mints a session id (T2.8: that transition
 * does not remount `ChatPage`, so nothing else would ever tell this list a
 * new row exists). Rename/delete update `sessions` locally from each
 * mutation's own response/success, matching `VolumeListPage`'s
 * call-then-update convention — no refetch needed for those, since this
 * component already holds the authoritative list.
 */
export function SessionList({
  client,
  slug,
  currentSessionId,
  refreshToken,
  navigate,
}: {
  readonly client: ShadowApiClient;
  readonly slug: string;
  /** The session this `ChatPage` mount is currently showing, if any — used to highlight the active row and to navigate to new-chat if that row gets deleted. */
  readonly currentSessionId: string | undefined;
  /** Bump this (e.g. a counter) to force a refetch — see this component's doc. */
  readonly refreshToken?: unknown;
  readonly navigate: (route: Route, options?: NavigateOptions) => void;
}) {
  const [sessions, setSessions] = useState<readonly SessionSummary[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    client
      .listSessions(slug)
      .then((result) => {
        if (!cancelled) setSessions(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // `refreshToken` is intentionally an effect dependency purely to force a
    // refetch — its value is never otherwise read.
    // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken is a refetch trigger only
  }, [client, slug, refreshToken]);

  async function handleRename(id: string, title: string): Promise<void> {
    const updated = await client.renameSession(id, title);
    setSessions((prev) => prev?.map((s) => (s.id === id ? updated : s)));
  }

  async function handleDelete(id: string): Promise<void> {
    await client.deleteSession(id);
    setSessions((prev) => prev?.filter((s) => s.id !== id));
    if (id === currentSessionId) {
      navigate({ name: "chat", slug });
    }
  }

  return (
    <section className="session-list" aria-label="Sessions">
      <div className="session-list__header">
        <h2>Sessions</h2>
        <button
          type="button"
          className="button button--primary session-list__new"
          onClick={() => navigate({ name: "chat", slug })}
        >
          + New chat
        </button>
      </div>

      {error && <p role="alert">Could not load sessions: {error}</p>}
      {sessions === undefined && !error && <p aria-live="polite">Loading sessions…</p>}
      {sessions && sessions.length === 0 && (
        <p className="session-list__empty">No sessions yet in this volume — start one above.</p>
      )}

      {sessions && sessions.length > 0 && (
        <ul className="session-list__items">
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              isActive={session.id === currentSessionId}
              onResume={() => navigate({ name: "chat", slug, sessionId: session.id })}
              onRename={handleRename}
              onDelete={handleDelete}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function SessionRow({
  session,
  isActive,
  onResume,
  onRename,
  onDelete,
}: {
  readonly session: SessionSummary;
  readonly isActive: boolean;
  readonly onResume: () => void;
  readonly onRename: (id: string, title: string) => Promise<void>;
  readonly onDelete: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title ?? "");
  const [renameError, setRenameError] = useState<string | undefined>(undefined);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);
  const [deleting, setDeleting] = useState(false);
  // Set right before a keydown (Enter/Escape) drives the input out of edit
  // mode, so the blur that follows the DOM removal doesn't ALSO commit —
  // see this file's module doc on the Enter/Escape/blur interaction.
  const suppressBlurRef = useRef(false);

  function startEdit(): void {
    setDraft(session.title ?? "");
    setRenameError(undefined);
    setEditing(true);
  }

  function commit(): void {
    setEditing(false);
    const trimmed = draft.trim();
    if (!trimmed || trimmed === (session.title ?? "")) return;
    void onRename(session.id, trimmed).catch((err: unknown) => {
      setRenameError(
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err),
      );
    });
  }

  function cancelEdit(): void {
    suppressBlurRef.current = true;
    setDraft(session.title ?? "");
    setEditing(false);
  }

  async function confirmDelete(): Promise<void> {
    setDeleting(true);
    setDeleteError(undefined);
    try {
      await onDelete(session.id);
    } catch (err) {
      setConfirmingDelete(false);
      setDeleteError(
        err instanceof ApiError && err.code === "session_busy"
          ? "Turn still running — try deleting again once it finishes."
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <li className={`session-row${isActive ? " session-row--active" : ""}`}>
      <div className="session-row__main">
        {editing ? (
          <input
            type="text"
            className="session-row__input"
            aria-label={`Rename "${session.title ?? "Untitled session"}"`}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                suppressBlurRef.current = true;
                commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelEdit();
              }
            }}
            onBlur={() => {
              if (suppressBlurRef.current) {
                suppressBlurRef.current = false;
                return;
              }
              commit();
            }}
          />
        ) : (
          <button
            type="button"
            className="session-row__title"
            onClick={onResume}
            disabled={isActive}
            aria-current={isActive ? "true" : undefined}
          >
            {session.title ?? "Untitled session"}
          </button>
        )}
        <span className="session-row__meta">active {formatDate(session.lastActiveAt)}</span>
      </div>

      <div className="session-row__actions">
        {!editing && (
          <button type="button" className="session-row__action" onClick={startEdit}>
            Rename
          </button>
        )}
        {!confirmingDelete ? (
          <button
            type="button"
            className="session-row__action session-row__action--danger"
            onClick={() => {
              setConfirmingDelete(true);
              setDeleteError(undefined);
            }}
          >
            Delete
          </button>
        ) : (
          <span className="session-row__confirm">
            <span className="session-row__confirm-label">Delete this session?</span>
            <button
              type="button"
              className="session-row__action session-row__action--danger-confirm"
              onClick={() => void confirmDelete()}
              disabled={deleting}
            >
              {deleting ? "Deleting…" : "Confirm"}
            </button>
            <button
              type="button"
              className="session-row__action"
              onClick={() => setConfirmingDelete(false)}
              disabled={deleting}
            >
              Cancel
            </button>
          </span>
        )}
      </div>

      {renameError && (
        <p className="session-row__error" role="alert">
          {renameError}
        </p>
      )}
      {deleteError && (
        <p className="session-row__error" role="alert">
          {deleteError}
        </p>
      )}
    </li>
  );
}
