/**
 * Generate OKF-conformant `log.md` — a chronological history of changes
 * for a single volume's directory (OKF v0.2 §9).
 *
 * Generated from the evidence ledger: date-grouped entries, newest first.
 * A human-readable projection of the append-only ledger, not a replacement
 * for it — the ledger remains the authoritative record.
 *
 * Zero LLM calls, zero network calls.
 */

import type { LedgerEvent } from "@shadow/evidence";

/** Generate the `log.md` content for a volume from its ledger events. */
export function generateVolumeLogMd(events: readonly LedgerEvent[]): string {
  if (events.length === 0) {
    return `# Directory Update Log\n\n_No changes recorded yet._\n`;
  }

  // Group events by date (YYYY-MM-DD), newest first. Each event already
  // carries an ISO 8601 `ts` timestamp.
  const byDate = new Map<string, LedgerEvent[]>();

  // Process events in reverse (oldest to newest) so within each date
  // group, events are listed chronologically. The date groups themselves
  // are rendered newest-first.
  const reversed = [...events].reverse();
  for (const event of reversed) {
    const date = event.ts.slice(0, 10); // "YYYY-MM-DD"
    let group = byDate.get(date);
    if (!group) {
      group = [];
      byDate.set(date, group);
    }
    group.push(event);
  }

  // Sort dates newest-first
  const sortedDates = [...byDate.keys()].sort().reverse();

  let md = `# Directory Update Log\n\n`;

  for (const date of sortedDates) {
    md += `## ${date}\n\n`;

    const group = byDate.get(date)!;
    for (const event of group) {
      const line = formatEvent(event);
      if (line) {
        md += `* ${line}\n`;
      }
    }

    md += "\n";
  }

  return md;
}

/**
 * Generate the bundle-root `log.md` — date-grouped history spanning
 * every volume. Concatenates volume-level event groups into a single
 * chronological view.
 */
export function generateRootLogMd(allVolumeEvents: readonly (readonly LedgerEvent[])[]): string {
  // Collect all events across all volumes, sort by ts descending
  const allEvents = allVolumeEvents.flat().slice();
  allEvents.sort((a, b) => {
    // newest first
    if (a.ts > b.ts) return -1;
    if (a.ts < b.ts) return 1;
    return 0;
  });

  if (allEvents.length === 0) {
    return `# Directory Update Log\n\n_No changes recorded yet._\n`;
  }

  const byDate = new Map<string, LedgerEvent[]>();
  for (const event of allEvents) {
    const date = event.ts.slice(0, 10);
    let group = byDate.get(date);
    if (!group) {
      group = [];
      byDate.set(date, group);
    }
    group.push(event);
  }

  const sortedDates = [...byDate.keys()].sort().reverse();
  let md = `# Directory Update Log\n\n`;

  for (const date of sortedDates) {
    md += `## ${date}\n\n`;

    const group = byDate.get(date)!;
    for (const event of group) {
      const line = formatEvent(event);
      if (line) {
        md += `* ${line}\n`;
      }
    }
    md += "\n";
  }

  return md;
}

/** Render a single ledger event as a log.md bullet entry. */
function formatEvent(event: LedgerEvent): string | null {
  switch (event.event) {
    case "source.retrieved":
      return `**Addition**: Retrieved source "${event.sourceId}" (hash: ${event.normalizedTextSha256}).`;

    case "claim.verified":
      return `**Verification**: Claim ${event.claimId} — ${event.status}${
        event.inputHash ? ` (input: ${event.inputHash})` : ""
      }.`;

    case "claim.restated":
      return `**Update**: Claim ${event.claimId} in chapter "${event.chapter}" was${
        event.outcome === "applied" ? "" : " NOT"
      } restated${event.outcome === "escalated" ? " (escalated for operator review)" : ""}. Levenshtein distance: ${event.levenshtein}.`;

    case "source.drifted":
      return `**Update**: Source "${event.sourceId}" drifted (${event.invalidatedClaims} claim(s) affected).`;

    case "audit.completed":
      return `**Verification**: Audit of chapter "${event.chapter}" — ${event.result === "pass" ? "PASSED" : "FAILED"}. Completeness: ${event.completeness}, narrative ratio: ${event.narrativeRatio}.`;

    case "claim.label.retired":
      return `**Deprecation**: Label "${event.label}" (claim ${event.claimId}) retired from chapter "${event.chapter}".`;

    default: {
      // Exhaustiveness: log.md is a projection; unknown future event types
      // should render as a generic entry rather than being silently dropped.
      const unknown = event as { event: string; ts: string };
      return `**Update**: ${unknown.event} at ${unknown.ts}.`;
    }
  }
}
