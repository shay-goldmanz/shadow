import type { ChapterSlug, VolumeSlug } from "./slug.ts";

/** OKF v0.2 lifecycle status (OKF §5.4). */
export type OkfStatus = "draft" | "stable" | "deprecated";

/** An OKF actor: who performed an action and when (OKF §7). */
export interface OkfActor {
  readonly by: string;
  readonly at: Date;
}

/**
 * A curated collection: the top-level unit the operator creates and names.
 */
export interface Volume {
  readonly slug: VolumeSlug;
  readonly title: string;
  readonly description: string;
  /** OKF-required concept type (OKF §4.1). */
  readonly type: string;
  /** OKF lifecycle status. Defaults to `"draft"`. */
  readonly status: OkfStatus;
  /** OKF stale-after date. `null` means no staleness gating. */
  readonly staleAfter: Date | null;
  /** OKF `generated` — how the content was produced (OKF §5.2). */
  readonly generated: OkfActor;
  /** OKF `verified` — who confirmed the content. Empty array = unverified (OKF §5.3). */
  readonly verified: readonly OkfActor[];
  /**
   * All frontmatter fields other than those owned by this package or OKF —
   * the volume-level counterpart of `Chapter.frontmatter`. Round-trips
   * losslessly through `VOLUME.md`, including keys this package doesn't
   * own — in particular the `when_to_use` / `not_for` / `keywords` routing
   * signals `@shadow/indexing` attaches for volume-level routing
   * (`docs/INDEXING.md`). This package never inspects, validates, or drops
   * keys it doesn't own, for the same reason it doesn't for chapters.
   */
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Input to `VolumeStore.createVolume`. */
export interface VolumeInput {
  readonly slug: VolumeSlug;
  readonly title: string;
  /** Defaults to `""` if omitted. */
  readonly description?: string;
  /** OKF type. Defaults to `"Concept"` if omitted. */
  readonly type?: string;
  /** OKF status. Defaults to `"draft"` if omitted. */
  readonly status?: OkfStatus;
  /** OKF stale-after date. Defaults to `null` if omitted. */
  readonly staleAfter?: Date | null;
  /** OKF `generated`. Defaults to `{ by: "unknown", at: now }` if omitted. */
  readonly generated?: OkfActor;
  /** OKF `verified`. Defaults to `[]` if omitted. */
  readonly verified?: readonly OkfActor[];
  /** Defaults to `{}` if omitted. */
  readonly frontmatter?: Readonly<Record<string, unknown>>;
}

/** Input to `VolumeStore.updateVolume`. Omitted fields are left unchanged. */
export interface VolumeUpdate {
  readonly title?: string;
  readonly description?: string;
  readonly type?: string;
  readonly status?: OkfStatus;
  readonly staleAfter?: Date | null;
  readonly generated?: OkfActor;
  readonly verified?: readonly OkfActor[];
  /**
   * When given, replaces the volume's frontmatter wholesale (same
   * upsert-not-merge semantics as `ChapterInput.frontmatter` in
   * `putChapter`) — callers that want to preserve existing keys must spread
   * them in themselves. Omit to leave the existing frontmatter unchanged.
   */
  readonly frontmatter?: Readonly<Record<string, unknown>>;
}

/**
 * A unit of curated belief within a volume: Markdown content plus
 * frontmatter metadata.
 *
 * `title`, `createdAt`, `updatedAt`, `type`, `status`, `staleAfter`,
 * `generated`, and `verified` are the fields this package and OKF own and
 * type. Everything else that lives in the on-disk frontmatter block —
 * including fields defined by *other* packages, such as the routing
 * signals `@shadow/indexing` attaches (`when_to_use`, `not_for`, ...) —
 * round-trips unchanged through `frontmatter`. This package never inspects,
 * validates, or drops keys it doesn't own: doing so would silently destroy
 * operator/agent-authored signal that a downstream package depends on.
 */
export interface Chapter {
  readonly slug: ChapterSlug;
  readonly title: string;
  readonly body: string;
  /** OKF-required concept type (OKF §4.1). */
  readonly type: string;
  /** OKF lifecycle status. Defaults to `"draft"`. */
  readonly status: OkfStatus;
  /** OKF stale-after date. `null` means no staleness gating. */
  readonly staleAfter: Date | null;
  /** OKF `generated` — how the content was produced (OKF §5.2). */
  readonly generated: OkfActor;
  /** OKF `verified` — who confirmed the content. Empty array = unverified (OKF §5.3). */
  readonly verified: readonly OkfActor[];
  /** All frontmatter fields other than those owned by this package or OKF. Opaque to this package. */
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Input to `VolumeStore.putChapter`, an upsert — see that port's doc for the
 * full preserve-on-update contract the five OKF fields below follow.
 */
export interface ChapterInput {
  readonly slug: ChapterSlug;
  readonly title: string;
  readonly body: string;
  /** OKF type. Defaults to `"Concept"` on create; omitted on update preserves the stored value. */
  readonly type?: string;
  /** OKF status. Defaults to `"draft"` on create; omitted on update preserves the stored value. */
  readonly status?: OkfStatus;
  /**
   * OKF stale-after date. Defaults to `null` on create; omitted (`undefined`)
   * on update preserves the stored value — `null` is a distinct, meaningful
   * input on update, explicitly clearing staleness gating rather than
   * leaving the existing date in place.
   */
  readonly staleAfter?: Date | null;
  /** OKF `generated`. Defaults to `{ by: "unknown", at: now }` on create; omitted on update preserves the stored value. */
  readonly generated?: OkfActor;
  /** OKF `verified`. Defaults to `[]` on create; omitted on update preserves the stored value. */
  readonly verified?: readonly OkfActor[];
  /** Defaults to `{}` if omitted. Merged verbatim into the chapter's frontmatter. */
  readonly frontmatter?: Readonly<Record<string, unknown>>;
}

// ---- OKF Attested Computation (OKF v0.2 §10) ---------------------------------

/** A typed parameter for an Attested Computation (OKF §10.2). */
export interface OkfParameter {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
}

/**
 * OKF v0.2 Attested Computation frontmatter extension (OKF §10).
 *
 * When a chapter has `type: "Attested Computation"`, its frontmatter
 * carries these fields in addition to the standard OKF fields. They
 * define a sanctioned way to compute a value so a consumer can confirm
 * the agent ran the blessed computation rather than improvising its own.
 *
 * This is not a separate stored type — it is a frontmatter extension
 * (key/value pairs in the open record) validated by `shadow lint --okf`.
 * Being an extension rather than a built-in type means `@shadow/core`
 * never needs to parse or validate it; the conformance check lives in
 * `@shadow/indexing`'s lint layer, which already has full access to
 * frontmatter through `ChapterIndexNode`.
 */
export interface OkfAttestedComputation {
  /** How to run the computation — determines what `parameters` mean and how executor/attester interpret it (OKF §10.2). */
  readonly runtime: string;
  /** Typed, named holes the agent may fill. Binding semantics follow `runtime`. */
  readonly parameters: readonly OkfParameter[];
  /** Optional path to a file holding the computation (OKF §6.2). Absent ⇒ the body `# Computation` fence is the computation. */
  readonly computation?: string;
  /** How the computation is run — `resource` names run instructions, `receipt` declares fields a run must return (OKF §10.2). */
  readonly executor: { readonly resource: string; readonly receipt: readonly string[] };
  /** Deterministic (no-LLM) code that inspects a receipt and returns a verdict (OKF §10.2). */
  readonly attester: { readonly resource: string };
}
