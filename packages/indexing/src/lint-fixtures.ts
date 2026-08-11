/**
 * Shared `IndexDocument` fixture builders for `lint-*.test.ts` — same
 * "overrides over a sane default" shape `closure.test.ts` already
 * established for this package's other structural tests. Not exported
 * from `index.ts`: test-only.
 */

import type {
  ChapterIndexNode,
  IndexDocument,
  SectionIndexNode,
  VolumeIndexNode,
} from "./types.ts";
import { INDEX_SCHEMA_VERSION } from "./types.ts";

export function section(
  overrides: Partial<SectionIndexNode> & { node_id: string; title: string },
): SectionIndexNode {
  return {
    kind: "section",
    level: 2,
    heading_path: [overrides.title],
    span: { start_byte: 0, end_byte: 1 },
    tokens: 10,
    content_hash: "sha256:aa",
    subtree_hash: "sha256:aa",
    ...overrides,
  };
}

export function chapter(
  overrides: Partial<ChapterIndexNode> & { node_id: string; title: string },
): ChapterIndexNode {
  return {
    kind: "chapter",
    slug: overrides.node_id.toLowerCase(),
    path: ["Volume", overrides.title],
    file: `volumes/v/chapters/${overrides.node_id}.md`,
    tokens: 100,
    span: { start_byte: 0, end_byte: 10 },
    content_hash: "sha256:aa",
    subtree_hash: "sha256:aa",
    ...overrides,
  };
}

export function volume(
  overrides: Partial<VolumeIndexNode> & {
    volume_id: string;
    chapters: readonly ChapterIndexNode[];
  },
): VolumeIndexNode {
  return {
    title: overrides.volume_id,
    chapter_count: overrides.chapters.length,
    volume_hash: "sha256:bb",
    ...overrides,
  };
}

export function document(volumes: readonly VolumeIndexNode[]): IndexDocument {
  const chapters = volumes.reduce((sum, v) => sum + v.chapter_count, 0);
  const tokens = volumes.reduce(
    (sum, v) => sum + v.chapters.reduce((chapterSum, c) => chapterSum + c.tokens, 0),
    0,
  );
  return {
    schema_version: INDEX_SCHEMA_VERSION,
    generated_at: new Date(0).toISOString(),
    corpus_hash: "sha256:cc",
    stats: { volumes: volumes.length, chapters, tokens },
    volumes,
  };
}
