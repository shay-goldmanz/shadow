/**
 * `GET/POST /api/volumes`, `GET/PATCH/DELETE /api/volumes/:slug`
 * (`docs/API.md` §Volumes). Every handler is a thin call into
 * `@shadow/core`'s `VolumeStore` — no validation here beyond shaping the
 * request into what `VolumeStore` already expects; slug validity and
 * existence are `@shadow/core`'s decisions (`InvalidSlugError`,
 * `VolumeNotFoundError`, `VolumeAlreadyExistsError`), surfaced through
 * `error-mapping.ts`.
 */

import { type Chapter, slugify, toVolumeSlug, type VolumeUpdate } from "@shadow/core";
import type { BunRequest } from "bun";
import type { ApiDeps } from "../deps.ts";
import { InvalidRequestError } from "../errors.ts";
import { jsonResponse } from "../http.ts";

/** `docs/API.md` names this `ChapterSummary` inside `GET /api/volumes/:slug`'s response; the body is the one field worth omitting from a list view (it can be many KB of prose per chapter). */
function toChapterSummary(chapter: Chapter) {
  return {
    slug: chapter.slug,
    title: chapter.title,
    frontmatter: chapter.frontmatter,
    createdAt: chapter.createdAt,
    updatedAt: chapter.updatedAt,
  };
}

export async function listVolumes(deps: ApiDeps): Promise<Response> {
  const volumes = await deps.volumeStore.listVolumes();
  return jsonResponse({ volumes });
}

interface CreateVolumeBody {
  readonly slug?: unknown;
  readonly title?: unknown;
  readonly description?: unknown;
}

export async function createVolume(deps: ApiDeps, req: BunRequest): Promise<Response> {
  const body = (await req.json()) as CreateVolumeBody;
  if (typeof body.title !== "string" || body.title.trim().length === 0) {
    throw new InvalidRequestError("title is required and must be a non-empty string");
  }
  if (body.slug !== undefined && typeof body.slug !== "string") {
    throw new InvalidRequestError("slug must be a string when provided");
  }
  if (body.description !== undefined && typeof body.description !== "string") {
    throw new InvalidRequestError("description must be a string when provided");
  }

  // `slug` is derived from `title` when omitted (`docs/API.md`). `slugify`
  // is best-effort and can return `""` for a title with no alphanumerics —
  // `toVolumeSlug` then throws `InvalidSlugError`, which `error-mapping.ts`
  // maps to 400, exactly the "invalid slug is 400, not 500" contract.
  const slug = toVolumeSlug(body.slug ?? slugify(body.title));

  const volume = await deps.volumeStore.createVolume({
    slug,
    title: body.title,
    description: body.description,
  });
  return jsonResponse({ volume }, { status: 201 });
}

export async function getVolume(
  deps: ApiDeps,
  req: BunRequest<"/api/volumes/:slug">,
): Promise<Response> {
  const slug = toVolumeSlug(req.params.slug);
  const [volume, chapters] = await Promise.all([
    deps.volumeStore.getVolume(slug),
    deps.volumeStore.listChapters(slug),
  ]);
  return jsonResponse({ volume, chapters: chapters.map(toChapterSummary) });
}

interface UpdateVolumeBody {
  readonly title?: unknown;
  readonly description?: unknown;
  readonly frontmatter?: unknown;
}

export async function updateVolume(
  deps: ApiDeps,
  req: BunRequest<"/api/volumes/:slug">,
): Promise<Response> {
  const slug = toVolumeSlug(req.params.slug);
  const body = (await req.json()) as UpdateVolumeBody;

  if (body.title !== undefined && typeof body.title !== "string") {
    throw new InvalidRequestError("title must be a string when provided");
  }
  if (body.description !== undefined && typeof body.description !== "string") {
    throw new InvalidRequestError("description must be a string when provided");
  }
  if (
    body.frontmatter !== undefined &&
    (typeof body.frontmatter !== "object" ||
      body.frontmatter === null ||
      Array.isArray(body.frontmatter))
  ) {
    throw new InvalidRequestError("frontmatter must be an object when provided");
  }

  // Only forward keys the request actually set — `VolumeUpdate`'s own
  // contract is "omitted fields left unchanged" (`@shadow/core`), and
  // `frontmatter` replaces wholesale rather than merging (also
  // `@shadow/core`'s decision, not this handler's).
  const patch: VolumeUpdate = {
    ...(body.title !== undefined ? { title: body.title as string } : {}),
    ...(body.description !== undefined ? { description: body.description as string } : {}),
    ...(body.frontmatter !== undefined
      ? { frontmatter: body.frontmatter as Record<string, unknown> }
      : {}),
  };

  const volume = await deps.volumeStore.updateVolume(slug, patch);
  return jsonResponse({ volume });
}

export async function deleteVolume(
  deps: ApiDeps,
  req: BunRequest<"/api/volumes/:slug">,
): Promise<Response> {
  const slug = toVolumeSlug(req.params.slug);
  await deps.volumeStore.deleteVolume(slug);
  return jsonResponse({ deleted: true });
}
