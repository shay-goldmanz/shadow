/**
 * The route table: every path in `docs/API.md`, wired to its handler. This
 * is the ONE file that knows the URL shape — handlers (`handlers/*.ts`)
 * only know `BunRequest<ExactPath>`, and `composition.ts` only knows how
 * to build an `ApiDeps`. Bun's native `routes` option (`Bun.serve`) does
 * the actual path-param extraction and method dispatch; nothing here
 * reimplements a router.
 */

import type { ApiDeps } from "./deps.ts";
import { toErrorResponse } from "./error-mapping.ts";
import { RouteNotFoundError } from "./errors.ts";
import { deleteChapter, getChapter, putChapter } from "./handlers/chapters.ts";
import { postChat } from "./handlers/chat.ts";
import { getLedger, getSnapshot, getSource } from "./handlers/evidence.ts";
import { getIndex, reindex } from "./handlers/indexing.ts";
import { getLint } from "./handlers/lint.ts";
import { getSessionEvents } from "./handlers/session-events.ts";
import {
  createVolume,
  deleteVolume,
  getVolume,
  listVolumes,
  updateVolume,
} from "./handlers/volumes.ts";
import { corsPreflightResponse, jsonResponse } from "./http.ts";

// biome-ignore lint/suspicious/noExplicitAny: BunRequest is generic per literal path; a single wrapper has to erase that to stay reusable across every route, and JS's "fewer params is compatible with more" rule lets each concretely-typed handler (some take no `req` at all) still satisfy this.
type AnyHandler = (deps: ApiDeps, req: any) => Promise<Response>;

/** Wraps a handler so a thrown pillar/API error becomes `docs/API.md`'s JSON error envelope instead of an unhandled rejection. The one place every route's errors funnel through `error-mapping.ts`. */
function bind(deps: ApiDeps, handler: AnyHandler): (req: any) => Promise<Response> {
  return async (req: any) => {
    try {
      return await handler(deps, req);
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return jsonResponse(body, { status });
    }
  };
}

/** Builds the full `Bun.serve({ routes })` table for a given `ApiDeps`. Kept separate from `server.ts` so tests can inspect/reuse it without spinning up a real listener if they ever need to. */
export function buildRoutes(deps: ApiDeps) {
  return {
    "/api/volumes": {
      GET: bind(deps, listVolumes),
      POST: bind(deps, createVolume),
      OPTIONS: () => corsPreflightResponse(),
    },
    "/api/volumes/:slug": {
      GET: bind(deps, getVolume),
      PATCH: bind(deps, updateVolume),
      DELETE: bind(deps, deleteVolume),
      OPTIONS: () => corsPreflightResponse(),
    },
    "/api/volumes/:slug/chapters/:chapter": {
      GET: bind(deps, getChapter),
      PUT: bind(deps, putChapter),
      DELETE: bind(deps, deleteChapter),
      OPTIONS: () => corsPreflightResponse(),
    },
    "/api/volumes/:slug/index": {
      GET: bind(deps, getIndex),
      OPTIONS: () => corsPreflightResponse(),
    },
    "/api/volumes/:slug/reindex": {
      POST: bind(deps, reindex),
      OPTIONS: () => corsPreflightResponse(),
    },
    "/api/lint": {
      GET: bind(deps, getLint),
      OPTIONS: () => corsPreflightResponse(),
    },
    "/api/volumes/:slug/evidence/sources/:id": {
      GET: bind(deps, getSource),
      OPTIONS: () => corsPreflightResponse(),
    },
    "/api/volumes/:slug/evidence/snapshot/:hash": {
      GET: bind(deps, getSnapshot),
      OPTIONS: () => corsPreflightResponse(),
    },
    "/api/volumes/:slug/evidence/ledger": {
      GET: bind(deps, getLedger),
      OPTIONS: () => corsPreflightResponse(),
    },
    "/api/chat": {
      POST: bind(deps, postChat),
      OPTIONS: () => corsPreflightResponse(),
    },
    "/api/sessions/:id/events": {
      GET: bind(deps, getSessionEvents),
      OPTIONS: () => corsPreflightResponse(),
    },
  } as const;
}

/** Fallback for anything `routes` didn't match — `docs/API.md`'s error envelope, 404, `route_not_found`. */
export function notFoundFallback(req: Request): Response {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  const { status, body } = toErrorResponse(
    new RouteNotFoundError(req.method, new URL(req.url).pathname),
  );
  return jsonResponse(body, { status });
}
