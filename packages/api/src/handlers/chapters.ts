/**
 * `GET/PUT/DELETE /api/volumes/:slug/chapters/:chapter` (`docs/API.md`
 * §Chapters).
 *
 * `PUT` is the one handler in this package with more than a single pillar
 * call in it, and it is still not domain logic: `docs/API.md` requires
 * that "a chapter write triggers a re-audit and a reindex" and that "the
 * response carries the audit result" — both already exist as one call,
 * `@shadow/agent`'s exported `publishChapter` (the same function
 * `ShadowConversation` calls after drafting a chapter). This handler's own
 * job is only to get a `ClaimSidecar` in front of `publishChapter` for a
 * chapter written directly through this REST endpoint rather than through
 * Shadow's `shadow:chapter` directive protocol:
 *
 * - If the chapter already has a sidecar (it was drafted by Shadow, or
 *   edited here before), reuse its claims — a hand-edit to prose doesn't
 *   invalidate footnote-bound evidence, and this is exactly what
 *   `publishChapter` already re-audits.
 * - If it has none (a chapter written by hand, from nothing, through this
 *   endpoint, never touched by Shadow), seed an empty one. This is not a
 *   new decision: it is the same thing `@shadow/agent`'s `draftChapter`
 *   already does for a `shadow:chapter` directive with zero `claims[]`,
 *   and D19's own design is that the writer never decides what needs
 *   evidence — the auditor's check-worthiness sweep (`Tier2AuditInput`,
 *   already inside `publishChapter`) independently finds every check-
 *   required sentence regardless of who or what wrote the chapter. A
 *   hand-typed chapter with unsupported claims fails the audit exactly
 *   like a Shadow-drafted one would, which is the whole point of D9 being
 *   a gate rather than a courtesy.
 */

import { publishChapter } from "@shadow/agent";
import type { ChapterInput } from "@shadow/core";
import { toChapterSlug, toVolumeSlug } from "@shadow/core";
import { type ClaimSidecar, sha256Of } from "@shadow/evidence";
import type { BunRequest } from "bun";
import type { ApiDeps } from "../deps.ts";
import { InvalidRequestError } from "../errors.ts";
import { jsonResponse } from "../http.ts";

export async function getChapter(
  deps: ApiDeps,
  req: BunRequest<"/api/volumes/:slug/chapters/:chapter">,
): Promise<Response> {
  const volume = toVolumeSlug(req.params.slug);
  const chapter = toChapterSlug(req.params.chapter);
  const [chapterDoc, claims, audit] = await Promise.all([
    deps.volumeStore.getChapter(volume, chapter),
    deps.evidenceStore.getClaims(volume, chapter),
    deps.evidenceStore.getAudit(volume, chapter),
  ]);
  // `claims`/`audit` are `undefined` when a chapter has never been audited
  // — `JSON.stringify` drops `undefined`-valued keys, which is exactly
  // `docs/API.md`'s `claims?`/`audit?` optionality.
  return jsonResponse({ chapter: chapterDoc, claims, audit });
}

interface PutChapterBody {
  readonly title?: unknown;
  readonly body?: unknown;
  readonly frontmatter?: unknown;
}

export async function putChapter(
  deps: ApiDeps,
  req: BunRequest<"/api/volumes/:slug/chapters/:chapter">,
): Promise<Response> {
  const volume = toVolumeSlug(req.params.slug);
  const chapter = toChapterSlug(req.params.chapter);
  const body = (await req.json()) as PutChapterBody;

  if (typeof body.title !== "string" || body.title.trim().length === 0) {
    throw new InvalidRequestError("title is required and must be a non-empty string");
  }
  if (typeof body.body !== "string") {
    throw new InvalidRequestError("body is required and must be a string");
  }
  if (
    body.frontmatter !== undefined &&
    (typeof body.frontmatter !== "object" ||
      body.frontmatter === null ||
      Array.isArray(body.frontmatter))
  ) {
    throw new InvalidRequestError("frontmatter must be an object when provided");
  }

  const input: ChapterInput = {
    slug: chapter,
    title: body.title,
    body: body.body,
    frontmatter: (body.frontmatter as Record<string, unknown> | undefined) ?? {},
  };
  const chapterDoc = await deps.volumeStore.putChapter(volume, input);

  const existingSidecar = await deps.evidenceStore.getClaims(volume, chapter);
  const sidecar: ClaimSidecar = existingSidecar
    ? { ...existingSidecar, chapterTextSha256: sha256Of(chapterDoc.body) }
    : {
        schemaVersion: "1.0",
        chapter,
        chapterTextSha256: sha256Of(chapterDoc.body),
        claims: [],
      };
  await deps.evidenceStore.putClaims(volume, sidecar);

  const result = await publishChapter(deps, volume, chapter);

  // `publishChapter` may have rewritten the chapter body (conservative
  // repair, D9/D21) — re-read so the response reflects what is actually on
  // disk, not the pre-repair draft.
  const finalChapter = await deps.volumeStore.getChapter(volume, chapter);

  return jsonResponse({
    chapter: finalChapter,
    audit: {
      verdict: result.verdict,
      outcomes: result.outcomes,
      repairs: result.repairs,
      published: result.published,
    },
  });
}

export async function deleteChapter(
  deps: ApiDeps,
  req: BunRequest<"/api/volumes/:slug/chapters/:chapter">,
): Promise<Response> {
  const volume = toVolumeSlug(req.params.slug);
  const chapter = toChapterSlug(req.params.chapter);
  await deps.volumeStore.deleteChapter(volume, chapter);
  return jsonResponse({ deleted: true });
}
