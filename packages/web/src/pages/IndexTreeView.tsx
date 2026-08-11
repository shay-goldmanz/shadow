import type { IndexNode, IndexTree } from "../api/types.ts";

/** The volume's index tree (D11/D11a/D13/D14): heading paths and the routing signals that steer a consuming agent. */
export function IndexTreeView({ index }: { readonly index: IndexTree }) {
  if (index.nodes.length === 0) {
    return <p className="index-tree__empty">Nothing indexed yet.</p>;
  }
  return (
    <ul className="index-tree" aria-label="Index tree">
      {index.nodes.map((node) => (
        <IndexNodeView key={node.id} node={node} />
      ))}
    </ul>
  );
}

function IndexNodeView({ node }: { readonly node: IndexNode }) {
  return (
    <li className="index-tree__node">
      <div className="index-tree__title">{node.title}</div>
      {node.whenToUse && (
        <div className="index-tree__when-to-use">when to use: {node.whenToUse}</div>
      )}
      {node.notFor && <div className="index-tree__not-for">not for: {node.notFor}</div>}
      {node.children && node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <IndexNodeView key={child.id} node={child} />
          ))}
        </ul>
      )}
    </li>
  );
}
