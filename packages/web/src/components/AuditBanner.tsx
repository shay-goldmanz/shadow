import type { AuditResult } from "../api/types.ts";
import { Badge } from "./Badge.tsx";

/**
 * A failing audit is a first-class state, not an error toast (docs/API.md:
 * "a successful request with a failing verdict"). This renders inline,
 * always, and names every failing claim so the operator can act on it.
 */
export function AuditBanner({ audit }: { readonly audit: AuditResult }) {
  const passed = audit.verdict === "pass";

  return (
    <section
      className={`audit-banner audit-banner--${passed ? "pass" : "fail"}`}
      aria-live="polite"
    >
      <div className="audit-banner__headline">
        <Badge tone={passed ? "sage" : "red"}>{passed ? "Audit passed" : "Audit failed"}</Badge>
        {!passed && (
          <span className="audit-banner__count">
            {audit.findings.length} claim{audit.findings.length === 1 ? "" : "s"} need attention
          </span>
        )}
      </div>

      {!passed && audit.findings.length > 0 && (
        <ul className="audit-banner__findings">
          {audit.findings.map((finding) => (
            <li key={`${finding.claim}-${finding.check}`} className="audit-banner__finding">
              <a href={`#claim-${finding.claim}`} className="audit-banner__claim-link">
                [^{finding.claim}]
              </a>
              <span className="audit-banner__check">{finding.check}</span>
              <p className="audit-banner__message">{finding.message}</p>
            </li>
          ))}
        </ul>
      )}

      {(audit.narrativeRatio !== undefined || audit.extractiveness !== undefined) && (
        <dl className="audit-banner__metrics">
          {audit.narrativeRatio !== undefined && (
            <div>
              <dt>Narrative ratio</dt>
              <dd>{Math.round(audit.narrativeRatio * 100)}%</dd>
            </div>
          )}
          {audit.extractiveness !== undefined && (
            <div>
              <dt>Extractiveness</dt>
              <dd>{Math.round(audit.extractiveness * 100)}%</dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}
