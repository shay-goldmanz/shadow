/**
 * Record mode: wraps another transport (in practice always a
 * `LiveTransport`) and persists everything it fetches into a
 * `FixtureCorpus` before returning it. This is how the fixture corpus
 * consumed by tests gets built and refreshed — run once against `record`,
 * commit the resulting fixture files, and every test after that runs
 * against `replay` with no network involved.
 */

import type { FixtureCorpus } from "./fixture-corpus.ts";
import type {
  FetchedPage,
  FetchRequest,
  RetrievalTransport,
  SearchRequest,
  SearchResponse,
} from "./types.ts";

export class RecordTransport implements RetrievalTransport {
  constructor(
    private readonly inner: RetrievalTransport,
    private readonly corpus: FixtureCorpus,
  ) {}

  async fetchPage(request: FetchRequest): Promise<FetchedPage> {
    const page = await this.inner.fetchPage(request);
    await this.corpus.writePage(page);
    return page;
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const response = await this.inner.search(request);
    await this.corpus.writeSearch(response, request.maxResults);
    return response;
  }
}
