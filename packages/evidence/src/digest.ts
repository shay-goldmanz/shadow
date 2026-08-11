/**
 * `sha256:<hex>` digests (RFC 6920 `ni:`-style self-describing identifiers,
 * per D16), used for both `payloadSha256`/`normalizedTextSha256` on source
 * records and `inputHash` on verifications. One hashing primitive so every
 * digest in the package is computed and formatted identically.
 */

import { InvalidDigestError } from "./errors.ts";

declare const digestBrand: unique symbol;
/** A validated `sha256:<64 hex chars>` digest. Construct via `sha256Of`/`toDigest`. */
export type Sha256Digest = string & { readonly [digestBrand]: true };

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** SHA-256 over `input` (a string, encoded UTF-8, or raw bytes), formatted as `sha256:<hex>`. */
export function sha256Of(input: string | Uint8Array): Sha256Digest {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return `sha256:${hasher.digest("hex")}` as Sha256Digest;
}

/**
 * The bare hex portion of a digest — this is the content-addressed snapshot
 * filename. Re-validates `digest` even though its type is already branded:
 * the brand is erased at runtime and can be defeated by an unsafe cast or a
 * value deserialized straight from JSON (`sidecar.evidence[].snapshotHash`
 * loaded off disk, for instance) — this is one of the join sites where a
 * forged value would otherwise flow straight into a filesystem path (see
 * `layout.ts`'s `snapshotPath`, and `docs/DECISIONS.md` D23/the Wave 1
 * review's C-3 finding). @throws {InvalidDigestError}
 */
export function digestHex(digest: Sha256Digest): string {
  return toDigest(digest).slice("sha256:".length);
}

/** Validate a raw string as a digest and brand it. @throws {InvalidDigestError} */
export function toDigest(input: string): Sha256Digest {
  if (!DIGEST_PATTERN.test(input)) {
    throw new InvalidDigestError(input);
  }
  return input as Sha256Digest;
}

/** Type-guarding predicate form of `toDigest`, for filtering untrusted input without try/catch. */
export function isValidDigest(input: string): input is Sha256Digest {
  return DIGEST_PATTERN.test(input);
}
