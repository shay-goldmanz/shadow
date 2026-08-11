/**
 * `AgenticSearchProvider` — a `SearchProvider` (`types.ts`) backed by
 * `@shadow/model`'s agentic session port, running Claude Code's built-in
 * `WebSearch` tool on the operator's subscription (D5). This is what
 * `LiveTransport.search()` was missing: T2.1a shipped the port and the
 * replay/record paths complete, and deliberately left live search
 * unimplemented rather than inventing an API-key dependency (see
 * `LiveSearchUnavailableError`). The operator has no search-provider API
 * key — Claude Code's `WebSearch` runs on the subscription already paying
 * for everything else, so it is the only legitimate live search backend
 * under `docs/ACCEPTANCE.md`'s "subscriptions, not API keys" constraint.
 *
 * ## This is a different session from the research tool-agent's, on purpose
 *
 * `WebResearchToolAgent` (`web-research-tool-agent.ts`) is the piece that
 * must never touch the network directly — its whole point is that a source
 * record can only be originated from an actual `fetch` through the
 * injected `RetrievalTransport` (D23), so its session's `disallowedTools`
 * explicitly names `WebSearch` alongside `WebFetch`/`Bash`. This class is
 * the other side of that seam: it is *allowed* to reach `WebSearch`,
 * because it plugs in **underneath** `RetrievalTransport`, as a
 * `SearchProvider` handed to `LiveTransport` — not as a tool the research
 * tool-agent's own session can call. The research tool-agent still only
 * ever calls its own `search`/`fetch`/`submit_findings` tools; `search`'s
 * handler (`retrieval-tools.ts`) calls `RetrievalTransport.search`, which
 * (in live mode) delegates to *this* class in a completely separate
 * session the research tool-agent has no handle on and cannot reach. So
 * the three-layer hardening on `WebResearchToolAgent` stays intact:
 * nothing about wiring this provider in loosens `WebResearchToolAgent`'s
 * own `allowedTools`/`disallowedTools`/`settingSources`.
 *
 * This session is narrow the same way, just for the opposite tool: exactly
 * `WebSearch` allowed, `WebFetch`/`Bash`/`Read`/`Write`/`Edit`/subagent
 * tools explicitly disallowed (belt-and-braces — `allowedTools` alone
 * would already exclude them), and `settingSources: []` so no
 * `.claude/settings.json` anywhere can grant more.
 *
 * ## Metadata only, never page content
 *
 * The session prompt instructs the model to report only what `WebSearch`
 * itself returns — titles, URLs, and (when present) a short description —
 * and never to read or summarize a page's actual content. `WebFetch` is
 * disallowed, so it has no way to fetch a page even if it wanted to; every
 * byte that becomes evidence still arrives through
 * `WebResearchToolAgent`'s own `fetch` tool and a real `RetrievalWitness`
 * (D9/D23). This class only ever returns `SearchHit[]` — a title, url, and
 * optional snippet, never a body.
 *
 * ## Structured output over a text channel
 *
 * `AgenticSession` only exposes `text-delta`/`tool-use`/`tool-result`
 * events and a final buffered `.text` — there is no first-class "structured
 * result" channel on this port (see `../ports/agentic-session.ts`), and
 * this package may not import an AI SDK to reach for one directly (D5).
 * So the system prompt requires the model's final turn text to be *only* a
 * strict JSON object (`{"results":[{"title","url","snippet?"}]}`), and
 * `parseSearchResults` below validates it against a Zod schema. A parse
 * failure — malformed JSON, a shape that doesn't match, or a turn that
 * reported `isError` — throws `SearchResultParseError` /
 * `SearchSessionTurnFailedError` rather than returning `{ hits: [] }`. An
 * empty `hits` array is only ever produced by a *successful* strict parse
 * of `{"results":[]}` — a genuine "nothing found," never a stand-in for
 * "we couldn't tell." Returning empty on failure would be indistinguishable
 * from "the corpus has nothing," which is a lie the operator would act on.
 *
 * ## Session reuse (D6)
 *
 * One session is created lazily on the first `search()` call and reused
 * for every later call on the same instance, exactly like
 * `WebResearchToolAgent` — see that class's doc for why paying the Claude
 * Code preamble once per instance instead of once per query matters.
 *
 * ## Record/replay
 *
 * This class implements `SearchProvider`, so it plugs into
 * `LiveTransportOptions.search` unchanged. `RecordTransport` wraps the
 * `LiveTransport` that wraps this provider and persists whatever it
 * returns into the fixture corpus; `ReplayTransport` never touches this
 * class, or any session, at all — it reads the recorded `SearchResponse`
 * straight off disk. So search is exactly as recordable/replayable as
 * fetch, without either transport needing to know a model session is
 * involved on the live side.
 */

import type { AgenticSession, AgenticSessionOptions, AgenticSessionPort } from "@shadow/model";
import { runToCompletion } from "@shadow/model";
import { z } from "zod";
import { SearchResultParseError, SearchSessionTurnFailedError } from "./errors.ts";
import type {
  FetchLike,
  SearchHit,
  SearchProvider,
  SearchRequest,
  SearchResponse,
} from "./types.ts";

