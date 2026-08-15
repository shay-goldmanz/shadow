/**
 * The `Rulebook` domain type plus serialization of it to/from its on-disk
 * form: `RULEBOOK.md`, a Markdown file with a YAML frontmatter block — the
 * rule-book-level counterpart of `frontmatter.ts`'s chapter (here, group)
 * documents. Copies `volume-frontmatter.ts`'s pattern rather than
 * generalizing over it — the codebase deliberately duplicates the
 * parse/serialize shape per document kind (see that file's doc comment).
 *
 * ```
 * ---
 * title: Loan Agreement Rules
 * type: Rule Book
 * status: draft
 * generated: { by: "rulebook-extraction@0.1.0", at: "2026-08-14T00:00:00.000Z" }
 * source_doc:
 *   url: file:///path/to/rnb_loan.pdf
 *   payload_sha256: sha256:...
 *   snapshot_sha256: sha256:...
 * when_to_use: Answering questions about this loan agreement's terms.
 * keywords: [loan, interest-rate, default]
 * createdAt: 2026-08-14T00:00:00.000Z
 * updatedAt: 2026-08-14T00:00:00.000Z
 * ---
 * A rule book extracted from the loan agreement.
 * ```
 *
 * A rule book has no opaque `frontmatter` passthrough bag the way `Volume`/
 * `Chapter` do — nothing downstream attaches extra routing keys to a rule
 * book yet (corpus-index integration is explicitly deferred), so there is
 * nothing to preserve losslessly. `whenToUse`/
 * `notFor`/`keywords` are instead typed fields directly on `Rulebook`,
 * matching the shape `@shadow/indexing`'s `routing-fields.ts` coerces
 * volume/chapter frontmatter into (`string | undefined`, `string | undefined`,
 * `readonly string[]`) — chosen so a future indexing integration can adopt
 * these fields without a shape change.
 *
 * Uses `Bun.YAML` (bundled with the Bun runtime since 1.3 — see D7) rather
 * than a YAML dependency, same as `volume-frontmatter.ts`.
 */

import { RulebookParseError } from "./errors.ts";
import {
  FRONTMATTER_PATTERN,
  hasRequiredTypedFields,
  isRecord,
  parseOkfActor,
  parseOkfStatus,
  parseVerified,
} from "./frontmatter-shared.ts";
import type { VolumeSlug } from "./slug.ts";
import type { OkfActor, OkfStatus } from "./types.ts";

/** A rule book's provenance: the local document it was extracted from. */
export interface RulebookSourceDoc {
  readonly url: string;
  readonly payloadSha256: string;
  readonly snapshotSha256: string;
}

/**
 * A rule book: its own bundle kind under `<shadow-root>/rulebooks/<slug>/`,
 * deliberately not a volume (see `rulebook-layout.ts`). Groups of rules live
 * alongside it as chapter-shaped documents (`Chapter`/`ChapterInput` from
 * `types.ts`, reused as-is).
 */
