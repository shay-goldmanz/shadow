import { useEffect, useRef, useState } from "react";
import type { ShadowApiClient } from "../api/client.ts";
import type { SourceRecord } from "../api/types.ts";

/**
 * What clicking a citation opens depends on what kind of claim it is
 * (`ChapterPage.tsx`'s `onCiteClick`): a `sourced`/`operator` claim has its
 * own evidence span to fetch and show; a `derived` claim has none by
 * design (D19 — it's a synthesis of other claims in the chapter, not its
 * own source) and opens the claims it follows from instead. Without this
 * split, a derived claim's citation used to just do nothing when clicked —
 * `claim.evidence[0]` was `undefined`, so the fetch never started.
 */
export type SnapshotRequest =
  | {
      readonly kind: "sourced";
      readonly label: string;
      readonly sourceId: string;
      readonly snapshotHash: string;
    }
  | {
      readonly kind: "derived";
      readonly label: string;
      readonly supports: readonly { readonly label: string; readonly text: string }[];
    };

interface SnapshotState {
  readonly source?: SourceRecord;
  readonly text?: string;
  readonly error?: string;
  readonly loading: boolean;
}

/**
 * The chain of evidence made inspectable: opens the exact pinned bytes a
 * citation was written from (`GET .../evidence/snapshot/:hash`), plus the
 * source it came from — or, for a `derived` claim, the other claims it was
 * synthesized from, already in memory (`ChapterPage.tsx` builds this from
 * the chapter's own claim list, no fetch needed). A native `<dialog>` gives
 * focus trapping and Escape-to-close for free either way.
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
    if (!request || request.kind !== "sourced") {
      setState({ loading: false });
      return;
    }
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
            <h2 id="snapshot-dialog-title">
              {request.kind === "derived" ? "Derived from" : "Evidence for"} [^{request.label}]
            </h2>
            <button type="button" onClick={onClose} aria-label="Close">
              ×
            </button>
          </header>
          {request.kind === "derived" ? (
            request.supports.length > 0 ? (
              <ul className="snapshot-dialog__supports">
                {request.supports.map((support) => (
                  <li key={support.label}>
                    <span className="snapshot-dialog__supports-label">[^{support.label}]</span>{" "}
                    {support.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="snapshot-dialog__supports-empty">
                No supporting claims recorded for this label.
              </p>
            )
          ) : (
            <>
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
            </>
          )}
        </div>
      )}
    </dialog>
  );
}
