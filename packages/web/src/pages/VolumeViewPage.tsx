import { useEffect, useState } from "react";
import type { ShadowApiClient } from "../api/client.ts";
import type { ChapterSummary, IndexTree, Volume } from "../api/types.ts";
import type { Route } from "../routing/useHashRoute.ts";
import { IndexTreeView } from "./IndexTreeView.tsx";

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
  const [index, setIndex] = useState<IndexTree | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setData(undefined);
    setIndex(undefined);
    setError(undefined);
    Promise.all([client.getVolume(slug), client.getIndex(slug)])
      .then(([volumeResult, indexResult]) => {
        if (!cancelled) {
          setData(volumeResult);
          setIndex(indexResult);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client, slug]);

  if (error) return <p role="alert">Could not load this volume: {error}</p>;
  if (!data) return <p aria-live="polite">Loading volume…</p>;

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

      <div className="volume-view-page__columns">
        <section aria-label="Chapters">
          <h2>Chapters</h2>
          {data.chapters.length === 0 ? (
            <p>No chapters yet — chat with Shadow to write the first one.</p>
          ) : (
            <ul className="chapter-list">
              {data.chapters.map((chapter) => (
                <li key={chapter.slug}>
                  <button
                    type="button"
                    className="chapter-list__item"
                    onClick={() => navigate({ name: "chapter", slug, chapter: chapter.slug })}
                  >
                    <span className="chapter-list__title">{chapter.title}</span>
                    {chapter.whenToUse && (
                      <span className="chapter-list__when-to-use">{chapter.whenToUse}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Index tree">
          <h2>Index</h2>
          {index && <IndexTreeView index={index} />}
        </section>
      </div>
    </div>
  );
}
