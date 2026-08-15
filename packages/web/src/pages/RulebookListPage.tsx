import { useEffect, useState } from "react";
import type { ShadowApiClient } from "../api/client.ts";
import type { RulebookSummary } from "../api/types.ts";
import type { Route } from "../routing/useHashRoute.ts";

const statusLabels: Record<RulebookSummary["status"], string> = {
  draft: "Draft",
  stable: "Stable",
  deprecated: "Deprecated",
};

/**
 * The rule-books landing view — read-only, unlike `VolumeListPage`: a rule
 * book is only ever created via the `shadow:rulebook` chat directive, so
 * there is no create form here, only what a run already produced.
 */
export function RulebookListPage({
  client,
  navigate,
}: {
  readonly client: ShadowApiClient;
  readonly navigate: (route: Route) => void;
}) {
  const [rulebooks, setRulebooks] = useState<readonly RulebookSummary[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    client
      .listRulebooks()
      .then((result) => {
        if (!cancelled) setRulebooks(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <div className="page rulebook-list-page">
      <header className="page__header">
        <h1>Rule books</h1>
        <p className="page__subtitle">
          Rules extracted from a source document, chat with Shadow to build one.
        </p>
      </header>

      {error && <p role="alert">Could not load rule books: {error}</p>}

      {rulebooks === undefined && !error && <p aria-live="polite">Loading rule books…</p>}

      {rulebooks && rulebooks.length === 0 && (
        <p className="volume-list__empty">
          No rule books yet — chat with Shadow and ask it to build one from a document.
        </p>
      )}

      {rulebooks && rulebooks.length > 0 && (
        <ul className="volume-list">
          {rulebooks.map((rulebook) => (
            <li key={rulebook.slug}>
              <button
                type="button"
                className="volume-card"
                onClick={() => navigate({ name: "rulebook", slug: rulebook.slug })}
              >
                <span className="volume-card__title">{rulebook.title}</span>
                <span className="volume-card__meta">
                  {statusLabels[rulebook.status]} · {rulebook.groupCount} group
                  {rulebook.groupCount === 1 ? "" : "s"} · updated {formatDate(rulebook.updatedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