/** Used when a `SearchRequest` does not specify `maxResults`. */
export const DEFAULT_SEARCH_MAX_RESULTS = 8;

export interface SearchProviderSessionTuning {
  readonly model?: string;
  readonly cwd?: string;
  readonly maxTurns?: number;
}

export interface AgenticSearchProviderDeps {
  readonly sessions: AgenticSessionPort;
  readonly sessionTuning?: SearchProviderSessionTuning;
}

const SEARCH_SYSTEM_PROMPT =
  "You are a web search backend for another program, not a chat assistant. For every user " +
  "message: call the WebSearch tool exactly once with the given query, then reply with ONLY a " +
  "single JSON object — no prose, no markdown code fences, nothing before or after it — of " +
  'exactly this shape: {"results":[{"title":"...","url":"...","snippet":"..."}]}. `snippet` is ' +
  "optional; omit the key entirely for a result you have no short description for — never " +
  "invent one. Report only what the WebSearch results themselves show (titles, URLs, and any " +
  "description the search already provided). Do not fetch, browse, or read any page — you have " +
  "no tool to do that with. If the search returns nothing relevant, reply with exactly " +
  '{"results":[]}. Never wrap the JSON in a code fence, never add commentary before or after ' +
  "it, and never report a result WebSearch did not actually return.";

const SearchHitSchema = z.object({
  title: z.string().min(1),
  url: z.string().min(1),
  snippet: z.string().min(1).optional(),
});

const SearchResultsSchema = z.object({
  results: z.array(SearchHitSchema),
});

/** Strips a single leading/trailing ```/```json fence, if the whole trimmed text is wrapped in one. Anything else is left untouched — this is a tolerance for one specific, common way models disobey "no code fences," not a general text-extraction pass; see the module doc's "fail loudly" rationale. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match?.[1] ?? trimmed;
}

/** Parses and strictly validates a search session's final turn text. Throws `SearchResultParseError` — never returns an empty array — on anything that isn't a clean match for the required shape. */
export function parseSearchResults(
  query: string,
  rawText: string,
  maxResults: number | undefined,
): readonly SearchHit[] {
  const candidate = stripCodeFence(rawText);

  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch (cause) {
    throw new SearchResultParseError(
      query,
      rawText,
      `not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }

  const parsed = SearchResultsSchema.safeParse(json);
  if (!parsed.success) {
    throw new SearchResultParseError(
      query,
      rawText,
      `JSON did not match the required {"results":[{"title","url","snippet?"}]} shape ` +
        `(${parsed.error.message})`,
    );
  }

  const hits: SearchHit[] = parsed.data.results.map((hit) =>
    hit.snippet
      ? { title: hit.title, url: hit.url, snippet: hit.snippet }
      : { title: hit.title, url: hit.url },
  );
  return maxResults !== undefined ? hits.slice(0, maxResults) : hits;
}

function buildSearchPrompt(request: SearchRequest): string {
  const cap = request.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS;
  return `Search query: ${request.query}\nReturn at most ${cap} result(s).`;
}

/** The reference `SearchProvider` implementation — see the module doc. */
export class AgenticSearchProvider implements SearchProvider {
  private session: AgenticSession | undefined;

  constructor(private readonly deps: AgenticSearchProviderDeps) {}

  async search(request: SearchRequest, _fetchImpl: FetchLike): Promise<SearchResponse> {
    const session = this.getOrCreateSession();
    const prompt = buildSearchPrompt(request);
    const result = await runToCompletion(session, prompt);

    if (result.isError) {
      throw new SearchSessionTurnFailedError(request.query, result.stopReason, result.text);
    }

    const hits = parseSearchResults(request.query, result.text, request.maxResults);

    return {
      query: request.query,
      hits,
      retrievedAt: new Date().toISOString(),
      transport: "live",
    };
  }

  /** Inspectable for tests/callers that want to confirm session reuse (D6) without a real subprocess. */
  get sessionId(): string | undefined {
    return this.session?.sessionId;
  }

  private getOrCreateSession(): AgenticSession {
    if (this.session) return this.session;

    const options: AgenticSessionOptions = {
      model: this.deps.sessionTuning?.model,
      cwd: this.deps.sessionTuning?.cwd,
      maxTurns: this.deps.sessionTuning?.maxTurns,
      systemPrompt: SEARCH_SYSTEM_PROMPT,
      // Structural hardening, mirroring `WebResearchToolAgent`'s (see the
      // module doc's "This is a different session" section): `WebSearch`
      // is the one tool this session exists to use, and everything that
      // could reach page content, disk, or a shell is named explicitly in
      // `disallowedTools` even though `allowedTools` already excludes them
      // by omission.
      allowedTools: ["WebSearch"],
      disallowedTools: ["WebFetch", "Bash", "Read", "Write", "Edit", "Agent", "Task"],
      settingSources: [],
      permissionMode: "default",
      // Deliberately NOT `persistSession: false` — this handle is reused
      // across every `search()` call on this instance (D6), and reuse
      // after the first turn goes through `resume`, which only works
      // against a persisted session. Same reasoning as
      // `WebResearchToolAgent.getOrCreateSession`; see that method's
      // comment for the incident this guards against.
    };

    this.session = this.deps.sessions.createSession(options);
    return this.session;
  }
}
