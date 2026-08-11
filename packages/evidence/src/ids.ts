/**
 * Branded, prefixed identifiers for the two entities that get a durable
 * identity in the evidence chain: sources (`src_...`) and claims
 * (`clm_...`), per `docs/EVIDENCE.md`'s schema. Both are ULIDs (D13-style:
 * a 26-char Crockford Base32 string), immutable once minted, never reused.
 */

import { InvalidIdError } from "./errors.ts";
import { generateUlid, isValidUlid } from "./ulid.ts";

declare const sourceIdBrand: unique symbol;
/** A validated `src_<ULID>` source identifier. Construct via `toSourceId`/`newSourceId`. */
export type SourceId = string & { readonly [sourceIdBrand]: true };

declare const claimIdBrand: unique symbol;
/** A validated `clm_<ULID>` claim identifier. Construct via `toClaimId`/`newClaimId`. */
export type ClaimId = string & { readonly [claimIdBrand]: true };

const SOURCE_PREFIX = "src_";
const CLAIM_PREFIX = "clm_";

/** Validate a raw string as a source id and brand it. @throws {InvalidIdError} */
export function toSourceId(input: string): SourceId {
  if (!input.startsWith(SOURCE_PREFIX) || !isValidUlid(input.slice(SOURCE_PREFIX.length))) {
    throw new InvalidIdError("source", input);
  }
  return input as SourceId;
}

/** Validate a raw string as a claim id and brand it. @throws {InvalidIdError} */
export function toClaimId(input: string): ClaimId {
  if (!input.startsWith(CLAIM_PREFIX) || !isValidUlid(input.slice(CLAIM_PREFIX.length))) {
    throw new InvalidIdError("claim", input);
  }
  return input as ClaimId;
}

/** Type-guarding predicate form of `toSourceId`, for filtering untrusted input without try/catch. */
export function isValidSourceId(input: string): input is SourceId {
  return input.startsWith(SOURCE_PREFIX) && isValidUlid(input.slice(SOURCE_PREFIX.length));
}

/** Type-guarding predicate form of `toClaimId`, for filtering untrusted input without try/catch. */
export function isValidClaimId(input: string): input is ClaimId {
  return input.startsWith(CLAIM_PREFIX) && isValidUlid(input.slice(CLAIM_PREFIX.length));
}

/** Mint a new source id. `now` is injectable for deterministic tests. */
export function newSourceId(now?: number): SourceId {
  return (SOURCE_PREFIX + generateUlid(now)) as SourceId;
}

/** Mint a new claim id. `now` is injectable for deterministic tests. */
export function newClaimId(now?: number): ClaimId {
  return (CLAIM_PREFIX + generateUlid(now)) as ClaimId;
}
