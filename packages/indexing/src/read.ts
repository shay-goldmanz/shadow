/**
 * `shadow read <node_id> [--with-parents]` (`docs/INDEXING.md`, STAGE 4):
 * "body bytes from span, heading path, parent's when_to_use, sibling
 * titles, content_hash".
 *
 * Split in two, matching the rest of this package's pure/impure seam:
 * `resolveReadContext` here does all of the *structural* lookup — locate
 * the node in the already-built `IndexDocument`, compute its heading
 * path, its parent's `when_to_use` (the chapter's, for a section; the
 * volume's, for a chapter — `--with-parents` generalizes uniformly), and
 * its sibling titles — entirely off in-memory data, no I/O. The actual
 * body-byte fetch (`VolumeStore.getChapter` + slicing the span) is I/O
 * and lives in `navigator.ts`'s concrete `Navigator`, which calls this
 * function first to know *what* to fetch and *how* to describe it.
 */

import { toChapterSlug, toVolumeSlug, type VolumeStore } from "@shadow/core";
import { sliceBytesToText, toBytes } from "./byte-text.ts";
import { flattenIndex } from "./closure.ts";
import { NodeNotFoundError } from "./errors.ts";
import type { ChapterIndexNode, IndexDocument, SectionIndexNode, Span, VolumeIndexNode } from "./types.ts";

interface LocatedNode {
  readonly volume: VolumeIndexNode;
  readonly chapter: ChapterIndexNode;
  /** Present when `node_id` addressed a section; absent when it addressed the chapter itself. */
  readonly section?: SectionIndexNode;
}

function findSection(
  sections: readonly SectionIndexNode[] | undefined,
  nodeId: string,
): SectionIndexNode | undefined {
  if (!sections) {
    return undefined;
  }
  for (const section of sections) {
    if (section.node_id === nodeId) {
      return section;
    }
    const nested = findSection(section.sections, nodeId);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function locateNode(document: IndexDocument, nodeId: string): LocatedNode | undefined {
  for (const volume of document.volumes) {
    for (const chapter of volume.chapters) {
      if (chapter.node_id === nodeId) {
        return { volume, chapter };
      }
      const section = findSection(chapter.sections, nodeId);
      if (section) {
        return { volume, chapter, section };
      }
    }
  }
  return undefined;
}

/** Everything `shadow read` needs to describe a node, short of the body bytes themselves. */
export interface ReadContext {
  readonly node_id: string;
  readonly kind: "chapter" | "section";
  /** Which volume/chapter to fetch the body from — I/O detail, not shown to the agent. */
  readonly volumeId: string;
  readonly chapterSlug: string;
  /** The chapter's own `file` field, carried through so citation-building (`navigator.ts`) doesn't need a second lookup. */
  readonly file: string;
  readonly span: Span;
  readonly content_hash: string;
  /** Full breadcrumb: `[volumeTitle, chapterTitle]` for a chapter, extended with the section's own heading path for a section. */
  readonly heading_path: readonly string[];
  /** The enclosing chapter's `when_to_use` (section reads) or the enclosing volume's `when_to_use` (chapter reads) — "parent's when_to_use", generalized by level (`--with-parents`). */
  readonly parent_when_to_use?: string;
  /** Titles of nodes sharing this node's immediate parent — sibling sections for a section, sibling chapters (same volume) for a chapter. */
  readonly sibling_titles: readonly string[];
}

function siblingTitles(document: IndexDocument, nodeId: string): readonly string[] {
  const flat = flattenIndex(document);
  const node = flat.get(nodeId);
  if (!node?.parentId) {
    return [];
  }
  const parent = flat.get(node.parentId);
  return (parent?.childIds ?? [])
    .filter((id) => id !== nodeId)
    .map((id) => flat.get(id)?.title)
    .filter((title): title is string => title !== undefined);
}

/** `undefined` when `nodeId` resolves to nothing in `document` — callers (the concrete `Navigator`) turn that into `NodeNotFoundError`. */
export function resolveReadContext(document: IndexDocument, nodeId: string): ReadContext | undefined {
  const located = locateNode(document, nodeId);
  if (!located) {
    return undefined;
  }
  const siblings = siblingTitles(document, nodeId);

  if (located.section) {
    return {
      node_id: nodeId,
      kind: "section",
      volumeId: located.volume.volume_id,
      chapterSlug: located.chapter.slug,
      file: located.chapter.file,
      span: located.section.span,
      content_hash: located.section.content_hash,
      heading_path: [...located.chapter.path, ...located.section.heading_path],
      parent_when_to_use: located.chapter.when_to_use,
      sibling_titles: siblings,
    };
  }

  return {
    node_id: nodeId,
    kind: "chapter",
    volumeId: located.volume.volume_id,
    chapterSlug: located.chapter.slug,
    file: located.chapter.file,
    span: located.chapter.span,
    content_hash: located.chapter.content_hash,
    heading_path: located.chapter.path,
    parent_when_to_use: located.volume.when_to_use,
    sibling_titles: siblings,
  };
}

/** The realized `shadow read` result, once the body bytes have been fetched and sliced. */
export interface ReadResult {
  readonly node_id: string;
  readonly body: string;
  readonly heading_path: readonly string[];
  readonly parent_when_to_use?: string;
  readonly sibling_titles: readonly string[];
  readonly content_hash: string;
}

/**
 * `shadow read <node_id>`: resolve `nodeId`'s structural context, fetch
 * its chapter's body through `store` (the one I/O this package's
 * retrieval side performs outside the BM25 fallback), and slice out
 * exactly the cited span. A standalone function — not tied to any
 * `Navigator`/`NavigationAgent` — because reading a node's body has
 * nothing to do with which retrieval *strategy* found it; T3.1's `shadow
 * read` command can call this directly with no agent involved at all.
 *
 * @throws {NodeNotFoundError} if `nodeId` resolves to nothing in `document`.
 */
export async function readNode(
  store: VolumeStore,
  document: IndexDocument,
  nodeId: string,
): Promise<ReadResult> {
  const ctx = resolveReadContext(document, nodeId);
  if (!ctx) {
    throw new NodeNotFoundError(nodeId);
  }
  const chapter = await store.getChapter(toVolumeSlug(ctx.volumeId), toChapterSlug(ctx.chapterSlug));
  const body = sliceBytesToText(toBytes(chapter.body), ctx.span.start_byte, ctx.span.end_byte);
  return {
    node_id: ctx.node_id,
    body,
    heading_path: ctx.heading_path,
    parent_when_to_use: ctx.parent_when_to_use,
    sibling_titles: ctx.sibling_titles,
    content_hash: ctx.content_hash,
  };
}
