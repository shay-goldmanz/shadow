/**
 * `ResearchRun` — the in-memory witness ledger for one `research()` call.
 *
 * This is the load-bearing structure behind the report's "structurally
 * hard to bypass the transport" claim. The *only* way an entry ever enters
 * `fetched` is `recordFetch`, which `retrieval-tools.ts`'s `fetch` tool
 * calls after a real `RetrievalTransport.fetchPage` and a real
 * `EvidenceStore.putSourceFromRetrieval` — there is no other method that
 * inserts one. `validateFindings` then refuses to mint a `Finding` whose
 * citation names a `SourceId` not present in `fetched`, or a `quote` that
 * is not an actual substring of that source's normalized text. A
 * tool-agent cannot walk around this by, say, fabricating a `sourceId`
 * string that merely looks plausible: `submit_findings`
 * (`retrieval-tools.ts`) is the only path into `submit`, and `submit` is
 * the only path that can ever grow `ResearchResult.findings`.
 */

import type { SourceId, SourceRecord } from "@shadow/evidence";
import { normalizeNfcWs } from "@shadow/evidence";
import type { Finding } from "./brief.ts";
import { SourceBudgetExceededError, UnboundCitationError } from "./errors.ts";

/** What `recordFetch` stores: the persisted source record plus the normalized text citations are checked against. */
export interface FetchedSourceEntry {
  readonly source: SourceRecord;
  /** `nfc-ws-v1`-normalized extracted text — the same text whose hash is `source.snapshot.normalizedTextSha256`, so a quote that resolves here is a quote that will also resolve against the persisted snapshot. */
  readonly normalizedText: string;
}

/**
 * Pure validation: does every citation in every candidate finding resolve
 * against something actually recorded in `fetched`? Exported (not just
 * used internally by the `submit_findings` tool) so tests can exercise the
 * refusal directly, without going through a full agentic session.
 *
 * @throws {UnboundCitationError} on the first finding with zero citations,
 *   a citation naming an unfetched `sourceId`, or a `quote` that is not an
 *   exact substring of that source's normalized text.
 */
export function validateFindings(
  candidates: readonly Finding[],
  fetched: ReadonlyMap<SourceId, FetchedSourceEntry>,
): Finding[] {
  const validated: Finding[] = [];
  for (const candidate of candidates) {
    if (candidate.citations.length === 0) {
      throw new UnboundCitationError(candidate.text, undefined, "no citations");
    }
    for (const citation of candidate.citations) {
      const entry = fetched.get(citation.sourceId);
      if (!entry) {
        throw new UnboundCitationError(
          candidate.text,
          citation.sourceId,
          "this sourceId was never fetched in this research run",
        );
      }
      if (!entry.normalizedText.includes(normalizeNfcWs(citation.quote))) {
        throw new UnboundCitationError(
          candidate.text,
          citation.sourceId,
          "this quote does not appear in the fetched source's extracted text",
        );
      }
    }
    validated.push({ text: candidate.text, citations: candidate.citations });
  }
  return validated;
}

/**
 * The mutable state one `research()` call accumulates: sources it actually
 * fetched (via the transport, always) and findings it has successfully
 * submitted (via `submit_findings`, always validated). A fresh instance per
 * `research()` call — see `web-research-tool-agent.ts`.
 */
export class ResearchRun {
  private readonly fetched = new Map<SourceId, FetchedSourceEntry>();
  private readonly findings: Finding[] = [];

  constructor(private readonly maxSources?: number) {}

  /**
   * Record a real retrieval. Called only from the `fetch` tool handler,
   * after `RetrievalTransport.fetchPage` and `EvidenceStore.putSourceFromRetrieval`
   * both actually ran — see the module doc.
   * @throws {SourceBudgetExceededError} if the brief's `maxSources` is already reached.
   */
  recordFetch(entry: FetchedSourceEntry): void {
    if (this.maxSources !== undefined && this.fetched.size >= this.maxSources) {
      throw new SourceBudgetExceededError(this.maxSources);
    }
    this.fetched.set(entry.source.id, entry);
  }

  getFetched(sourceId: SourceId): FetchedSourceEntry | undefined {
    return this.fetched.get(sourceId);
  }

  get fetchedCount(): number {
    return this.fetched.size;
  }

  get sources(): readonly SourceRecord[] {
    return [...this.fetched.values()].map((entry) => entry.source);
  }

  get findingCount(): number {
    return this.findings.length;
  }

  /**
   * Validate and, if every citation resolves, accept a batch of findings
   * atomically — either the whole batch is bound to real retrievals, or
   * none of it is kept. Called only from the `submit_findings` tool
   * handler.
   * @throws {UnboundCitationError} — see `validateFindings`.
   */
  submit(candidates: readonly Finding[]): void {
    const validated = validateFindings(candidates, this.fetched);
    this.findings.push(...validated);
  }

  get findingsSoFar(): readonly Finding[] {
    return [...this.findings];
  }
}
