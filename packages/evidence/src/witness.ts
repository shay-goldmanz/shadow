/**
 * Witnesses: what a real retrieval or a real session-transcript capture
 * actually produced (D23, `docs/EVIDENCE.md` amendment 6).
 *
 * `ARCHITECTURE.md` promises fabricated citations are "structurally
 * impossible rather than merely discouraged", and D9 says research
 * tool-agents are the only code permitted to originate a source record. The
 * Wave 1 review found this was convention, not structure: `putSource` used
 * to be public API taking a fully-formed `SourceRecord`, so any caller
 * could mint a record claiming `transport: "live"` with a self-consistent
 * snapshot, and every integrity check would pass — because those checks
 * verify *self-consistency*, not *provenance*.
 *
 * Origination now takes a **witness** instead: a structural description of
 * what a genuine retrieval or a genuine transcript capture produces.
 * `EvidenceStore.putSourceFromRetrieval`/`putSourceFromTranscript` derive
 * the `SourceRecord` from one of these plus caller-supplied editorial
 * metadata (`SourceMetadata` below) that no witness could ever contain —
 * there is no public path left that accepts a hand-assembled
 * `SourceRecord`.
 */

import { type Sha256Digest, sha256Of } from "./digest.ts";
import { NORMALIZATION_ALGORITHM, normalizeNfcWs } from "./normalize.ts";
import type { AuthorityInfo, SourceRecord, Volatility } from "./types.ts";

/**
 * What a real retrieval actually produced. Field-for-field aligned with
 * `@shadow/research`'s `FetchedPage` (`requestedUrl`, `finalUrl`,
 * `httpStatus`, `contentType`, `bytes`, `retrievedAt`, `transport`) so a
 * caller only has to add the one field a transport doesn't produce —
 * `extractedText`, from readability-style extraction, which `normalize.ts`'s
 * module doc already assigns to `@shadow/research` (`nfc-ws-v1` step 1) and
 * not to this package — rather than translate field names. This package
 * does not import `@shadow/research`; the two line up by construction, not
 * via a shared supertype, which is deliberate: the dependency only goes one
 * way (research may depend on evidence's exported normalization, not the
 * reverse).
 */
export interface RetrievalWitness {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly httpStatus: number;
  readonly contentType: string | null;
  /** Raw fetched bytes, exactly as received. `snapshot.payloadSha256` hashes this. */
  readonly bytes: Uint8Array;
  /** Already-extracted main-content text (`nfc-ws-v1` step 1, owned by `@shadow/research`). `snapshot.normalizedTextSha256` is derived from this via steps 2-5 (`normalizeNfcWs`). */
  readonly extractedText: string;
  readonly retrievedAt: string;
  readonly transport: "live" | "fixture";
}

/**
 * What a real session-transcript capture actually produced — the *second*
 * and only other legitimate origin of a source record (D19, D23).
 * `transcriptText` is exactly what gets normalized and stored as the
 * snapshot an `operator` claim's evidence selector resolves against; the
 * resulting record's `retrieval.transport` is always `"session"`, which is
 * what `checks/operator-verification.ts` requires (C-1).
 */
export interface SessionTranscriptWitness {
  /** Identifies which chat session this transcript was captured from. Used to synthesize `url`/`finalUrl` (`session:<sessionId>`) — a transcript has no URL of its own. */
  readonly sessionId: string;
  readonly transcriptText: string;
  readonly capturedAt: string;
}

/**
 * Editorial/context fields no witness can supply — genuinely a judgment
 * call by whatever called `putSourceFromRetrieval`/`putSourceFromTranscript`,
 * never inferred from the witness itself.
 */
export interface SourceMetadata {
  readonly title: string;
  readonly author?: string | null;
  readonly publishedAt?: string | null;
  /** Which tool-agent (or "shadow-chat" for a transcript) performed this retrieval. */
  readonly agent: string;
  readonly query?: string | null;
  readonly authority: AuthorityInfo;
  readonly volatility: Volatility;
}

/** The derived record plus the normalized text it pins — `EvidenceStore` writes both (the record via `layout.sourcePath`, the text via `putSnapshot`). */
export interface DerivedSource {
  readonly record: SourceRecord;
  readonly normalizedText: string;
}

/** Pure derivation: retrieval witness + metadata + a minted id -> a `SourceRecord`. No I/O. */
export function deriveSourceFromRetrieval(
  id: SourceRecord["id"],
  witness: RetrievalWitness,
  metadata: SourceMetadata,
): DerivedSource {
  const normalizedText = normalizeNfcWs(witness.extractedText);
  const payloadSha256 = sha256Of(witness.bytes);
  const normalizedTextSha256 = sha256Of(normalizedText);
  const record: SourceRecord = {
    schemaVersion: "1.0",
    id,
    url: witness.requestedUrl,
    finalUrl: witness.finalUrl,
    title: metadata.title,
    author: metadata.author ?? null,
    publishedAt: metadata.publishedAt ?? null,
    retrieval: {
      retrievedAt: witness.retrievedAt,
      agent: metadata.agent,
      transport: witness.transport,
      query: metadata.query ?? null,
      httpStatus: witness.httpStatus,
      contentType: witness.contentType,
    },
    snapshot: {
      path: snapshotRelativePath(normalizedTextSha256),
      payloadSha256,
      normalizedTextSha256,
      normalization: NORMALIZATION_ALGORITHM,
      chars: normalizedText.length,
    },
    authority: metadata.authority,
    volatility: metadata.volatility,
  };
  return { record, normalizedText };
}

/** Pure derivation: session-transcript witness + metadata + a minted id -> a `SourceRecord`, always `transport: "session"`. No I/O. */
export function deriveSourceFromTranscript(
  id: SourceRecord["id"],
  witness: SessionTranscriptWitness,
  metadata: SourceMetadata,
): DerivedSource {
  const normalizedText = normalizeNfcWs(witness.transcriptText);
  const payloadSha256 = sha256Of(witness.transcriptText);
  const normalizedTextSha256 = sha256Of(normalizedText);
  const url = `session:${witness.sessionId}`;
  const record: SourceRecord = {
    schemaVersion: "1.0",
    id,
    url,
    finalUrl: url,
    title: metadata.title,
    author: metadata.author ?? null,
    publishedAt: metadata.publishedAt ?? null,
    retrieval: {
      retrievedAt: witness.capturedAt,
      agent: metadata.agent,
      transport: "session",
      query: metadata.query ?? null,
      httpStatus: null,
      contentType: null,
    },
    snapshot: {
      path: snapshotRelativePath(normalizedTextSha256),
      payloadSha256,
      normalizedTextSha256,
      normalization: NORMALIZATION_ALGORITHM,
      chars: normalizedText.length,
    },
    authority: metadata.authority,
    volatility: metadata.volatility,
  };
  return { record, normalizedText };
}

/** `snapshot.path` is documented (`docs/EVIDENCE.md`) as relative to the evidence dir, e.g. `snapshots/<hex>.txt` — this is *not* the same string as `EvidenceLayout.snapshotPath`, which returns an absolute filesystem path. */
function snapshotRelativePath(normalizedTextSha256: Sha256Digest): string {
  return `snapshots/${normalizedTextSha256.slice("sha256:".length)}.txt`;
}
