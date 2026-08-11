/**
 * Serialization of a `Chapter` to/from its on-disk form: a Markdown file
 * with a YAML frontmatter block.
 *
 * ```
 * ---
 * title: Designing one-pagers
 * when_to_use: [designing a one-pager, editorial density]
 * ---
 * # Body starts here
 * ```
 *
 * Frontmatter round-trips losslessly, including keys this package doesn't
 * know about: `title`, `createdAt`, and `updatedAt` are pulled out as typed
 * fields, and every other key — in whatever order it appeared, including
 * nested objects and arrays — passes through unchanged as `frontmatter`.
 * That's load-bearing: `@shadow/indexing` attaches routing fields
 * (`when_to_use`, `not_for`, ...) that this package must never touch or
 * drop.
 *
 * Uses `Bun.YAML` (bundled with the Bun runtime since 1.3 — see D7) rather
 * than a YAML dependency.
 */

import { ChapterParseError } from "./errors.ts";
import {
  FRONTMATTER_PATTERN,
  hasReservedStringFields,
  isRecord,
  RESERVED_DOCUMENT_KEYS as RESERVED_KEYS,
} from "./frontmatter-shared.ts";
import type { ChapterSlug } from "./slug.ts";
import type { Chapter } from "./types.ts";

/** Serialize a chapter's content into the on-disk Markdown + frontmatter document. */
export function serializeChapterDocument(
  chapter: Pick<Chapter, "title" | "body" | "frontmatter" | "createdAt" | "updatedAt">,
): string {
  const document: Record<string, unknown> = {
    title: chapter.title,
    createdAt: chapter.createdAt.toISOString(),
    updatedAt: chapter.updatedAt.toISOString(),
    ...chapter.frontmatter,
  };
  const yaml = Bun.YAML.stringify(document, null, 2);
  return `---\n${yaml}\n---\n${chapter.body}`;
}

/** Parse an on-disk chapter document back into a `Chapter`. */
export function parseChapterDocument(slug: ChapterSlug, raw: string): Chapter {
  const match = FRONTMATTER_PATTERN.exec(raw);
  if (!match) {
    throw new ChapterParseError(slug, "missing YAML frontmatter delimited by --- lines");
  }
  const [, yamlSource, body] = match;

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(yamlSource ?? "");
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new ChapterParseError(slug, `invalid frontmatter YAML: ${message}`);
  }

  if (!isRecord(parsed) || !hasReservedStringFields(parsed)) {
    throw new ChapterParseError(
      slug,
      "frontmatter must be a mapping with string title, createdAt, and updatedAt fields",
    );
  }

  const frontmatter: Record<string, unknown> = { ...parsed };
  for (const key of RESERVED_KEYS) {
    delete frontmatter[key];
  }

  return {
    slug,
    title: parsed.title,
    body: body ?? "",
    frontmatter,
    createdAt: new Date(parsed.createdAt),
    updatedAt: new Date(parsed.updatedAt),
  };
}
