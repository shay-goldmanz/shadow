import { useEffect, useState } from "react";
import type { ShadowApiClient } from "../api/client.ts";
import {
  type AuditRecord,
  type Chapter,
  type Claim,
  issuesOf,
  type LedgerEvent,
  type OkfStatus,
} from "../api/types.ts";
import { AuditBanner, type AuditSummary } from "../components/AuditBanner.tsx";
import { ChapterProse } from "../components/ChapterProse.tsx";
import { RestatementNotice } from "../components/RestatementNotice.tsx";
import { SnapshotDialog, type SnapshotRequest } from "../components/SnapshotDialog.tsx";
import type { Route } from "../routing/useHashRoute.ts";

interface ChapterData {
  readonly chapter: Chapter;
  readonly claims: readonly Claim[];
  readonly audit: AuditRecord | undefined;
}

type ClaimRestatedEvent = Extract<LedgerEvent, { event: "claim.restated" }>;

const statusLabels: Record<OkfStatus, string> = {
  draft: "Draft",
  stable: "Stable",
  deprecated: "Deprecated",
};

/** Builds `AuditBanner`'s normalized props from the real `GET .../chapters/:chapter` `AuditRecord` — `verdict.passed`, not a `"pass"`/`"fail"` string; issues nest under `verdict.outcomes[].issues[]`, not a flat `findings[]`. */
function auditSummaryOf(audit: AuditRecord): AuditSummary {
  return {
    passed: audit.verdict.passed,
    findings: issuesOf(audit.verdict).map((issue) => ({
      code: issue.code,
      message: issue.message,
      label: issue.label,
    })),
  };
}

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
          // `claims` is the whole sidecar (`ClaimSidecar`), not a `Claim[]`
          // — `undefined` for a chapter that has never been audited.
          setData({
            chapter: result.chapter,
            claims: result.claims?.claims ?? [],
            audit: result.audit,
          });
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

  // A `ClaimRestatedEvent` carries its own `chapter` (the ledger is
  // volume-wide; a restatement is not) — scope directly on that rather than
  // cross-referencing the chapter's *current* claim labels, which would
  // miss a restatement on a label since deleted (D18: labels are never
  // reused, so ledger history for one can outlive the claim itself).
  const restatements = ledgerRestatements.filter((event) => event.chapter === chapterSlug);
  // `ClaimRestatedEvent.claimId` is the claim's stable ULID (`toLedgerEvent`,
  // `@shadow/evidence`), not its `[^label]` — resolve back to the label the
  // operator actually reads via the chapter's current claims. Falls back to
  // the raw id if the claim was since deleted (labels are never reused, but
  // a deleted claim's own record is gone too).
  const labelByClaimId = new Map(data.claims.map((claim) => [claim.id, claim.label]));
  const claimsByLabel = new Map(data.claims.map((claim) => [claim.label, claim]));

  const escalatedCount = restatements.filter((event) => event.outcome === "escalated").length;

  const auditSummary = data.audit ? auditSummaryOf(data.audit) : undefined;
  const failingLabels = new Set(
    (auditSummary?.findings ?? []).flatMap((f) => (f.label ? [f.label] : [])),
  );

  const isStale =
    data.chapter.staleAfter !== null &&
    typeof data.chapter.staleAfter === "string" &&
    new Date(data.chapter.staleAfter) <= new Date();
  const statusLabel = statusLabels[data.chapter.status];

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
        <div className="chapter-page__meta">
          <span
            className={`chapter-page__status chapter-page__status--${data.chapter.status}`}
            aria-label={`Status: ${statusLabel}`}
          >
            {statusLabel}
          </span>
          {isStale && (
            <span className="chapter-page__stale" role="alert">
              Stale since {data.chapter.staleAfter}
            </span>
          )}
          {data.chapter.generated.by && data.chapter.generated.by !== "unknown" && (
            <span className="chapter-page__author">Written by {data.chapter.generated.by}</span>
          )}
        </div>
      </header>

      {auditSummary && <AuditBanner audit={auditSummary} />}

      <ChapterProse
        body={data.chapter.body}
        claims={data.claims}
        failingLabels={failingLabels}
        onCiteClick={(claim) => {
          // A `derived` claim has no evidence span of its own by design
          // (D19) — it's a synthesis of other claims in this chapter, not
          // its own source. Opening the claims it follows from (already in
          // memory) is the analogue of "evidence" for this kind, rather
          // than a dead click on `claim.evidence[0]` being `undefined`.
          if (claim.kind === "derived") {
            setSnapshotRequest({
              kind: "derived",
              label: claim.label,
              supports: claim.supports.flatMap((label) => {
                const supporting = claimsByLabel.get(label);
                return supporting ? [{ label: supporting.label, text: supporting.text }] : [];
              }),
            });
            return;
          }
          const span = claim.evidence[0];
          if (span) {
            setSnapshotRequest({
              kind: "sourced",
              label: claim.label,
              sourceId: span.sourceId,
              snapshotHash: span.snapshotHash,
            });
          }
        }}
      />

      {restatements.length > 0 && (
        <details aria-label="Evidence history" className="chapter-page__history">
          <summary>
            <h2>What Shadow softened</h2>
            <span className="chapter-page__history-count">
              {restatements.length} claim{restatements.length === 1 ? "" : "s"}
              {escalatedCount > 0 &&
                ` · ${escalatedCount} need${escalatedCount === 1 ? "s" : ""} review`}
            </span>
          </summary>
          {restatements.map((event) => (
            <RestatementNotice
              key={`${event.claimId}-${event.ts}`}
              restatement={{
                claim: labelByClaimId.get(event.claimId) ?? event.claimId,
                from: event.from,
                to: event.to,
                reason: event.reason,
                outcome: event.outcome,
              }}
            />
          ))}
        </details>
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
