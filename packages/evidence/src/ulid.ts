/**
 * ULID generation, duplicated in shape from `@shadow/indexing`'s `ulid.ts`
 * (chapter identity, D13) rather than shared, because the two packages are
 * not allowed to depend on each other and this is ~30 dependency-free
 * lines. Implements the standard ULID layout: 48-bit millisecond timestamp
 * + 80-bit randomness, both Crockford Base32 encoded, for a 26-character,
 * lexicographically sortable identifier. See https://github.com/ulid/spec.
 */

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function encodeTime(timeMs: number, length: number): string {
  let remaining = timeMs;
  let output = "";
  for (let i = length - 1; i >= 0; i--) {
    output = CROCKFORD_ALPHABET[remaining % 32] + output;
    remaining = Math.floor(remaining / 32);
  }
  return output;
}

function encodeRandom(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let output = "";
  for (const byte of bytes) {
    output += CROCKFORD_ALPHABET[byte % 32];
  }
  return output;
}

/** Mint a new ULID. `now` is injectable for deterministic tests; defaults to the current time. */
export function generateUlid(now: number = Date.now()): string {
  return encodeTime(now, 10) + encodeRandom(16);
}

/** Structural validation only (26-char Crockford Base32) — does not verify the timestamp is sane. */
export function isValidUlid(value: unknown): value is string {
  return typeof value === "string" && ULID_PATTERN.test(value);
}
