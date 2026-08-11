import { Badge } from "./Badge.tsx";

export interface RestatementDetails {
  readonly claim: string;
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  readonly outcome: "applied" | "escalated";
}

/**
 * D9's repair rule restates unsupported claims conservatively rather than
 * deleting them, and requires the operator see what changed and why — this
 * is that surface, used both inline in the chat transcript and in a
 * chapter's evidence history. `escalated` (D21's preservation-bound guard)
 * is shown distinctly: the claim was left unchanged pending the operator's
 * own review, which is the one they most need to notice.
 */
export function RestatementNotice({ restatement }: { readonly restatement: RestatementDetails }) {
  const escalated = restatement.outcome === "escalated";
  return (
    <div className={`restatement-notice restatement-notice--${restatement.outcome}`}>
      <div className="restatement-notice__headline">
        <Badge tone={escalated ? "amber" : "clay"}>
          {escalated ? "Restatement escalated" : "Claim restated"}
        </Badge>
        <span className="restatement-notice__claim">[^{restatement.claim}]</span>
      </div>
      <p className="restatement-notice__reason">{restatement.reason}</p>
      <div className="restatement-notice__diff">
        <p className="restatement-notice__from">
          <span className="label">was</span> {restatement.from}
        </p>
        <p className="restatement-notice__to">
          <span className="label">{escalated ? "proposed" : "now"}</span> {restatement.to}
        </p>
      </div>
      {escalated && (
        <p className="restatement-notice__escalation-note" role="alert">
          This restatement exceeded the preservation bound and was not applied automatically — it
          needs your review.
        </p>
      )}
    </div>
  );
}
