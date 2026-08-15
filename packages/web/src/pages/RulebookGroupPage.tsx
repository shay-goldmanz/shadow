import { useEffect, useState } from "react";
import type { ShadowApiClient } from "../api/client.ts";
import {
  type AuditRecord,
  type Chapter,
  type Claim,
  issuesOf,
  type OkfStatus,
} from "../api/types.ts";
import { AuditBanner, type AuditSummary } from "../components/AuditBanner.tsx";
import { ChapterProse } from "../components/ChapterProse.tsx";
import { SnapshotDialog, type SnapshotRequest } from "../components/SnapshotDialog.tsx";
import type { Route } from "../routing/useHashRoute.ts";

interface GroupData {
  readonly group: Chapter;
  readonly claims: readonly Claim[];
  readonly audit: AuditRecord | undefined;
}

const statusLabels: Record<OkfStatus, string> = {
  draft: "Draft",
  stable: "Stable",
  deprecated: "Deprecated",
};

/** Mirrors `ChapterPage.tsx`'s `auditSummaryOf` — same `AuditRecord` shape, since `GET .../groups/:group` returns it field-for-field identical to `GET .../chapters/:chapter`. */
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
 * A rule-book group as prose, with every rule's citation traceable back to
 * its source — the rule-book counterpart of `ChapterPage`. `GET
 * /api/rulebooks/:slug/groups/:group` mirrors `GET .../chapters/:chapter`
 * field for field on purpose (`handlers/rulebooks.ts`'s module doc), so this
 * page composes the exact same rendering pieces `ChapterPage` does —
 * `ChapterProse`, `AuditBanner`, `SnapshotDialog` — rather than a parallel
 * set. The one thing `ChapterPage` has that this doesn't is the ledger
 * "what Shadow softened" history: there is no rule-book ledger endpoint (the
 * three read routes are list/detail/group only), so that section has
 * nothing to fetch and is left out rather than faked.
 */
export function RulebookGroupPage({
  client,
  slug,
  groupSlug,
  navigate,
}: {
  readonly client: ShadowApiClient;
  readonly slug: string;
  readonly groupSlug: string;
  readonly navigate: (route: Route) => void;
}) {
  const [data, setData] = useState<GroupData | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [snapshotRequest, setSnapshotRequest] = useState<SnapshotRequest | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setData(undefined);
    setError(undefined);
    client
      .getRulebookGroup(slug, groupSlug)
      .then((result) => {
        if (!cancelled) {
          setData({
            group: result.group,
            claims: result.claims?.claims ?? [],
            audit: result.audit,
          });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client, slug, groupSlug]);

  if (error) return <p role="alert">Could not load this group: {error}</p>;
  if (!data) return <p aria-live="polite">Loading group…</p>;

  const claimsByLabel = new Map(data.claims.map((claim) => [claim.label, claim]));
  const auditSummary = data.audit ? auditSummaryOf(data.audit) : undefined;
  const failingLabels = new Set(
    (auditSummary?.findings ?? []).flatMap((f) => (f.label ? [f.label] : [])),
  );

  const isStale =
    data.group.staleAfter !== null &&
    typeof data.group.staleAfter === "string" &&
    new Date(data.group.staleAfter) <= new Date();
  const statusLabel = statusLabels[data.group.status];

  return (
    <div className="page chapter-page">
      <header className="page__header">
        <button
          type="button"
          className="link-back"
          onClick={() => navigate({ name: "rulebook", slug })}
        >
          ← {slug}
        </button>
        <h1>{data.group.title}</h1>
        <div className="chapter-page__meta">
          <span
            className={`chapter-page__status chapter-page__status--${data.group.status}`}
            aria-label={`Status: ${statusLabel}`}
          >
            {statusLabel}
          </span>
          {isStale && (
            <span className="chapter-page__stale" role="alert">
              Stale since {data.group.staleAfter}
            </span>
          )}
        </div>
      </header>

      {auditSummary && <AuditBanner audit={auditSummary} />}

      <ChapterProse
        body={data.group.body}
        claims={data.claims}
        failingLabels={failingLabels}
        onCiteClick={(claim) => {
          // Same "derived claims cite other claims, not a source" branch
          // `ChapterPage` uses (D19) — a rule can be derived from other
          // rules in its own group the same way a chapter claim can.
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
          // Rule-book evidence lives in its own store (`rulebookEvidenceStore`)
          // — `SnapshotDialog`'s `scope="rulebook"` below routes this
          // request to `getRulebookSource`/`getRulebookSnapshot` rather than
          // the volume-scoped pair `ChapterPage` uses.
          const span = claim.evidence[0];
          if (span) {
            setSnapshotRequest({
              kind: "sourced",
              label: claim.label,
              sourceId: span.sourceId,
              snapshotHash: span.snapshotHash,
              selector: span.selector,
              anchorStatus: span.anchorStatus,
            });
          }
        }}
      />

      <SnapshotDialog
        request={snapshotRequest}
        slug={slug}
        scope="rulebook"
        client={client}
        onClose={() => setSnapshotRequest(undefined)}
      />
    </div>
  );
}
