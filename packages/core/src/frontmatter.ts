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
  hasRequiredTypedFields,
  isRecord,
  parseOkfActor,
  parseOkfStatus,
  parseStaleAfter,
  parseVerified,
  RESERVED_DOCUMENT_KEYS as RESERVED_KEYS,
  toDateString,
} from "./frontmatter-shared.ts";
import type { ChapterSlug } from "./slug.ts";
import type { Chapter } from "./types.ts";

/** Serialize a chapter's content into the on-disk Markdown + frontmatter document. */
export function serializeChapterDocument(
  chapter: Pick<
    Chapter,
    | "title"
    | "body"
    | "frontmatter"
    | "createdAt"
    | "updatedAt"
    | "type"
    | "status"
    | "staleAfter"
    | "generated"
    | "verified"
  >,
): string {
  const document: Record<string, unknown> = {
    title: chapter.title,
    type: chapter.type,
    status: chapter.status,
    ...(chapter.staleAfter !== null ? { stale_after: toDateString(chapter.staleAfter) } : {}),
    generated: { by: chapter.generated.by, at: chapter.generated.at.toISOString() },
    ...(chapter.verified.length > 0
      ? { verified: chapter.verified.map((v) => ({ by: v.by, at: v.at.toISOString() })) }
      : {}),
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

  if (!isRecord(parsed) || !hasRequiredTypedFields(parsed)) {
    throw new ChapterParseError(
      slug,
      "frontmatter must be a mapping with string title, type, createdAt, and updatedAt fields",
    );
  }

  const frontmatter: Record<string, unknown> = { ...parsed };
  for (const key of RESERVED_KEYS) {
    delete frontmatter[key];
  }

  const status = parseOkfStatus(parsed.status);
  const staleAfter = parseStaleAfter(parsed.stale_after);
  const generated = parseOkfActor(parsed.generated) ?? {
    by: "unknown",
    at: new Date(parsed.createdAt),
  };
  const verified = parseVerified(parsed.verified);

  return {
    slug,
    title: parsed.title,
    body: body ?? "",
    type: parsed.type,
    status,
    staleAfter,
    generated,
    verified,
    frontmatter,
    createdAt: new Date(parsed.createdAt),
    updatedAt: new Date(parsed.updatedAt),
  };
}
