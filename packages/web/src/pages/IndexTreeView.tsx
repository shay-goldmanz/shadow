import type { ChapterIndexNode, SectionIndexNode, VolumeIndexDocument } from "../api/types.ts";

/**
 * The volume's index tree (D11/D11a/D13/D14), reduced to titles only. The
 * full `when_to_use`/`not_for` text is already available per-chapter in the
 * chapter list right next to this (behind its own toggle) — printing it
 * again here duplicated the same paragraphs twice on one screen. This stays
 * an outline for orientation in a longer volume: heading paths, nothing
 * more. `index` is the raw `index.json` document `GET .../index` returns —
 * one `VolumeIndexNode` holding this volume's `ChapterIndexNode[]`, each
 * optionally expanding into `SectionIndexNode[]` (chapters at or above the
 * section-token threshold) or a flat `key_items` heading list (chapters
 * under it) — never both.
 */
export function IndexTreeView({ index }: { readonly index: VolumeIndexDocument }) {
  const { chapters } = index.volume;
  if (chapters.length === 0) {
    return <p className="index-tree__empty">Nothing indexed yet.</p>;
  }
  return (
    <ul className="index-tree" aria-label="Index tree">
      {chapters.map((chapter) => (
        <ChapterNodeView key={chapter.node_id} node={chapter} />
      ))}
    </ul>
  );
}

function ChapterNodeView({ node }: { readonly node: ChapterIndexNode }) {
  return (
    <li className="index-tree__node">
      <div className="index-tree__title">{node.title}</div>
      {node.sections && node.sections.length > 0 && (
        <ul>
          {node.sections.map((section) => (
            <SectionNodeView key={section.node_id} node={section} />
          ))}
        </ul>
      )}
      {!node.sections && node.key_items && node.key_items.length > 0 && (
        <ul className="index-tree__key-items">
          {node.key_items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

function SectionNodeView({ node }: { readonly node: SectionIndexNode }) {
  return (
    <li className="index-tree__node">
      <div className="index-tree__title">{node.title}</div>
      {node.sections && node.sections.length > 0 && (
        <ul>
          {node.sections.map((child) => (
            <SectionNodeView key={child.node_id} node={child} />
          ))}
        </ul>
      )}
    </li>
  );
}
