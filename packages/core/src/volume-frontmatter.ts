/**
 * Serialization of a `Volume` to/from its on-disk form: `VOLUME.md`, a
 * Markdown file with a YAML frontmatter block — the volume-level
 * counterpart of `frontmatter.ts`'s chapter documents.
 *
 * ```
 * ---
 * title: Interface Design
 * when_to_use: Designing UI: layout, density, navigation, component behavior.
 * not_for: brand identity, illustration, motion design
 * keywords: [linear, notion, density]
 * ---
 * How Linear and Notion design interfaces.
 * ```
 *
 * Frontmatter round-trips losslessly, including keys this package doesn't
 * know about: `title`, `createdAt`, and `updatedAt` are pulled out as typed
 * fields, and every other key — in whatever order it appeared, including
 * nested objects and arrays — passes through unchanged as `frontmatter`.
 * That's load-bearing for the same reason it is for chapters:
 * `@shadow/indexing` attaches volume-level routing fields (`when_to_use`,
 * `not_for`, `keywords`, ...) that this package must never touch or drop
 * (`docs/INDEXING.md`).
 *
 * The body after the closing fence is the volume's `description` — the
 * same free-text field `volume.json` (the legacy format still read by
 * `FileSystemVolumeStore` for backward compatibility) stored as a JSON
 * string. Moving it to the document body rather than a frontmatter field
 * keeps this format's shape identical to a chapter's: typed fields in
 * frontmatter, prose as the body.
 *
 * Uses `Bun.YAML` (bundled with the Bun runtime since 1.3 — see D7) rather
 * than a YAML dependency.
 */

import { VolumeParseError } from "./errors.ts";
import {
  FRONTMATTER_PATTERN,
  hasReservedStringFields,
  isRecord,
  RESERVED_DOCUMENT_KEYS as RESERVED_KEYS,
} from "./frontmatter-shared.ts";
import type { VolumeSlug } from "./slug.ts";
import type { Volume } from "./types.ts";

/** Serialize a volume's content into the on-disk Markdown + frontmatter document (`VOLUME.md`). */
export function serializeVolumeDocument(
  volume: Pick<Volume, "title" | "description" | "frontmatter" | "createdAt" | "updatedAt">,
): string {
  const document: Record<string, unknown> = {
    title: volume.title,
    createdAt: volume.createdAt.toISOString(),
    updatedAt: volume.updatedAt.toISOString(),
    ...volume.frontmatter,
  };
  const yaml = Bun.YAML.stringify(document, null, 2);
  return `---\n${yaml}\n---\n${volume.description}`;
}

/** Parse an on-disk `VOLUME.md` document back into a `Volume`. */
export function parseVolumeDocument(slug: VolumeSlug, raw: string): Volume {
  const match = FRONTMATTER_PATTERN.exec(raw);
  if (!match) {
    throw new VolumeParseError(slug, "missing YAML frontmatter delimited by --- lines");
  }
  const [, yamlSource, body] = match;

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(yamlSource ?? "");
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new VolumeParseError(slug, `invalid frontmatter YAML: ${message}`);
  }

  if (!isRecord(parsed) || !hasReservedStringFields(parsed)) {
    throw new VolumeParseError(
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
    description: body ?? "",
    frontmatter,
    createdAt: new Date(parsed.createdAt),
    updatedAt: new Date(parsed.updatedAt),
  };
}
