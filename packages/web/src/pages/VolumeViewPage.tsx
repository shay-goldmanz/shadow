import { useEffect, useState } from "react";
import type { ShadowApiClient } from "../api/client.ts";
import {
  ApiError,
  type ChapterIndexNode,
  type ChapterSummary,
  type Volume,
  type VolumeIndexDocument,
  whenToUseOf,
} from "../api/types.ts";
import type { Route } from "../routing/useHashRoute.ts";
import { ChapterOutline } from "./ChapterOutline.tsx";

type IndexState =
  | { readonly status: "loading" }
  /** A volume that has never been indexed 404s `index_not_built` — a normal state for a freshly created volume (nothing has published yet), not a page-level error. */
  | { readonly status: "not-built" }
  | { readonly status: "ready"; readonly index: VolumeIndexDocument }
  | { readonly status: "error"; readonly message: string };

/** Chapters in a volume, plus its index tree — screen 2. */
export function VolumeViewPage({
  client,
  slug,
  navigate,
}: {
  readonly client: ShadowApiClient;
  readonly slug: string;
  readonly navigate: (route: Route) => void;
}) {
  const [data, setData] = useState<
    { volume: Volume; chapters: readonly ChapterSummary[] } | undefined
  >(undefined);
  const [indexState, setIndexState] = useState<IndexState>({ status: "loading" });
  const [error, setError] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    setData(undefined);
    setError(undefined);
    setIndexState({ status: "loading" });

    // Independent requests, not `Promise.all`: a volume with no index yet
    // (true of every volume immediately after creation, before its first
    // chapter publishes) must not dead-end the whole page just because
    // `getIndex` 404s — that is the critical path's very first screen after
    // "create volume".
    client
      .getVolume(slug)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });

    client
      .getIndex(slug)
      .then((index) => {
        if (!cancelled) setIndexState({ status: "ready", index });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.code === "index_not_built") {
          setIndexState({ status: "not-built" });
        } else {
          setIndexState({
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [client, slug]);

  if (error) return <p role="alert">Could not load this volume: {error}</p>;
  if (!data) return <p aria-live="polite">Loading volume…</p>;

  const query = filter.trim().toLowerCase();
  const visibleChapters = query
    ? data.chapters.filter(
        (chapter) =>
          chapter.title.toLowerCase().includes(query) ||
          (whenToUseOf(chapter) ?? "").toLowerCase().includes(query),
      )
    : data.chapters;

  // The outline used to be its own column, one flat list of every chapter's
  // sections next to the chapter list — cross-referencing the two by title
  // was on the operator. Looked up by slug instead, so each chapter's own
  // outline can sit inside its own card.
  const outlineBySlug: ReadonlyMap<string, ChapterIndexNode> =
    indexState.status === "ready"
      ? new Map(indexState.index.volume.chapters.map((node) => [node.slug, node]))
      : new Map();

  return (
    <div className="page volume-view-page">
      <header className="page__header">
        <button type="button" className="link-back" onClick={() => navigate({ name: "volumes" })}>
          ← Volumes
        </button>
        <h1>{data.volume.title}</h1>
        {data.volume.description && <p className="page__subtitle">{data.volume.description}</p>}
        <button
          type="button"
          className="button button--primary"
          onClick={() => navigate({ name: "chat", slug })}
        >
          Chat with Shadow
        </button>
      </header>

      <section aria-label="Chapters">
        <h2>Chapters</h2>
        {data.chapters.length === 0 ? (
          <p>No chapters yet — chat with Shadow to write the first one.</p>
        ) : (
          <>
            <input
              type="text"
              className="chapter-filter"
              aria-label="Find a chapter"
              placeholder="Find a chapter by task…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            {visibleChapters.length === 0 ? (
              <p className="chapter-filter__empty">No chapter matches "{filter.trim()}".</p>
            ) : (
              <ul className="chapter-list">
                {visibleChapters.map((chapter) => {
                  const outline = outlineBySlug.get(chapter.slug);
                  return (
                    <li key={chapter.slug} className="chapter-card">
                      <button
                        type="button"
                        className="chapter-list__item"
                        onClick={() => navigate({ name: "chapter", slug, chapter: chapter.slug })}
                      >
                        <span className="chapter-list__title">{chapter.title}</span>
                      </button>
                      {outline && <ChapterOutline node={outline} />}
                      {whenToUseOf(chapter) && (
                        <details className="chapter-card__details">
                          <summary>When to use</summary>
                          <p className="chapter-card__when-to-use">{whenToUseOf(chapter)}</p>
                        </details>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  );
}
