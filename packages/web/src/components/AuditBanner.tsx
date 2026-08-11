import { Badge } from "./Badge.tsx";

export interface AuditFindingView {
  readonly code: string;
  readonly message: string;
  readonly label?: string;
}

/**
 * Normalized audit summary `AuditBanner` renders. Deliberately NOT either
 * wire shape directly (`../api/types.ts`'s `AuditRecord` from `GET
 * .../chapters/:chapter`, or the chat SSE `audit` event's `{ passed,
 * repairs }`) — those are two genuinely different payloads (see that
 * file's module doc), and forcing them through one type is exactly the
 * "guessed shape that can't fit either side" this reconciliation fixes.
 * Each call site builds this from whichever real shape it has.
 */
export interface AuditSummary {
  readonly passed: boolean;
  /** Per-check issues, when known. Chat's `audit` event doesn't carry these (only `passed`/`repairs` — see `chapter.rejected` for the issue list on a rejected chapter); `GET .../chapters/:chapter`'s `AuditRecord` does. */
  readonly findings?: readonly AuditFindingView[];
  readonly narrativeRatio?: number;
}

/**
 * A failing audit is a first-class state, not an error toast (`docs/API.md`:
 * "a successful request with a failing verdict"). This renders inline,
 * always, and names every failing claim so the operator can act on it.
 */
export function AuditBanner({ audit }: { readonly audit: AuditSummary }) {
  const { passed, findings } = audit;

  return (
    <section
      className={`audit-banner audit-banner--${passed ? "pass" : "fail"}`}
      aria-live="polite"
    >
      <div className="audit-banner__headline">
        <Badge tone={passed ? "sage" : "red"}>{passed ? "Audit passed" : "Audit failed"}</Badge>
        {!passed && findings && (
          <span className="audit-banner__count">
            {findings.length} claim{findings.length === 1 ? "" : "s"} need attention
          </span>
        )}
      </div>

      {!passed && findings && findings.length > 0 && (
        <ul className="audit-banner__findings">
          {findings.map((finding) => (
            <li
              key={`${finding.label ?? "chapter"}-${finding.code}`}
              className="audit-banner__finding"
            >
              {finding.label && (
                <a href={`#claim-${finding.label}`} className="audit-banner__claim-link">
                  [^{finding.label}]
                </a>
              )}
              <span className="audit-banner__check">{finding.code}</span>
              <p className="audit-banner__message">{finding.message}</p>
            </li>
          ))}
        </ul>
      )}

      {audit.narrativeRatio !== undefined && (
        <dl className="audit-banner__metrics">
          <div>
            <dt>Narrative ratio</dt>
            <dd>{Math.round(audit.narrativeRatio * 100)}%</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
