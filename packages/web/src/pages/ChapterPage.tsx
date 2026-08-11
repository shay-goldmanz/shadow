import { useEffect, useState } from "react";
import type { ShadowApiClient } from "../api/client.ts";
import type { AuditResult, Chapter, Claim, LedgerEvent } from "../api/types.ts";
import { AuditBanner } from "../components/AuditBanner.tsx";
import { ChapterProse } from "../components/ChapterProse.tsx";
import { RestatementNotice } from "../components/RestatementNotice.tsx";
import { SnapshotDialog, type SnapshotRequest } from "../components/SnapshotDialog.tsx";
import type { Route } from "../routing/useHashRoute.ts";

interface ChapterData {
  readonly chapter: Chapter;
  readonly claims: readonly Claim[];
  readonly audit: AuditResult | undefined;
}

type ClaimRestatedEvent = Extract<LedgerEvent, { event: "claim.restated" }>;

/**
 * The chapter as prose, with citations traceable back to their sources —
 * screen 4, and where the chain of evidence stops being a data structure
 * and becomes something the operator can act on.
 */
export function ChapterPage({
  client,
  slug,
  chapterSlug,
  navigate,
}: {
  readonly client: ShadowApiClient;
  readonly slug: string;
  readonly chapterSlug: string;
  readonly navigate: (route: Route) => void;
}) {
  const [data, setData] = useState<ChapterData | undefined>(undefined);
  const [ledgerRestatements, setLedgerRestatements] = useState<readonly ClaimRestatedEvent[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [snapshotRequest, setSnapshotRequest] = useState<SnapshotRequest | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setData(undefined);
    setError(undefined);
    client
      .getChapter(slug, chapterSlug)
      .then((result) => {
        if (!cancelled) {
          setData({ chapter: result.chapter, claims: result.claims ?? [], audit: result.audit });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    client
      .getLedger(slug)
      .then((result) => {
        if (!cancelled) {
          setLedgerRestatements(
            result.events.filter(
              (event): event is ClaimRestatedEvent => event.event === "claim.restated",
            ),
          );
        }
      })
      .catch(() => {
        // The evidence history is supplementary — a failure here should not block the chapter itself.
      });
    return () => {
      cancelled = true;
    };
  }, [client, slug, chapterSlug]);

  if (error) return <p role="alert">Could not load this chapter: {error}</p>;
  if (!data) return <p aria-live="polite">Loading chapter…</p>;

  // The ledger is volume-wide (docs/API.md doesn't scope claim.restated events
  // to a chapter the way it does audit.completed events), so restrict it here
  // to claims that actually belong to the chapter being viewed.
  const chapterLabels = new Set(data.claims.map((claim) => claim.label));
  const restatements = ledgerRestatements.filter((event) => chapterLabels.has(event.claimId));

  return (
    <div className="page chapter-page">
      <header className="page__header">
        <button
          type="button"
          className="link-back"
          onClick={() => navigate({ name: "volume", slug })}
        >
          ← {slug}
        </button>
        <h1>{data.chapter.title}</h1>
      </header>

      {data.audit && <AuditBanner audit={data.audit} />}

      <ChapterProse
        body={data.chapter.body}
        claims={data.claims}
        audit={data.audit}
        onCiteClick={(claim) => {
          const span = claim.evidence[0];
          if (span) {
            setSnapshotRequest({
              label: claim.label,
              sourceId: span.sourceId,
              snapshotHash: span.snapshotHash,
            });
          }
        }}
      />

      {restatements.length > 0 && (
        <section aria-label="Evidence history" className="chapter-page__history">
          <h2>What Shadow softened</h2>
          {restatements.map((event) => (
            <RestatementNotice
              key={`${event.claimId}-${event.ts}`}
              restatement={{
                claim: event.claimId,
                from: event.from,
                to: event.to,
                reason: event.reason,
                outcome: event.outcome,
              }}
            />
          ))}
        </section>
      )}

      <SnapshotDialog
        request={snapshotRequest}
        volumeSlug={slug}
        client={client}
        onClose={() => setSnapshotRequest(undefined)}
      />
    </div>
  );
}
