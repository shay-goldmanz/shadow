/**
 * The second and only other legitimate origin of a source record (D19,
 * D23): a session transcript. `@shadow/evidence` already implements the
 * mechanism (`EvidenceStore.putSourceFromTranscript`, taking a
 * `SessionTranscriptWitness`) — this module is the ready-made path
 * `@shadow/agent` (T3.3, Shadow) calls when the operator says something
 * Shadow wants to record as an `operator`-kind claim's citation, so T3.3
 * does not have to re-derive `SourceMetadata` defaults or the witness
 * shape itself.
 *
 * `authority.tier` is always `"primary"`: the operator is, by construction,
 * the subject writing about their own beliefs — there is no more direct
 * relationship to the subject than that. `volatility` is always `"never"`:
 * a transcript is an immutable record of what was actually said: it cannot
 * drift, unlike a web page.
 */

import type { VolumeSlug } from "@shadow/core";
import type { EvidenceStore, SourceMetadata, SourceRecord } from "@shadow/evidence";

export interface RecordSessionTranscriptSourceOptions {
  readonly sessionId: string;
  /** Exactly what the operator said in this turn — the text an `operator`-kind claim's `[^~label]` will later cite an exact substring of. */
  readonly turnText: string;
  /** ISO-8601. Defaults to now. */
  readonly capturedAt?: string;
  readonly title?: string;
  /** Recorded as `retrieval.agent`. Defaults to `"@shadow/agent/shadow-chat"`. */
  readonly agent?: string;
}

/**
 * Turn one session turn into a witnessed source record, via
 * `EvidenceStore.putSourceFromTranscript` — never a hand-assembled
 * `SourceRecord` (D23). The resulting record's `retrieval.transport` is
 * always `"session"`, which is what `@shadow/evidence`'s
 * operator-claim-verification check requires of any source an `operator`
 * claim cites.
 */
export async function recordSessionTranscriptSource(
  store: EvidenceStore,
  volume: VolumeSlug,
  options: RecordSessionTranscriptSourceOptions,
): Promise<SourceRecord> {
  const metadata: SourceMetadata = {
    title: options.title ?? `Session transcript ${options.sessionId}`,
    agent: options.agent ?? "@shadow/agent/shadow-chat",
    query: null,
    authority: {
      tier: "primary",
      rationale: "The operator's own words, from the session transcript they are the subject of.",
    },
    volatility: "never",
  };
  return store.putSourceFromTranscript(
    volume,
    {
      sessionId: options.sessionId,
      transcriptText: options.turnText,
      capturedAt: options.capturedAt ?? new Date().toISOString(),
    },
    metadata,
  );
}
