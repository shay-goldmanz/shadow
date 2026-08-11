/**
 * @shadow/evidence — the chain of evidence (D9).
 *
 * Domain model, content-addressed store, and Tier 0 checks for
 * `docs/EVIDENCE.md`. Pure and offline: no LLM, no network, no API key.
 * Tier 2 (LLM-judged) checks are T2.4/T2.5, built on the ports in
 * `ports.ts` against `@shadow/model` — nothing in this package imports an
 * AI SDK.
 *
 * **Invariant this package enforces:** the entire completeness property and
 * the entire anti-fabrication property (D20) — C1a structural completeness,
 * C2 source integrity + the numeric sub-check, and operator-claim
 * exact-quote verification — run with no model and are fully testable in
 * `bun test`.
 */

// ---- domain model -----------------------------------------------------------

export type {
  AnchorStatus,
  ArchivedCopy,
  AuditCompletedEvent,
  AuthorityInfo,
  AuthorityTier,
  ChapterAuditStatus,
  Claim,
  ClaimKind,
  ClaimLabelRetiredEvent,
  ClaimRestatedEvent,
  ClaimSidecar,
  ClaimVerifiedEvent,
  EvidenceManifest,
  EvidenceRelation,
  EvidenceSpan,
  LedgerEvent,
  NarrativeSummary,
  OvergeneralizationRisk,
  Relevance,
  RetrievalInfo,
  RetrievalTransport,
  SnapshotInfo,
  SourceDriftedEvent,
  SourceRecord,
  SourceRetrievedEvent,
  TextPositionSelector,
  TextQuoteSelector,
  TimeState,
  Verification,
  VerificationStatus,
  Volatility,
} from "./types.ts";

// ---- ids and digests --------------------------------------------------------

export type { Sha256Digest } from "./digest.ts";
export { digestHex, isValidDigest, sha256Of, toDigest } from "./digest.ts";
export type { ClaimId, SourceId } from "./ids.ts";
export {
  isValidClaimId,
  isValidSourceId,
  newClaimId,
  newSourceId,
  toClaimId,
  toSourceId,
} from "./ids.ts";

// ---- normalization (nfc-ws-v1, D16) ----------------------------------------

export type { SnapshotDigests } from "./normalize.ts";
export { computeSnapshotDigests, NORMALIZATION_ALGORITHM, normalizeNfcWs } from "./normalize.ts";

// ---- anchoring resolver -----------------------------------------------------

export type {
  AnchoringConfig,
  AnchorResolution,
  DisambiguationWeights,
  ResolveOptions,
} from "./anchoring.ts";
export { DEFAULT_ANCHORING_CONFIG, resolveSelector } from "./anchoring.ts";

// ---- footnote parsing (D18) -------------------------------------------------

export type {
  FootnoteKind,
  FootnoteMarker,
  MalformedFootnote,
  ParsedFootnotes,
} from "./footnotes.ts";
export { KEBAB_LABEL_PATTERN, parseFootnoteMarkers } from "./footnotes.ts";

// ---- numeric sub-check -------------------------------------------------------

export type { Numeral, NumeralCheckOutcome, NumeralClass, NumericCheckResult } from "./numeric.ts";
export {
  checkNumericConsistency,
  DEFAULT_NUMERIC_TOLERANCE,
  extractCheckableNumerals,
  extractNumerals,
} from "./numeric.ts";

// ---- inputHash memoization key (D20) ---------------------------------------

export type { InputHashEvidence, InputHashInput } from "./input-hash.ts";
export { computeInputHash } from "./input-hash.ts";

// ---- edit distance (shared primitive) ---------------------------------------

export { levenshteinDistance } from "./edit-distance.ts";

// ---- Tier 0 checks ------------------------------------------------------------

export type { AuditRecord, Tier0AuditInput, Tier0AuditResult } from "./checks/audit.ts";
export {
  computeInputHashes,
  runTier0Audit,
  TIER0_CHECKS,
} from "./checks/audit.ts";
export type { OperatorVerificationInput } from "./checks/operator-verification.ts";
export { checkOperatorClaims, operatorVerificationCheck } from "./checks/operator-verification.ts";
export type {
  EvidenceLookup,
  SourceIntegrityData,
  SourceIntegrityInput,
} from "./checks/source-integrity.ts";
export { checkSourceIntegrity, sourceIntegrityCheck } from "./checks/source-integrity.ts";
export type { StructuralCompletenessInput } from "./checks/structural-completeness.ts";
export {
  checkStructuralCompleteness,
  structuralCompletenessCheck,
} from "./checks/structural-completeness.ts";
export type { AuditVerdict, CheckIssue, CheckOutcome, EvidenceCheck } from "./checks/types.ts";
export { runChecks, verdictFromOutcomes } from "./checks/types.ts";

// ---- store -------------------------------------------------------------------

export { EvidenceLayout } from "./layout.ts";
export type { EvidenceStore } from "./store.ts";
export { buildEvidenceLookup, FileSystemEvidenceStore } from "./store.ts";

// ---- witnesses (D23): the only legitimate origins of a source record --------

export type {
  DerivedSource,
  RetrievalWitness,
  SessionTranscriptWitness,
  SourceMetadata,
} from "./witness.ts";
export { deriveSourceFromRetrieval, deriveSourceFromTranscript } from "./witness.ts";

// ---- Tier 2 ports (defined, not implemented — see ports.ts) -----------------

export type {
  CheckWorthinessClassifier,
  CheckWorthinessInput,
  CheckWorthinessVerdict,
  EntailmentCandidate,
  EntailmentInput,
  EntailmentJudge,
  EntailmentVerdict,
  IndexAlignmentChecker,
  IndexAlignmentInput,
  IndexAlignmentVerdict,
  RelevanceClassifier,
  RelevanceInput,
  RelevanceVerdict,
} from "./ports.ts";

// ---- errors -------------------------------------------------------------------

export {
  ClaimSidecarNotFoundError,
  InvalidDigestError,
  InvalidIdError,
  LedgerCorruptError,
  ShadowEvidenceError,
  SnapshotNotFoundError,
  SourceNotFoundError,
} from "./errors.ts";
