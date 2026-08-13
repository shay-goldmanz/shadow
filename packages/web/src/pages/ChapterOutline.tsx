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
 *
 * Every title used to render at the same size, weight, and (mono) font,
 * chapters and sections alike, in one undifferentiated block — readable
 * for a single short chapter, illegible once a volume has several
 * (a wall of identical-looking lines, no way to tell a chapter heading
 * from a section three levels under a different one). Each chapter is now
 * its own collapsed-by-default `<details>` — its title is what a longer
 * volume's outline actually needs to convey — so scanning the volume means
 * scanning chapter titles first, not every heading in every chapter at
 * once; the title itself jumps straight to the chapter, same as the
 * chapter list right next to it.
 */
export function IndexTreeView({
  index,
  onOpenChapter,
}: {
  readonly index: VolumeIndexDocument;
  readonly onOpenChapter: (chapterSlug: string) => void;
}) {
  const { chapters } = index.volume;
  if (chapters.length === 0) {
    return <p className="index-tree__empty">Nothing indexed yet.</p>;
  }
  return (
    <div className="index-tree" aria-label="Index tree">
      {chapters.map((chapter) => (
        <ChapterNodeView
          key={chapter.node_id}
          node={chapter}
          defaultOpen={chapters.length === 1}
          onOpen={() => onOpenChapter(chapter.slug)}
        />
      ))}
    </div>
  );
}

function ChapterNodeView({
  node,
  defaultOpen,
  onOpen,
}: {
  readonly node: ChapterIndexNode;
  readonly defaultOpen: boolean;
  readonly onOpen: () => void;
}) {
  const childCount = node.sections?.length ?? node.key_items?.length ?? 0;
  return (
    <details className="index-tree__chapter" open={defaultOpen}>
      <summary>
        <button
          type="button"
          className="index-tree__chapter-title"
          onClick={(event) => {
            // A click inside <summary> toggles the <details> by default —
            // this button means "open the chapter", not "expand the
            // outline in place", so it opts out of that default action.
            event.preventDefault();
            onOpen();
          }}
        >
          {node.title}
        </button>
        {childCount > 0 && (
          <span className="index-tree__count">
            {childCount} {node.sections ? "section" : "heading"}
            {childCount === 1 ? "" : "s"}
          </span>
        )}
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
