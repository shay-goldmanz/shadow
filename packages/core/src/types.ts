import type { ChapterSlug, VolumeSlug } from "./slug.ts";

/**
 * A curated collection: the top-level unit the operator creates and names.
 */
export interface Volume {
  readonly slug: VolumeSlug;
  readonly title: string;
  readonly description: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Input to `VolumeStore.createVolume`. */
export interface VolumeInput {
  readonly slug: VolumeSlug;
  readonly title: string;
  /** Defaults to `""` if omitted. */
  readonly description?: string;
}

/** Input to `VolumeStore.updateVolume`. Omitted fields are left unchanged. */
export interface VolumeUpdate {
  readonly title?: string;
  readonly description?: string;
}

/**
 * A unit of curated belief within a volume: Markdown content plus
 * frontmatter metadata.
 *
 * `title`, `createdAt`, and `updatedAt` are the fields this package owns
 * and types. Everything else that lives in the on-disk frontmatter block —
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
  /** All frontmatter fields other than `title`, `createdAt`, `updatedAt`. Opaque to this package. */
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Input to `VolumeStore.putChapter`. */
export interface ChapterInput {
  readonly slug: ChapterSlug;
  readonly title: string;
  readonly body: string;
  /** Defaults to `{}` if omitted. Merged verbatim into the chapter's frontmatter. */
  readonly frontmatter?: Readonly<Record<string, unknown>>;
}
