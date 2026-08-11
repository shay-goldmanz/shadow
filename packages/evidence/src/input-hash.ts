/**
 * `inputHash` (D20): the memoization key Tier 2 uses to decide whether a
 * claim needs re-judging at all.
 *
 * `docs/EVIDENCE.md`:
 * `inputHash = sha256(decontextualized ‖ evidence[].exact ‖ snapshotHash ‖ supports)`
 *
 * Deliberately excludes `Claim.text` (the sentence as written): D20's whole
 * point is that rewriting a sentence's prose without changing its claim's
 * meaning or evidence re-runs nothing. `decontextualized` is what actually
 * changes when the *meaning* changes, so it's what's hashed instead.
 *
 * **One ambiguity resolved here, flagged for spec review.** The formula as
 * written treats `evidence[].exact` and `snapshotHash` as two separate
 * top-level ingredients — which only unambiguously makes sense for a claim
 * with exactly one evidence entry pinning exactly one snapshot. A claim can
 * have multiple `evidence[]` entries from *different* sources (e.g. two
 * corroborating citations), each pinning its own `snapshotHash`; a single
 * external `snapshotHash` parameter can't represent that, and would also
 * leave a source-drift on the *second* citation invisible to the hash if
 * only the first citation's hash were used. Implemented instead as: each
 * evidence entry contributes `exact ‖ snapshotHash` as a pair, so any
 * entry's source drifting changes the hash regardless of position, and the
 * common single-citation case reduces to exactly the spec's formula.
 *
 * **Parts are joined by JSON-encoding the whole structure, not by a
 * separator character (Wave 1 review, I-3 / amendment 8).** A single-space
 * join is not injective: `{decontextualized: "Linear uses", exact: "grid"}`
 * and `{decontextualized: "Linear", exact: "uses grid"}` hash identically,
 * because nothing marks where one field ends and the next begins. Since
 * this is D20's memoization key, a colliding pair means Tier 2 would
 * silently skip re-judging a claim whose meaning actually changed.
 * `JSON.stringify` over a structured array escapes every field
 * unambiguously (any character, including whatever a fixed separator might
 * have been, is safe inside a JSON string), so two different inputs can
 * never serialize to the same string — the join is injective by
 * construction, not by hoping a chosen separator never occurs in prose.
 *
 * **`supports` carries each supporting claim's own `inputHash`, not its
 * label (Wave 2 review, I-1).** The spec's formula names `supports[]`, and
 * the first implementation read that as "the labels a derived claim's
 * `supports[]` field lists" — but a derived claim's judged input
 * (`entailment-relevance.ts`'s `supportingClaimsFor`) is the supporting
 * claims' *decontextualized text*, not their labels. Hashing labels means a
 * supporting claim's text can change completely (a snapshot re-cited from
 * "4px" to "8px", say) while the label stays `lin-4px` — and a derived
 * claim built on it would keep the exact same `inputHash`, so Tier 2 would
 * silently skip re-judging it and it would keep whatever stale verdict it
 * had. This is amendment 2's identical problem (evidence hashed by exact
 * text, not by the source it happened to share a hash with) recurring one
 * level up, on the claim graph instead of the evidence list. The caller
 * (`checks/audit.ts`'s `computeInputHashes`) resolves each `supports[]`
 * label to that claim's own already-computed `inputHash` before calling
 * this function — which is itself built the same way, so a change ripples
 * transitively through a whole chain of `derived` claims, not just the
 * immediate parent.
 *
 * **`supports` stays typed `readonly string[]`, not narrowed to
 * `Sha256Digest[]`, deliberately.** `computeInputHashes` is the one caller
 * inside this package that matters for memoization correctness, and it
 * always passes each target's own `inputHash` (a `Sha256Digest`, itself a
 * `string`). But `@shadow/agent`'s `chapter-draft.ts` also calls
 * `computeInputHash` directly, at *draft* time, before a claim has ever been
 * judged — passing the raw `supports[]` labels there is harmless (not a
 * bug to chase down in a package this task doesn't own): every freshly-drafted
 * claim's `verification.status` is `"unchecked"`, which Tier 2's
 * memoization check treats as "never judged, always re-judge" regardless
 * of what the draft-time `inputHash` happens to be, so nothing there is
 * ever trusted for a real memoization decision. Narrowing the type would
 * force that caller to fabricate hashes it cannot correctly produce (it has
 * no other claims' `inputHash`es in scope, only labels) for no behavioral
 * benefit.
 */

import { type Sha256Digest, sha256Of } from "./digest.ts";

export interface InputHashEvidence {
  readonly exact: string;
  readonly snapshotHash: Sha256Digest;
}

export interface InputHashInput {
  readonly decontextualized: string;
  /** In `evidence[]` order — order is meaningful, not a set. */
  readonly evidence: readonly InputHashEvidence[];
  /** For the memoization-correct path (`checks/audit.ts`'s `computeInputHashes`): each supporting claim's own `inputHash` (`derived` only), in `supports[]` order — never the raw label (I-1; see module doc). Typed `readonly string[]`, not `Sha256Digest[]`, so a caller computing a pre-judging placeholder hash (see module doc) isn't forced to fabricate one. */
  readonly supports: readonly string[];
}

/** Compute the `inputHash` memoization key for one claim's current verification inputs. */
export function computeInputHash(input: InputHashInput): Sha256Digest {
  const canonical = JSON.stringify([
    input.decontextualized,
    input.evidence.map((e) => [e.exact, e.snapshotHash]),
    input.supports,
  ]);
  return sha256Of(canonical);
}
