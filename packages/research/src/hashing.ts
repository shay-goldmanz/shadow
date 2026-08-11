/**
 * SHA-256 hashing, formatted the way every digest in the evidence schema
 * is formatted (`docs/EVIDENCE.md`): `"sha256:<hex>"`. Matches the
 * convention already established in `@shadow/indexing`'s `hashing.ts`,
 * kept independent here rather than imported — this package must not
 * depend on another pillar (see `index.ts`).
 */

/** Hash a string (UTF-8 encoded) or raw bytes, returning the lowercase hex digest. */
export function sha256Hex(input: string | Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex");
}

/** Prefix a raw hex digest the way every hash in a source record is formatted. */
export function formatHash(hex: string): string {
  return `sha256:${hex}`;
}

/** `sha256Hex` + `formatHash` in one call — the common case. */
export function hashOf(input: string | Uint8Array): string {
  return formatHash(sha256Hex(input));
}
