/**
 * `GET /api/sessions`, `PATCH /api/sessions/:id`, `DELETE /api/sessions/:id`
 * (T3.1, `docs/API.md` §Sessions). Thin calls into `SessionService` — list,
 * rename, and delete a session's *row*; the transcript itself is read via
 * `GET /api/sessions/:id/events` (`session-events.ts`), and turns are sent
 * via `POST /api/chat` (`chat.ts`) — neither is this file's job.
 */

import { toVolumeSlug } from "@shadow/core";
import type { SessionMeta } from "@shadow/sessions";
import type { BunRequest } from "bun";
import type { ApiDeps } from "../deps.ts";
import { InvalidRequestError } from "../errors.ts";
import { jsonResponse } from "../http.ts";

/**
 * `docs/API.md`'s `SessionSummary` — a curated view of `SessionMeta`, not
 * the type itself (mirrors `volumes.ts`'s `toChapterSummary`):
 * `sdkSessionId`/`failedSdkSessionIds` are internal SDK-transcript
 * bookkeeping (`@shadow/model`'s own ids, meaningful only to
 * `SessionService.deleteSession`) — not something a session-list UI (T3.2)
 * has any use for, so they never cross the wire.
 */
function toSessionSummary(meta: SessionMeta) {
  return {
    id: meta.id,
    volume: meta.volume,
    title: meta.title,
    createdAt: meta.createdAt,
    lastActiveAt: meta.lastActiveAt,
  };
}

/**
 * `GET /api/sessions?volume=<slug>` — every session, newest-first
 * (`SessionStore.list`'s ordering doc), across every volume; passing
 * `?volume=` narrows to one. The shape is identical either way (a no-cost
 * extension the plan calls for explicitly) — omitting the query param is
 * "list globally," not "list nothing."
 */
export async function listSessions(
  deps: ApiDeps,
  req: BunRequest<"/api/sessions">,
): Promise<Response> {
  const url = new URL(req.url);
  const volumeParam = url.searchParams.get("volume");
  const sessions = await deps.sessionService.listSessions(
    volumeParam !== null ? { volume: toVolumeSlug(volumeParam) } : undefined,
  );
  return jsonResponse({ sessions: sessions.map(toSessionSummary) });
}

interface UpdateSessionBody {
  readonly title?: unknown;
}

/**
 * `PATCH /api/sessions/:id { title }` — overrides `finishTurn`'s first-turn
 * default title (T2.5) for good. `title` is required and must be a
 * non-empty string, same validation shape `createVolume` uses for its own
 * required `title` field; 404 `session_not_found` if `:id` is unknown
 * (`SessionService.updateTitle`).
 */
export async function updateSession(
  deps: ApiDeps,
  req: BunRequest<"/api/sessions/:id">,
): Promise<Response> {
  const body = (await req.json()) as UpdateSessionBody;
  if (typeof body.title !== "string" || body.title.trim().length === 0) {
    throw new InvalidRequestError("title is required and must be a non-empty string");
  }
  const meta = await deps.sessionService.updateTitle(req.params.id, body.title);
  return jsonResponse({ session: toSessionSummary(meta) });
}

/**
 * `DELETE /api/sessions/:id` — store directory, registry entry, and every
 * SDK transcript (live and failed-first-turn ids alike, F7 review fix) go
 * together; 409 `session_busy` while a turn is running or queued, 404
 * `session_not_found` if `:id` is unknown. See
 * `SessionService.deleteSession`'s doc for the full ordering/crash-safety
 * story.
 */
export async function deleteSession(
  deps: ApiDeps,
  req: BunRequest<"/api/sessions/:id">,
): Promise<Response> {
  await deps.sessionService.deleteSession(req.params.id);
  return jsonResponse({ deleted: true });
}
