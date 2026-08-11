/**
 * Replay mode: reads exclusively from a `FixtureCorpus` on disk. This
 * module never imports `fetch` or anything network-capable — it is
 * structurally incapable of reaching the network, not merely configured
 * not to. A cache miss throws `FixtureMissError` rather than falling
 * through to a live fetch (D2): a silent fallback would reintroduce
 * network non-determinism into what is supposed to be an offline, frozen
 * corpus, defeating the entire point of recording it.
 */

import { FixtureMissError } from "./errors.ts";
import type { FixtureCorpus } from "./fixture-corpus.ts";
import type {
  FetchedPage,
  FetchRequest,
  RetrievalTransport,
  SearchRequest,
  SearchResponse,
} from "./types.ts";

export class ReplayTransport implements RetrievalTransport {
  constructor(private readonly corpus: FixtureCorpus) {}

  async fetchPage(request: FetchRequest): Promise<FetchedPage> {
    const hit = await this.corpus.readPage(request.url);
    if (!hit) throw new FixtureMissError("page", request.url, this.corpus.root);
    return hit;
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const hit = await this.corpus.readSearch(request.query, request.maxResults);
    if (!hit) throw new FixtureMissError("search", request.query, this.corpus.root);
    return hit;
  }
}
