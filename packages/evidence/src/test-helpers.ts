/**
 * Test-only fixture builders, not part of the public surface (not
 * re-exported from `index.ts`). Every field has a sensible default so a
 * test only has to override what it's actually testing, matching the
 * pattern in `@shadow/core`'s `test-helpers.ts`.
 */

import { expect } from "bun:test";
import { type Sha256Digest, sha256Of, toDigest } from "./digest.ts";
import { type ClaimId, newClaimId, newSourceId, type SourceId } from "./ids.ts";
import type {
  Claim,
  ClaimSidecar,
  EvidenceSpan,
  SourceRecord,
  TextQuoteSelector,
  Verification,
} from "./types.ts";
import type { RetrievalWitness, SessionTranscriptWitness, SourceMetadata } from "./witness.ts";

let counter = 0;
/** Deterministic, monotonically increasing timestamp so minted ids sort predictably within a test. */
function nextTime(): number {
  counter += 1;
  return 1_700_000_000_000 + counter;
}

export const FIXTURE_SNAPSHOT_HASH: Sha256Digest = toDigest(`sha256:${"1".repeat(64)}`);

export function fixtureSourceId(): SourceId {
  return newSourceId(nextTime());
}

export function fixtureClaimId(): ClaimId {
  return newClaimId(nextTime());
}

export function makeSelector(
  partial: Partial<TextQuoteSelector> & { exact: string },
): TextQuoteSelector {
  return { type: "TextQuoteSelector", ...partial };
}

export function makeSource(overrides: Partial<SourceRecord> = {}): SourceRecord {
  const normalizedTextSha256 =
    overrides.snapshot?.normalizedTextSha256 ?? sha256Of("fixture snapshot text");
  return {
    schemaVersion: "1.0",
    id: fixtureSourceId(),
    url: "https://example.com/article",
    finalUrl: "https://example.com/article",
    title: "Example Article",
    author: null,
    publishedAt: null,
    retrieval: {
      retrievedAt: new Date(nextTime()).toISOString(),
      agent: "@shadow/research/web-tool-agent@0.1.0",
      transport: "live",
      query: "example",
      httpStatus: 200,
      contentType: "text/html",
    },
    snapshot: {
      path: `snapshots/${normalizedTextSha256.slice("sha256:".length)}.txt`,
      payloadSha256: sha256Of("raw payload bytes"),
      normalizedTextSha256,
      normalization: "nfc-ws-v1",
      chars: 21,
    },
    authority: { tier: "primary", rationale: "First-party publisher." },
    volatility: "slow-changing",
    ...overrides,
  };
}

export function makeEvidenceSpan(overrides: Partial<EvidenceSpan> = {}): EvidenceSpan {
  return {
    sourceId: overrides.sourceId ?? fixtureSourceId(),
    snapshotHash: overrides.snapshotHash ?? FIXTURE_SNAPSHOT_HASH,
    selector: overrides.selector ?? makeSelector({ exact: "the cited text" }),
    relation: overrides.relation ?? "supports",
    anchorStatus: overrides.anchorStatus ?? "anchored",
    ...overrides,
  };
}

export function makeVerification(overrides: Partial<Verification> = {}): Verification {
  return {
    status: "unchecked",
    inputHash: sha256Of("fixture-input-hash-seed"),
    ...overrides,
  };
}

export function makeClaim(overrides: Partial<Claim> & { label: string }): Claim {
  return {
    id: fixtureClaimId(),
    kind: "sourced",
    text: "A claim, as written.",
    decontextualized: "A claim, as written.",
    checkRequired: true,
    evidence: [],
    supports: [],
    verification: makeVerification(),
    ...overrides,
  };
}

/** A fixture `RetrievalWitness` (D23) — what a real fetch would have produced. */
export function makeRetrievalWitness(overrides: Partial<RetrievalWitness> = {}): RetrievalWitness {
  return {
    requestedUrl: "https://example.com/article",
    finalUrl: "https://example.com/article",
    httpStatus: 200,
    contentType: "text/html",
    bytes: new TextEncoder().encode("<html><body>fixture raw bytes</body></html>"),
    extractedText: "Every measurement in the sidebar is a multiple of four.",
    retrievedAt: new Date(nextTime()).toISOString(),
    transport: "live",
    ...overrides,
  };
}

/** A fixture `SessionTranscriptWitness` (D19/D23) — what a real transcript capture would have produced. */
export function makeSessionTranscriptWitness(
  overrides: Partial<SessionTranscriptWitness> = {},
): SessionTranscriptWitness {
  return {
    sessionId: "sess_fixture",
    transcriptText: "Operator: I really prefer borders over drop shadows for cards.",
    capturedAt: new Date(nextTime()).toISOString(),
    ...overrides,
  };
}

/** Fixture editorial metadata to pair with a witness when calling `putSourceFromRetrieval`/`putSourceFromTranscript`. */
export function makeSourceMetadata(overrides: Partial<SourceMetadata> = {}): SourceMetadata {
  return {
    title: "Example Article",
    author: null,
    publishedAt: null,
    agent: "@shadow/research/web-tool-agent@0.1.0",
    query: "example",
    authority: { tier: "primary", rationale: "First-party publisher." },
    volatility: "slow-changing",
    ...overrides,
  };
}

export function makeSidecar(overrides: Partial<ClaimSidecar> = {}): ClaimSidecar {
  return {
    schemaVersion: "1.0",
    chapter: "example-chapter",
    chapterTextSha256: sha256Of("fixture chapter text"),
    claims: [],
    ...overrides,
  };
}

type ErrorConstructor<E> = new (...args: any[]) => E;

/**
 * Await `promise`, assert it rejects, and assert the rejection is an
 * instance of `ctor`. Returns the rejection. Sidesteps oxlint's type-aware
 * `await-thenable` rule tripping on `expect(promise).rejects.toBeInstanceOf(...)`
 * — see `@shadow/core`'s `test-helpers.ts` for the same pattern and why.
 */
export async function expectRejection<E>(
  promise: Promise<unknown>,
  ctor: ErrorConstructor<E>,
): Promise<E> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ctor);
    return error as E;
  }
  return expect.unreachable(`expected promise to reject with ${ctor.name}, but it resolved`);
}
