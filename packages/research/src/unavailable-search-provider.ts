/**
 * `SearchProvider` for a model-provider strategy with no live search backend
 * configured — today, `bedrock` (D26). See `SearchUnavailableError`'s doc
 * (`errors.ts`) for the full rationale on why this exists as a distinct
 * class rather than reusing `AgenticSearchProvider` or leaving
 * `LiveTransportOptions.search` unset: leaving it unset would throw
 * `LiveSearchUnavailableError`, a message written for "nobody has wired a
 * search backend into this package at all" — not the more specific,
 * operator-actionable "this particular model provider has none" story this
 * class tells.
 *
 * Composition (`packages/api/src/composition.ts`) plugs this in as
 * `LiveTransportOptions.search` whenever `SHADOW_MODEL_PROVIDER=bedrock` is
 * resolved, in place of `AgenticSearchProvider`. The seam this satisfies —
 * `LiveTransportOptions.search: SearchProvider` — stays exactly as ready for
 * a future real Bedrock-compatible search backend as it always was; this is
 * only what fills the slot until one exists.
 */

import { SearchUnavailableError } from "./errors.ts";
import type { FetchLike, SearchProvider, SearchRequest, SearchResponse } from "./types.ts";

/** A `SearchProvider` whose `search()` always rejects with `SearchUnavailableError` — see the module doc. */
export class UnavailableSearchProvider implements SearchProvider {
  async search(request: SearchRequest, _fetchImpl: FetchLike): Promise<SearchResponse> {
    throw new SearchUnavailableError(request.query);
  }
}
