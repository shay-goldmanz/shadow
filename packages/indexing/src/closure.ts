/**
 * STAGE 4 (EXPAND) of `docs/INDEXING.md`'s retrieval algorithm: `0 LLM
 * calls`. Given a hit set (node_ids the agent chose, or BM25 promoted),
 * compute the ancestor closure —
 *
 *   keep = H ∪ ancestors(H) ∪ immediate siblings
 *
 * — and render the pruned tree as an indented outline string rather than
 * JSON ("~3x cheaper", `docs/INDEXING.md`). Pure and synchronous: works
 * entirely off the already-built `IndexDocument` tree (volume -> chapter
 * -> section), no body text, no I/O.
 *
 * **Design decision (flagged in the implementation report):** "immediate
 * siblings" is implemented generically at whatever level a hit sits —
 * sibling *sections* for a section-level hit (the common case: heading
 * path + sibling headings, matching D11's "structure around the hit"
 * example literally), and sibling *chapters within the same volume* for a
 * chapter-level hit. This keeps a single formula working at every level
 * rather than special-casing chapters, and at our scale (2-50 chapters per
 * volume) a chapter's siblings are cheap to include. It is exactly this
 * "same immediate parent" rule that prunes unrelated branches: a hit
 * inside volume A never pulls in volume B's chapters, because they do not
 * share a parent with anything in A's ancestor chain.
 *
 * A hit's own **direct children** (one level: a chapter hit's top-level
 * sections, a section hit's immediate subsections) are also kept, even
 * though the literal formula only names ancestors and siblings — without
 * this, choosing a chapter would render an outline with no way to see
 * what is inside it, defeating STAGE 4's purpose of showing "structure
 * around the hit" before `shadow read`. Not expanded recursively beyond
 * one level — that is what keeps the tree "pruned".
 */

import type {
  ChapterIndexNode,
  IndexDocument,
  SectionIndexNode,
  VolumeIndexNode,
} from "./types.ts";

export type NodeKind = "volume" | "chapter" | "section";

/** A single node in the flattened volume -> chapter -> section tree, with parent/child pointers by `node_id`. */
export interface FlatNode {
  readonly node_id: string;
  readonly kind: NodeKind;
  readonly title: string;
  /** 0 = volume, 1 = chapter, 2+ = nested sections. Drives outline indentation. */
  readonly depth: number;
  readonly parentId?: string;
  /** Direct children only, in document order. */
  readonly childIds: readonly string[];
}

function flattenSections(
  flat: Map<string, FlatNode>,
  sections: readonly SectionIndexNode[],
  parentId: string,
  depth: number,
): void {
  for (const section of sections) {
    const childIds = (section.sections ?? []).map((child) => child.node_id);
    flat.set(section.node_id, {
      node_id: section.node_id,
      kind: "section",
      title: section.title,
      depth,
      parentId,
      childIds,
    });
    if (section.sections) {
      flattenSections(flat, section.sections, section.node_id, depth + 1);
    }
  }
}

function flattenChapter(
  flat: Map<string, FlatNode>,
  chapter: ChapterIndexNode,
  volumeId: string,
): void {
  const childIds = (chapter.sections ?? []).map((section) => section.node_id);
  flat.set(chapter.node_id, {
    node_id: chapter.node_id,
    kind: "chapter",
    title: chapter.title,
    depth: 1,
    parentId: volumeId,
    childIds,
  });
  if (chapter.sections) {
    flattenSections(flat, chapter.sections, chapter.node_id, 2);
  }
}

function flattenVolume(flat: Map<string, FlatNode>, volume: VolumeIndexNode): void {
  flat.set(volume.volume_id, {
    node_id: volume.volume_id,
    kind: "volume",
    title: volume.title,
    depth: 0,
    parentId: undefined,
    childIds: volume.chapters.map((chapter) => chapter.node_id),
  });
  for (const chapter of volume.chapters) {
    flattenChapter(flat, chapter, volume.volume_id);
  }
}

/**
 * Flatten the whole document tree (every volume, chapter, and section)
 * into a `node_id -> FlatNode` map with parent/child pointers. Iteration
 * order matches document order (volumes, then each volume's chapters in
 * order, then each chapter's sections depth-first) — callers that need a
 * stable document-order listing can rely on `Map` preserving insertion
 * order.
 */
export function flattenIndex(document: IndexDocument): ReadonlyMap<string, FlatNode> {
  const flat = new Map<string, FlatNode>();
  for (const volume of document.volumes) {
    flattenVolume(flat, volume);
  }
  return flat;
}

/**
 * Compute `keep = H ∪ ancestors(H) ∪ immediate siblings` (plus each hit's
 * own direct children — see module doc) over the flattened tree. Returns
 * `node_id`s in document order, not hit order, so `renderOutline` gets a
 * stable, hierarchical sequence.  Unknown ids in `hitNodeIds` (referring
 * to nothing in `document`) are silently skipped rather than throwing —
 * closure is best-effort structural context, not a citation-resolution
 * path where a bad id should be fatal.
 */
export function ancestorClosure(
  document: IndexDocument,
  hitNodeIds: readonly string[],
): readonly string[] {
  const flat = flattenIndex(document);
  const keep = new Set<string>();

  for (const hitId of hitNodeIds) {
    const hit = flat.get(hitId);
    if (!hit) {
      continue;
    }
    keep.add(hitId);

    // Ancestors: walk the parent chain to the root.
    let parentId = hit.parentId;
    while (parentId) {
      keep.add(parentId);
      parentId = flat.get(parentId)?.parentId;
    }

    // Immediate siblings: other nodes sharing the hit's own parent.
    if (hit.parentId) {
      const parent = flat.get(hit.parentId);
      for (const siblingId of parent?.childIds ?? []) {
        keep.add(siblingId);
      }
    }

    // The hit's own direct children (one level — see module doc).
    for (const childId of hit.childIds) {
      keep.add(childId);
    }
  }

  return [...flat.keys()].filter((id) => keep.has(id));
}

/**
 * Render an already-computed node_id set as an indented outline string —
 * "~3x cheaper" than the equivalent JSON (`docs/INDEXING.md`), and never
 * carries body text: only `title` and `node_id` per row. `nodeIds` is
 * expected in document order (as `ancestorClosure` returns), so
 * indentation reads as a coherent tree; each row's depth comes from the
 * node's actual position in `document`, not from its order in `nodeIds`.
 */
export function renderOutline(document: IndexDocument, nodeIds: readonly string[]): string {
  const flat = flattenIndex(document);
  const lines: string[] = [];
  for (const id of nodeIds) {
    const node = flat.get(id);
    if (!node) {
      continue;
    }
    lines.push(`${"  ".repeat(node.depth)}${node.title} [${node.node_id}]`);
  }
  return lines.join("\n");
}
