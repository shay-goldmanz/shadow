import { useEffect, useRef, useState } from "react";
import type { ShadowApiClient } from "../api/client.ts";
import type { SourceRecord } from "../api/types.ts";

export interface SnapshotRequest {
  readonly label: string;
  readonly sourceId: string;
  readonly snapshotHash: string;
}

interface SnapshotState {
  readonly source?: SourceRecord;
  readonly text?: string;
  readonly error?: string;
  readonly loading: boolean;
}

/**
 * The chain of evidence made inspectable: opens the exact pinned bytes a
 * citation was written from (`GET .../evidence/snapshot/:hash`), plus the
 * source it came from. A native `<dialog>` gives focus trapping and
 * Escape-to-close for free.
 */
export function SnapshotDialog({
  request,
  volumeSlug,
  client,
  onClose,
}: {
  readonly request: SnapshotRequest | undefined;
  readonly volumeSlug: string;
  readonly client: ShadowApiClient;
  readonly onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<SnapshotState>({ loading: false });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (request) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [request]);

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    setState({ loading: true });
    Promise.all([
      client.getSource(volumeSlug, request.sourceId),
      client.getSnapshot(volumeSlug, request.snapshotHash),
    ])
      .then(([source, text]) => {
        if (!cancelled) setState({ loading: false, source, text });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [request, volumeSlug, client]);

  return (
    <dialog
      ref={dialogRef}
      className="snapshot-dialog"
      aria-labelledby="snapshot-dialog-title"
      onClose={onClose}
      onCancel={onClose}
    >
      {request && (
        <div className="snapshot-dialog__body">
          <header className="snapshot-dialog__header">
            <h2 id="snapshot-dialog-title">Evidence for [^{request.label}]</h2>
            <button type="button" onClick={onClose} aria-label="Close">
              ×
            </button>
          </header>
          {state.loading && <p role="status">Loading snapshot…</p>}
          {state.error && <p role="alert">Could not load this snapshot: {state.error}</p>}
          {state.source && (
            <p className="snapshot-dialog__source">
              <a href={state.source.url} target="_blank" rel="noreferrer">
                {state.source.title}
              </a>{" "}
              <span className="meta">
                · {state.source.retrieval.transport} · retrieved{" "}
                {state.source.retrieval.retrievedAt}
              </span>
            </p>
          )}
          {state.text && <pre className="snapshot-dialog__text">{state.text}</pre>}
        </div>
      )}
    </dialog>
  );
}