export interface Rulebook {
  readonly slug: VolumeSlug;
  readonly title: string;
  readonly description: string;
  /** OKF-shaped concept type. Defaults to `"Rule Book"`. */
  readonly type: string;
  /** OKF lifecycle status. Defaults to `"draft"`. */
  readonly status: OkfStatus;
  /** OKF `generated` — how the content was produced (OKF §5.2). */
  readonly generated: OkfActor;
  /** OKF `verified` — who confirmed the content. Empty array = unverified (OKF §5.3). */
  readonly verified: readonly OkfActor[];
  /** The local document this rule book was extracted from. `null` until extraction has run. */
  readonly sourceDoc: RulebookSourceDoc | null;
  /** Routing metadata, matching `@shadow/indexing`'s coerced shape for `when_to_use`. */
  readonly whenToUse?: string;
  /** Routing metadata, matching `@shadow/indexing`'s coerced shape for `not_for`. */
  readonly notFor?: string;
  /** Routing metadata, matching `@shadow/indexing`'s coerced shape for `keywords`. */
  readonly keywords: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Input to `RulebookStore.createRulebook`/`updateRulebook`. Both are
 * upserts over the same shape — see `RulebookStore`'s doc for why there is
 * no separate patch type the way `VolumeUpdate` is separate from
 * `VolumeInput`.
 */
export interface RulebookInput {
  readonly slug: VolumeSlug;
  readonly title: string;
  /** Defaults to `""` on create; preserved on update when omitted. */
  readonly description?: string;
  /** Defaults to `"Rule Book"` on create; preserved on update when omitted. */
  readonly type?: string;
  /** Defaults to `"draft"` on create; preserved on update when omitted. */
  readonly status?: OkfStatus;
  /** Defaults to `{ by: "unknown", at: now }` on create; preserved on update when omitted. */
  readonly generated?: OkfActor;
  /** Defaults to `[]` on create; preserved on update when omitted. */
  readonly verified?: readonly OkfActor[];
  /** Defaults to `null` on create; preserved on update when omitted. Pass `null` explicitly to clear it. */
  readonly sourceDoc?: RulebookSourceDoc | null;
  /** Preserved on update when omitted. */
  readonly whenToUse?: string;
  /** Preserved on update when omitted. */
  readonly notFor?: string;
  /** Defaults to `[]` on create; preserved on update when omitted. */
  readonly keywords?: readonly string[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseSourceDoc(raw: unknown): RulebookSourceDoc | null {
  if (!isRecord(raw)) return null;
  if (
    typeof raw.url !== "string" ||
    typeof raw.payload_sha256 !== "string" ||
    typeof raw.snapshot_sha256 !== "string"
  ) {
    return null;
  }
  return { url: raw.url, payloadSha256: raw.payload_sha256, snapshotSha256: raw.snapshot_sha256 };
}

/** Serialize a rule book's content into the on-disk Markdown + frontmatter document (`RULEBOOK.md`). */
export function serializeRulebookDocument(
  rulebook: Pick<
    Rulebook,
    | "title"
    | "description"
    | "createdAt"
    | "updatedAt"
    | "type"
    | "status"
    | "generated"
    | "verified"
    | "sourceDoc"
    | "whenToUse"
    | "notFor"
    | "keywords"
  >,
): string {
  const document: Record<string, unknown> = {
    title: rulebook.title,
    type: rulebook.type,
    status: rulebook.status,
    generated: { by: rulebook.generated.by, at: rulebook.generated.at.toISOString() },
    ...(rulebook.verified.length > 0
      ? { verified: rulebook.verified.map((v) => ({ by: v.by, at: v.at.toISOString() })) }
      : {}),
    ...(rulebook.sourceDoc !== null
      ? {
          source_doc: {
            url: rulebook.sourceDoc.url,
            payload_sha256: rulebook.sourceDoc.payloadSha256,
            snapshot_sha256: rulebook.sourceDoc.snapshotSha256,
          },
        }
      : {}),
    ...(rulebook.whenToUse !== undefined ? { when_to_use: rulebook.whenToUse } : {}),
    ...(rulebook.notFor !== undefined ? { not_for: rulebook.notFor } : {}),
    ...(rulebook.keywords.length > 0 ? { keywords: rulebook.keywords } : {}),
    createdAt: rulebook.createdAt.toISOString(),
    updatedAt: rulebook.updatedAt.toISOString(),
  };
  const yaml = Bun.YAML.stringify(document, null, 2);
  return `---\n${yaml}\n---\n${rulebook.description}`;
}

/** Parse an on-disk `RULEBOOK.md` document back into a `Rulebook`. */
export function parseRulebookDocument(slug: VolumeSlug, raw: string): Rulebook {
  const match = FRONTMATTER_PATTERN.exec(raw);
  if (!match) {
    throw new RulebookParseError(slug, "missing YAML frontmatter delimited by --- lines");
  }
  const [, yamlSource, body] = match;

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(yamlSource ?? "");
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new RulebookParseError(slug, `invalid frontmatter YAML: ${message}`);
  }

  if (!isRecord(parsed) || !hasRequiredTypedFields(parsed)) {
    throw new RulebookParseError(
      slug,
      "frontmatter must be a mapping with string title, type, createdAt, and updatedAt fields",
    );
  }

  const status = parseOkfStatus(parsed.status);
  const generated = parseOkfActor(parsed.generated) ?? {
    by: "unknown",
    at: new Date(parsed.createdAt),
  };
  const verified = parseVerified(parsed.verified);
  const sourceDoc = parseSourceDoc(parsed.source_doc);
  const whenToUse = typeof parsed.when_to_use === "string" ? parsed.when_to_use : undefined;
  const notFor = typeof parsed.not_for === "string" ? parsed.not_for : undefined;
  const keywords = isStringArray(parsed.keywords) ? parsed.keywords : [];

  return {
    slug,
    title: parsed.title,
    description: body ?? "",
    type: parsed.type,
    status,
    generated,
    verified,
    sourceDoc,
    whenToUse,
    notFor,
    keywords,
    createdAt: new Date(parsed.createdAt),
    updatedAt: new Date(parsed.updatedAt),
  };
}
