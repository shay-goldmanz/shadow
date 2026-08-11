/**
 * `nfc-ws-v1` normalization (`docs/EVIDENCE.md`, "Normalization and
 * anchoring") and the two source digests it feeds (D16).
 *
 * The full five-step pipeline in the spec is:
 *
 * 1. Extract main content (readability-style); discard nav/footer/script/style
 * 2. Unicode NFC normalize
 * 3. Collapse whitespace runs to a single space; line endings to `\n`
 * 4. Trim
 * 5. UTF-8 encode; SHA-256 over those bytes
 *
 * Step 1 is boilerplate/DOM extraction and belongs to whatever fetched the
 * page (`@shadow/research`, which owns the HTTP/HTML transport) — it is not
 * this package's concern, and doing it here would mean adding an HTML
 * parser dependency this package has no other reason to carry. This module
 * owns steps 2–5, applied to text a caller has already extracted, plus the
 * `payloadSha256` digest over the raw fetched bytes (step 5 applied with no
 * normalization at all — "raw bytes, forensics only, never alerts").
 *
 * This is the load-bearing property from D16: two fetches of the same page
 * with different ad slots or rendered timestamps produce different raw
 * bytes (different `payloadSha256`) but, once through extraction and this
 * normalization, the same `normalizedTextSha256` — the digest that actually
 * triggers a staleness alert.
 */

import { type Sha256Digest, sha256Of } from "./digest.ts";

/** The normalization algorithm identifier recorded on every snapshot (`source.snapshot.normalization`). */
export const NORMALIZATION_ALGORITHM = "nfc-ws-v1" as const;

/** Steps 2–4 of `nfc-ws-v1`: NFC normalize, collapse whitespace runs (any line ending) to a single space, trim. */
export function normalizeNfcWs(extractedText: string): string {
  const nfc = extractedText.normalize("NFC");
  // Line endings first (so \r\n / \r don't survive as extra whitespace
  // runs), then collapse every run of whitespace — including the \n we just
  // introduced — to a single space. The spec's step 3 says "collapse
  // whitespace runs to a single space; line endings to \n" as one
  // operation: the *stored* snapshot is single-line-flattened prose
  // suitable for substring/offset matching, not a line-preserving document.
  const lineEndingsNormalized = nfc.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const collapsed = lineEndingsNormalized.replace(/\s+/g, " ");
  return collapsed.trim();
}

/** Result of running the full snapshot digest pipeline over one retrieval. */
export interface SnapshotDigests {
  /** The normalized text — this is exactly what gets written to `snapshots/<hash>.txt`. */
  readonly normalizedText: string;
  /** `sha256:<hex>` over the raw fetched bytes. Forensic only; never triggers staleness (D16). */
  readonly payloadSha256: Sha256Digest;
  /** `sha256:<hex>` over the UTF-8 bytes of `normalizedText`. THE staleness trigger, and the snapshot's content-addressed filename. */
  readonly normalizedTextSha256: Sha256Digest;
  /** `normalizedText.length` — matches `source.snapshot.chars`. */
  readonly chars: number;
}

/**
 * Compute both snapshot digests from raw fetched bytes and the
 * already-extracted main-content text.
 */
export function computeSnapshotDigests(
  rawPayload: string | Uint8Array,
  extractedText: string,
): SnapshotDigests {
  const normalizedText = normalizeNfcWs(extractedText);
  return {
    normalizedText,
    payloadSha256: sha256Of(rawPayload),
    normalizedTextSha256: sha256Of(normalizedText),
    chars: normalizedText.length,
  };
}
