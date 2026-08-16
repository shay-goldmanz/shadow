import { useEffect, useState } from "react";
import type { ShadowApiClient } from "../api/client.ts";
import type { Rulebook, RulebookGroupSummary } from "../api/types.ts";
import type { Route } from "../routing/useHashRoute.ts";

const statusLabels: Record<Rulebook["status"], string> = {
  draft: "Draft",
  stable: "Stable",
  deprecated: "Deprecated",
};

/** A rule book's groups, plus its provenance — the rule-book counterpart of `VolumeViewPage`. */
export function RulebookViewPage({
  client,
  slug,
  navigate,
}: {
  readonly client: ShadowApiClient;
  readonly slug: string;
  readonly navigate: (route: Route) => void;
}) {
  const [data, setData] = useState<
    { rulebook: Rulebook; groups: readonly RulebookGroupSummary[] } | undefined
  >(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setData(undefined);
    setError(undefined);
    client
      .getRulebook(slug)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client, slug]);

  if (error) return <p role="alert">Could not load this rule book: {error}</p>;
  if (!data) return <p aria-live="polite">Loading rule book…</p>;

  const statusLabel = statusLabels[data.rulebook.status];

  return (
    <div className="page rulebook-view-page">
      <header className="page__header">
        <button type="button" className="link-back" onClick={() => navigate({ name: "rulebooks" })}>
          ← Rule books
        </button>
        <h1>{data.rulebook.title}</h1>
        <div className="rulebook-view-page__meta">
          <span
            className={`rulebook-view-page__status rulebook-view-page__status--${data.rulebook.status}`}
            aria-label={`Status: ${statusLabel}`}
          >
            {statusLabel}
          </span>
        </div>
        {data.rulebook.whenToUse && <p className="page__subtitle">{data.rulebook.whenToUse}</p>}
        {data.rulebook.sourceDoc && (
          <p className="rulebook-view-page__source">
            Extracted from <code>{data.rulebook.sourceDoc.url}</code>
          </p>
        )}
      </header>

      <section aria-label="Groups">
        <h2>Groups</h2>
        {data.groups.length === 0 ? (
          <p>No groups yet.</p>
        ) : (
          <ul className="chapter-list">
            {data.groups.map((group) => (
              <li key={group.slug} className="chapter-card">
                <button
                  type="button"
                  className="chapter-list__item"
                  onClick={() => navigate({ name: "rulebook-group", slug, group: group.slug })}
                >
                  <span className="chapter-list__title">{group.title}</span>
                  <span className="volume-card__meta">
                    {statusLabels[group.status]} · {group.ruleCount} rule
                    {group.ruleCount === 1 ? "" : "s"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
