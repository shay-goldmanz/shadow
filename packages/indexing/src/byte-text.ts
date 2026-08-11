/**
 * UTF-8 byte <-> JS string helpers.
 *
 * `index.json` spans are documented as *byte* offsets (`docs/INDEXING.md`),
 * not JS string (UTF-16 code unit) indices. Any chapter body containing
 * non-ASCII text (accents, CJK, emoji) makes those two disagree, so byte
 * arithmetic always goes through here rather than through `string.length`
 * or `string.slice`.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Encode a string to its UTF-8 bytes. */
export function toBytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Decode UTF-8 bytes back to a string. */
export function bytesToText(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** The UTF-8 byte length of a string. */
export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** Decode the byte range `[start, end)` of `bytes` back to a string. */
export function sliceBytesToText(bytes: Uint8Array, start: number, end: number): string {
  return decoder.decode(bytes.subarray(start, end));
}
