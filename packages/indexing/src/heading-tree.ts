/**
 * Heading-tree extraction from a chapter body (`docs/INDEXING.md`,
 * "EXTRACT HEADING TREE").
 *
 * Pure: takes the chapter body string, returns a tree. No filesystem, no
 * network — fully unit-testable on inline strings.
 */

import { slugify } from "@shadow/core";
import { byteLength } from "./byte-text.ts";

/** A single heading line found in the body, flat (not yet nested). */
export interface FlatHeading {
  readonly level: number; // 2-6; level-1 `#` is the chapter title, never captured here
  readonly title: string;
  /** Byte offset (UTF-8) of the start of the heading line, relative to the body. */
  readonly startByte: number;
}

/** A heading, nested under its parent by level, with a disambiguated slug. */
export interface HeadingNode extends FlatHeading {
  readonly slug: string;
  readonly children: readonly HeadingNode[];
}

interface MutableNode extends FlatHeading {
  slug: string;
  children: MutableNode[];
}

// `#` level 1 is the chapter title, not a section — deliberately excluded
// from the character class (`{2,6}`). Anchored at column 0 (no leading
// whitespace tolerated), which also has the side effect of never matching
// an indented (4-space) code block line, since those always start with
// whitespace before any `#`.
const HEADING_PATTERN = /^(#{2,6})\s+(.+?)\s*$/;

// A fence opens or closes on any line starting with 3+ backticks or
// tildes. CommonMark's exact closing-fence rule (same char, length >=
// opening) is more nuanced than we need here — chapters are Shadow's own
// authored Markdown, not adversarial input — so a simple toggle on "3+ of
// the same fence character" is sufficient and keeps this readable.
const FENCE_PATTERN = /^(`{3,}|~{3,})/;

/**
 * Scan `body` line by line and return every heading (level 2-6) found
 * outside fenced code blocks, in document order, with byte offsets.
 */
export function extractHeadings(body: string): FlatHeading[] {
  const headings: FlatHeading[] = [];
  const lines = body.split("\n");

  let byteOffset = 0;
  let fenceChar: string | undefined;

  for (const [i, line] of lines.entries()) {
    const fenceMatch = FENCE_PATTERN.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]?.[0];
      if (fenceChar === undefined) {
        fenceChar = marker;
      } else if (fenceChar === marker) {
        fenceChar = undefined;
      }
      // A fence character different from the one that opened the current
      // fence (e.g. `~~~` inside a ``` block) is literal content, not a
      // toggle — fall through without changing state.
    } else if (fenceChar === undefined) {
      const headingMatch = HEADING_PATTERN.exec(line);
      const [, hashes, title] = headingMatch ?? [];
      if (hashes && title) {
        headings.push({ level: hashes.length, title, startByte: byteOffset });
      }
    }

    byteOffset += byteLength(line);
    if (i < lines.length - 1) {
      byteOffset += 1; // the "\n" separator consumed by split, 1 byte (ASCII)
    }
  }

  return headings;
}

/**
 * Slugify each node's title and disambiguate duplicate slugs among
 * *siblings only* (not globally): the first occurrence keeps the plain
 * slug, the second gets `-2`, the third `-3`, etc. Recurses per sibling
 * group, so a duplicate title under a different parent never collides
 * with this one.
 */
function assignSlugs(nodes: readonly MutableNode[]): void {
  const seen = new Map<string, number>();
  for (const node of nodes) {
    const base = slugify(node.title) || "section";
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    node.slug = count === 1 ? base : `${base}-${count}`;
    assignSlugs(node.children);
  }
}

/**
 * Nest a flat, document-ordered heading list into a tree using the
 * level-stack algorithm from `docs/INDEXING.md`:
 *
 * ```
 * while stack and stack[-1].level >= level: stack.pop()
 * parent = stack[-1] or chapter; stack.push(node)
 * ```
 *
 * A level skip (e.g. `##` directly followed by `####`) nests the deeper
 * heading under the shallower one directly — no synthetic intermediate
 * node is invented for the skipped level.
 */
export function buildHeadingTree(flat: readonly FlatHeading[]): HeadingNode[] {
  const roots: MutableNode[] = [];
  const stack: MutableNode[] = [];

  for (const heading of flat) {
    const node: MutableNode = { ...heading, slug: "", children: [] };
    let top = stack[stack.length - 1];
    while (top && top.level >= node.level) {
      stack.pop();
      top = stack[stack.length - 1];
    }
    if (top) {
      top.children.push(node);
    } else {
      roots.push(node);
    }
    stack.push(node);
  }

  assignSlugs(roots);
  return roots;
}

/** Extract and nest in one call — the common case for callers that don't need the flat list separately. */
export function parseHeadingTree(body: string): HeadingNode[] {
  return buildHeadingTree(extractHeadings(body));
}
