import type { ChapterIndexNode, SectionIndexNode } from "../api/types.ts";

/**
 * One chapter's outline (D11/D11a/D13/D14, reduced to titles only — see
 * the note this module used to carry as `IndexTreeView`, a standalone
 * "Outline" column next to the chapter list): sections (or a flat
 * `key_items` heading list, never both) nested under a collapsed toggle,
 * meant to sit inside that chapter's own card — between its title and its
 * when-to-use text — rather than in a second list the operator has to
 * cross-reference against the first by title. No title or click-to-open
 * of its own: the card around it already has both.
 */
export function ChapterOutline({ node }: { readonly node: ChapterIndexNode }) {
  const childCount = node.sections?.length ?? node.key_items?.length ?? 0;
  if (childCount === 0) return null;

  return (
    <details className="chapter-card__details">
      <summary>
        Outline
        <span className="index-tree__count">
          {childCount} {node.sections ? "section" : "heading"}
          {childCount === 1 ? "" : "s"}
        </span>
      </summary>
      {node.sections && node.sections.length > 0 && (
        <ul className="index-tree__sections">
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
    </details>
  );
}

function SectionNodeView({ node }: { readonly node: SectionIndexNode }) {
  return (
    <li className="index-tree__section">
      <div className="index-tree__section-title">{node.title}</div>
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
