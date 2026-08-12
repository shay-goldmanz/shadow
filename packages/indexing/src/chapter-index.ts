/**
 * Pure assembly of a single chapter's `ChapterIndexNode`, including its
 * section tree. No I/O: the caller (`indexer.ts`) is responsible for
 * fetching the chapter (and minting/persisting its ULID, D13) beforehand.
 */

import { sliceBytesToText, toBytes } from "./byte-text.ts";
import { computeContentHash, computeSubtreeHash, ownText } from "./hashing.ts";
import { type HeadingNode, parseHeadingTree } from "./heading-tree.ts";
import {
  coerceConfidence,
  coerceDateLike,
  coerceRoutingText,
  coerceStringArray,
} from "./routing-fields.ts";
import { assignSpans, chapterSpan, type SpannedNode } from "./spans.ts";
import { estimateTokens } from "./tokens.ts";
import type { ChapterIndexNode, SectionIndexNode, Span } from "./types.ts";

/** Chapters at or above this token count get a full section tree; below it, headings collapse to `key_items` (`docs/INDEXING.md`, "SECTION THRESHOLD"). */
export const SECTION_TOKEN_THRESHOLD = 800;

export interface BuildChapterIndexNodeInput {
  readonly ulid: string;
  readonly volumeTitle: string;
  readonly chapterSlug: string;
  readonly chapterTitle: string;
  readonly body: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  /** OKF v0.2 concept type from the chapter's typed fields (OKF §4.1). */
  readonly type?: string;
  /** OKF v0.2 lifecycle status from the chapter's typed fields (OKF §5.4). */
  readonly status?: string;
  /** Volume-relative location, e.g. `volumes/<slug>/chapters/<slug>.md`. */
  readonly file: string;
}

function flattenHeadingTitles(nodes: readonly HeadingNode[]): string[] {
  const titles: string[] = [];
  for (const node of nodes) {
    titles.push(node.title);
    titles.push(...flattenHeadingTitles(node.children));
  }
  return titles;
}

function buildSectionTree(
  nodes: readonly SpannedNode[],
  bodyBytes: Uint8Array,
  chapterUlid: string,
  ancestorSlugs: readonly string[],
  ancestorTitles: readonly string[],
): SectionIndexNode[] {
  return nodes.map((node): SectionIndexNode => {
    const slugPath = [...ancestorSlugs, node.slug];
    const titlePath = [...ancestorTitles, node.title];

    const children = buildSectionTree(node.children, bodyBytes, chapterUlid, slugPath, titlePath);
    const childSpans: Span[] = node.children.map((child) => child.span);

    const own = ownText(bodyBytes, node.span, childSpans);
    const contentHash = computeContentHash(own);
    const subtreeHash = computeSubtreeHash(
      contentHash,
      children.map((child) => child.subtree_hash),
    );

    // `tokens` counts the whole span (union semantics: self + descendants),
    // matching the chapter-level example in docs/INDEXING.md where a
    // chapter's `tokens` plainly means its full body, not "own text only".
    const spanText = sliceBytesToText(bodyBytes, node.span.start_byte, node.span.end_byte);

    return {
      node_id: `${chapterUlid}#${slugPath.join("/")}`,
      kind: "section",
      title: node.title,
      level: node.level,
      heading_path: titlePath,
      span: node.span,
      tokens: estimateTokens(spanText),
      content_hash: contentHash,
      subtree_hash: subtreeHash,
      sections: children.length > 0 ? children : undefined,
    };
  });
}

export function buildChapterIndexNode(input: BuildChapterIndexNodeInput): ChapterIndexNode {
  const bodyBytes = toBytes(input.body);
  const topHeadings = parseHeadingTree(input.body);
  const spannedTop = assignSpans(topHeadings, bodyBytes.length);
  const span = chapterSpan(bodyBytes.length);
  const tokens = estimateTokens(input.body);

  const belowThreshold = tokens < SECTION_TOKEN_THRESHOLD;
  const sections = belowThreshold
    ? undefined
    : buildSectionTree(spannedTop, bodyBytes, input.ulid, [], []);
  const keyItems = belowThreshold ? flattenHeadingTitles(topHeadings) : undefined;

  const childSpans: Span[] = sections ? spannedTop.map((node) => node.span) : [];
  const own = ownText(bodyBytes, span, childSpans);
  const contentHash = computeContentHash(own);
  const subtreeHash = computeSubtreeHash(
    contentHash,
    sections ? sections.map((section) => section.subtree_hash) : [],
  );

  // Extract Attested Computation fields from frontmatter (OKF §10.2)
  let attestedComputation: ChapterIndexNode["attestedComputation"];
  if (input.type === "Attested Computation" && input.frontmatter.runtime) {
    const fm = input.frontmatter;
    const parameters = Array.isArray(fm.parameters)
      ? (fm.parameters as Array<Record<string, unknown>>)
          .filter(
            (p): p is { name: string; type: string; required: boolean } =>
              typeof p?.name === "string" &&
              typeof p?.type === "string" &&
              typeof p?.required === "boolean",
          )
      : [];
    attestedComputation = {
      runtime: String(fm.runtime),
      parameters,
      computation: typeof fm.computation === "string" ? fm.computation : undefined,
      executor: {
        resource: typeof (fm.executor as Record<string, unknown> | null)?.resource === "string"
          ? String((fm.executor as Record<string, unknown>).resource)
          : "",
        receipt: Array.isArray((fm.executor as Record<string, unknown> | null)?.receipt)
          ? ((fm.executor as Record<string, unknown>).receipt as string[])
          : [],
      },
      attester: {
        resource: typeof (fm.attester as Record<string, unknown> | null)?.resource === "string"
          ? String((fm.attester as Record<string, unknown>).resource)
          : "",
      },
    };
  }

  return {
    node_id: input.ulid,
    kind: "chapter",
    title: input.chapterTitle,
    slug: input.chapterSlug,
    path: [input.volumeTitle, input.chapterTitle],
    file: input.file,
    when_to_use: coerceRoutingText(input.frontmatter.when_to_use),
    not_for: coerceRoutingText(input.frontmatter.not_for),
    keywords: coerceStringArray(input.frontmatter.keywords),
    confidence: coerceConfidence(input.frontmatter.confidence),
    supersedes: coerceStringArray(input.frontmatter.supersedes),
    aliases: coerceStringArray(input.frontmatter.aliases),
    type: input.type,
    status: input.status,
    attestedComputation,
    updated: coerceDateLike(input.frontmatter.updated),
    tokens,
    span,
    content_hash: contentHash,
    subtree_hash: subtreeHash,
    sections,
    key_items: keyItems,
  };
}
