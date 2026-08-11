/**
 * `index.json` schema — owned and versioned by `@shadow/indexing`.
 *
 * `@shadow/core` stores this document opaquely (`VolumeStore.readIndex` /
 * `writeIndex` type it as `unknown`); this package is the only one that
 * knows or asserts its shape. Field names are deliberately `snake_case`,
 * matching `docs/INDEXING.md` exactly, because these types mirror the wire
 * (JSON) format byte-for-byte rather than following normal TS camelCase
 * convention — there is no serialization mapping layer.
 *
 * See `docs/INDEXING.md` for the authoritative schema and the algorithm
 * that produces it.
 */

/** Current `index.json` schema version. Bump when the shape changes. */
export const INDEX_SCHEMA_VERSION = 1;

/**
 * A non-overlapping byte range, half-open: `[start_byte, end_byte)` — i.e.
 * `end_byte` is the offset one past the last included byte, so
 * `end_byte - start_byte` is the span's exact byte length and adjacent
 * spans satisfy `a.end_byte === b.start_byte` with no gap and no overlap.
 * (`docs/INDEXING.md`'s pseudocode says a section "ends one byte before
 * the next heading... minus 1", which reads as informal phrasing for the
 * same half-open boundary rather than a literal off-by-one instruction —
 * a strictly inclusive end would make the chapter's own span, described
 * as running to plain `EOF`, inconsistent with every other node's "minus
 * 1". Half-open throughout resolves that and is what this package
 * implements; flagged in the implementation report.)
 *
 * Offsets are byte offsets (UTF-8) into the chapter's *body* content only
 * — i.e. relative to `Chapter.body` as returned by `@shadow/core`'s
 * `VolumeStore`, starting at 0 for the first byte of the body. They
 * deliberately do NOT include on-disk frontmatter bytes: `@shadow/core`
 * never exposes the raw file (only the parsed `Chapter`), and every
 * consumer of a span (the CLI's `shadow read`, `@shadow/indexing` itself)
 * resolves it against `Chapter.body` fetched through the same store, so
 * body-relative offsets are what's actually useful.
 */
export interface Span {
  readonly start_byte: number;
  readonly end_byte: number;
}

/** `confidence` enum from chapter frontmatter (`docs/INDEXING.md`). */
export type Confidence = "high" | "medium" | "provisional";

/**
 * A section node: a Markdown heading (level 2-6) within a chapter, nested
 * by heading level. Sections bound and cite; they never carry routing
 * fields (`when_to_use`/`not_for`) and are never LLM-summarized.
 */
export interface SectionIndexNode {
  readonly node_id: string; // `<chapter ULID>#<slugified-heading-path>`
  readonly kind: "section";
  readonly title: string;
  readonly level: number; // 2-6
  readonly heading_path: readonly string[]; // ancestor titles, self last
  readonly span: Span;
  readonly tokens: number;
  readonly content_hash: string; // "sha256:<hex>", own text only
  readonly subtree_hash: string; // "sha256:<hex>", content_hash || concat(child subtree_hashes)
  /** Nested sub-sections, if this section has child headings. */
  readonly sections?: readonly SectionIndexNode[];
}

/** A chapter node: one Markdown file under `chapters/`. */
export interface ChapterIndexNode {
  readonly node_id: string; // ULID, minted once, persisted in chapter frontmatter (D13)
  readonly kind: "chapter";
  readonly title: string;
  readonly slug: string;
  readonly path: readonly [volumeTitle: string, chapterTitle: string];
  /** Volume-relative location, e.g. `volumes/<slug>/chapters/<slug>.md`. Informational only — never resolved by this package; readers still go through `VolumeStore`. */
  readonly file: string;

  readonly when_to_use?: string;
  readonly not_for?: string;
  readonly keywords?: readonly string[];
  readonly confidence?: Confidence;
  readonly supersedes?: readonly string[];
  readonly aliases?: readonly string[];

  readonly updated?: string;
  readonly tokens: number;
  readonly span: Span; // union semantics: covers the whole body, [0, bodyByteLength]
  readonly content_hash: string;
  readonly subtree_hash: string;

  /** Present only when `tokens >= SECTION_TOKEN_THRESHOLD`. */
  readonly sections?: readonly SectionIndexNode[];
  /** Present only when `sections` is absent (chapter under threshold): heading titles, in document order. */
  readonly key_items?: readonly string[];
}

/** A volume node: one directory under `volumes/`. */
export interface VolumeIndexNode {
  readonly volume_id: string; // volume slug
  readonly title: string;
  readonly when_to_use?: string;
  readonly not_for?: string;
  readonly keywords?: readonly string[];
  readonly chapter_count: number;
  readonly volume_hash: string;
  readonly chapters: readonly ChapterIndexNode[];
}

export interface IndexStats {
  readonly volumes: number;
  readonly chapters: number;
  readonly tokens: number;
}

/** The full `index.json` document. */
export interface IndexDocument {
  readonly schema_version: typeof INDEX_SCHEMA_VERSION;
  readonly generated_at: string; // ISO 8601
  readonly corpus_hash: string;
  readonly stats: IndexStats;
  readonly volumes: readonly VolumeIndexNode[];
}

/**
 * A single volume's `index.json` document — a scoped view over the
 * corpus-wide `IndexDocument`, holding only that volume's own node rather
 * than every volume's (T2.2 originally wrote the identical corpus-wide
 * document into every volume's `index.json`, so volume A's index listed
 * volume B's chapters; fixed in T2.3, see `indexer.ts`'s `reindex`).
 *
 * `corpus_hash` is carried through so a reader can tell whether this
 * volume-scoped view is still consistent with the corpus-wide index
 * (`VolumeStore.readCorpusIndex`) it was generated alongside, without
 * needing to fetch the whole corpus document just to check.
 */
export interface VolumeIndexDocument {
  readonly schema_version: typeof INDEX_SCHEMA_VERSION;
  readonly generated_at: string; // ISO 8601
  readonly corpus_hash: string;
  readonly volume: VolumeIndexNode;
}
