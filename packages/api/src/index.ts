/**
 * @shadow/api — the transport adapter between `@shadow/web` and every
 * pillar beneath it (`docs/API.md`, `ARCHITECTURE.md`). Holds no domain
 * logic: every handler is a thin call into `@shadow/agent`, `@shadow/core`,
 * `@shadow/indexing`, or `@shadow/evidence`.
 *
 * Three exports matter to a caller:
 * - `createServer(deps, options)` — starts the Bun HTTP server given an
 *   already-built `ApiDeps`. Routing and handlers never construct their
 *   own collaborators, so a caller can pass real ones (`buildRealApiDeps`)
 *   or fakes (tests).
 * - `buildRealApiDeps(options)` — the composition root: wires
 *   `FileSystemVolumeStore`, `FileSystemEvidenceStore`, `StructuralIndexer`,
 *   `PerBriefResearchAgent`, the Tier 2 `Batched*` adapters, and
 *   `@shadow/model`'s real ports into one `ApiDeps`. Used by `start.ts`
 *   only — nothing in a test should import it.
 * - `ApiDeps` — the seam every handler is written against.
 */

export type { BuildRealApiDepsOptions } from "./composition.ts";
export { buildRealApiDeps } from "./composition.ts";
export type { ApiDeps } from "./deps.ts";
export type { ErrorResponse, ErrorResponseBody } from "./error-mapping.ts";
export { toErrorResponse } from "./error-mapping.ts";
export {
  IndexNotBuiltError,
  InvalidRequestError,
  RouteNotFoundError,
  SessionNotFoundError,
  ShadowApiError,
} from "./errors.ts";
export type { CreateServerOptions, ShadowApiServer } from "./server.ts";
export { createServer } from "./server.ts";
