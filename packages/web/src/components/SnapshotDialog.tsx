import { useEffect, useRef, useState } from "react";
import type { ShadowApiClient } from "../api/client.ts";
import type { AnchorStatus, SourceRecord, TextQuoteSelector } from "../api/types.ts";
import { Badge } from "./Badge.tsx";

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
      readonly selector: TextQuoteSelector;
      readonly anchorStatus: AnchorStatus;
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

interface ExcerptResult {
  readonly prefixTrim: string;
  readonly exact: string;
  readonly suffixTrim: string;
  readonly atStart: boolean;
  readonly atEnd: boolean;
  readonly matchStart: number;
  readonly matchEnd: number;
}

const EXCERPT_WINDOW = 150;

function computeExcerpt(text: string, selector: TextQuoteSelector): ExcerptResult | null {
  let matchStart: number;
  let matchEnd: number;

  if (selector.refinedBy) {
    matchStart = selector.refinedBy.start;
    matchEnd = selector.refinedBy.end;
  } else {
    const idx = text.indexOf(selector.exact);
    if (idx === -1) return null;
    matchStart = idx;
    matchEnd = idx + selector.exact.length;
  }

  let prefixStart = Math.max(0, matchStart - EXCERPT_WINDOW);
  let suffixEnd = Math.min(text.length, matchEnd + EXCERPT_WINDOW);

  // Cut at word boundary — don't chop mid-word in the surrounding context.
  if (prefixStart > 0) {
    const wsIdx = text.indexOf(" ", prefixStart);
    if (wsIdx !== -1 && wsIdx < matchStart) prefixStart = wsIdx + 1;
  }
  if (suffixEnd < text.length) {
    const wsIdx = text.lastIndexOf(" ", suffixEnd);
    if (wsIdx !== -1 && wsIdx > matchEnd) suffixEnd = wsIdx;
  }

  return {
    prefixTrim: text.slice(prefixStart, matchStart),
    exact: text.slice(matchStart, matchEnd),
    suffixTrim: text.slice(matchEnd, suffixEnd),
    atStart: prefixStart === 0,
    atEnd: suffixEnd === text.length,
    matchStart,
    matchEnd,
  };
}

/**
 * The chain of evidence made inspectable: opens the exact pinned bytes a
 * citation was written from (`GET .../evidence/snapshot/:hash`), plus the
 * source it came from — or, for a `derived` claim, the other claims it was
 * synthesized from, already in memory (`ChapterPage.tsx` builds this from
 * the chapter's own claim list, no fetch needed). A native `<dialog>` gives
 * focus trapping and Escape-to-close for free either way.
 *
 * `scope` picks which evidence store `slug` names: a volume's
 * (`getSource`/`getSnapshot`) or a rule book's own
 * (`getRulebookSource`/`getRulebookSnapshot`) — the two are separate
 * `EvidenceStore` instances server-side (`handlers/evidence.ts`'s module
 * doc), so a rule-book citation must hit its own routes rather than the
 * volume ones.
 */
export function SnapshotDialog({
  request,
  slug,
  scope,
  client,
  onClose,
}: {
  readonly request: SnapshotRequest | undefined;
  readonly slug: string;
  readonly scope: "volume" | "rulebook";
  readonly client: ShadowApiClient;
  readonly onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const matchRef = useRef<HTMLElement>(null);
  const [state, setState] = useState<SnapshotState>({ loading: false });
  const [expanded, setExpanded] = useState(false);

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
    setExpanded(false);
    if (!request || request.kind !== "sourced") {
      setState({ loading: false });
      return;
    }
    let cancelled = false;
    setState({ loading: true });
    Promise.all(
      scope === "rulebook"
        ? [
            client.getRulebookSource(slug, request.sourceId),
            client.getRulebookSnapshot(slug, request.snapshotHash),
          ]
        : [client.getSource(slug, request.sourceId), client.getSnapshot(slug, request.snapshotHash)],
    )
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
  }, [request, slug, scope, client]);

  useEffect(() => {
    if (expanded) {
      matchRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [expanded]);

  // Derived from current request + fetched text — cheap to recompute each render.
  const excerpt: ExcerptResult | null =
    request?.kind === "sourced" && state.text && request.anchorStatus !== "orphaned"
      ? computeExcerpt(state.text, request.selector)
      : null;

  return (
    <dialog
      ref={dialogRef}
      className="snapshot-dialog"
      aria-labelledby="snapshot-dialog-title"
      onClose={onClose}
      onCancel={onClose}
      onClick={(event) => {
        // A click lands directly on the `<dialog>` element only when it hits
        // the backdrop — anything inside `snapshot-dialog__body` is a
        // descendant and the event target there is never the dialog itself.
        if (event.target === dialogRef.current) onClose();
      }}
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
                  {request.anchorStatus === "anchored-fuzzy" && (
                    <>
                      {" "}
                      <Badge tone="amber">≈ approximate</Badge>
                    </>
                  )}
                  {request.anchorStatus === "orphaned" && (
                    <>
                      {" "}
                      <Badge tone="red">⚠ not found</Badge>
                    </>
                  )}
                </p>
              )}
              {state.text && (
                <>
                  <div className="snapshot-dialog__excerpt">
                    {request.anchorStatus === "orphaned" ? (
                      // Orphaned: offset data is untrustworthy — show the
                      // selector's own bounded context (prefix/exact/suffix)
                      // as plain unhighlighted text instead.
                      <span>
                        {request.selector.prefix}
                        {request.selector.exact}
                        {request.selector.suffix}
                      </span>
                    ) : excerpt ? (
                      <>
                        {!excerpt.atStart && <span className="snapshot-dialog__ellipsis">…</span>}
                        {excerpt.prefixTrim}
                        <mark className="snapshot-dialog__highlight">{excerpt.exact}</mark>
                        {excerpt.suffixTrim}
                        {!excerpt.atEnd && <span className="snapshot-dialog__ellipsis">…</span>}
                      </>
                    ) : (
                      <span>{request.selector.exact}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="snapshot-dialog__expand-toggle"
                    onClick={() => setExpanded((prev) => !prev)}
                  >
                    {expanded
                      ? "▴ Hide full source"
                      : request.anchorStatus === "orphaned"
                        ? "View full source anyway"
                        : "▾ Show full source"}
                  </button>
                  {expanded && (
                    <pre className="snapshot-dialog__text">
                      {excerpt ? (
                        <>
                          {state.text.slice(0, excerpt.matchStart)}
                          <mark ref={matchRef} className="snapshot-dialog__highlight">
                            {state.text.slice(excerpt.matchStart, excerpt.matchEnd)}
                          </mark>
                          {state.text.slice(excerpt.matchEnd)}
                        </>
                      ) : (
                        state.text
                      )}
                    </pre>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </dialog>
  );
}
