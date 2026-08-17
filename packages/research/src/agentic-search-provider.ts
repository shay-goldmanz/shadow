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
 * ## One-shot sessions, not shared (T0.5)
 *
 * This class used to lazily create **one** `AgenticSession` and reuse it
 * for every `search()` call on the instance, exactly like
 * `WebResearchToolAgent` used to (D6) — with no busy guard. Under T0.2's
 * parallel research briefs (and cross-session parallelism generally),
 * concurrent `search()` calls on the shared instance in `composition.ts`
 * would have run concurrent `query()` subprocesses resuming the *same* SDK
 * session id: two processes appending to one transcript at once — exactly
 * the duplicate-resume race
 * `docs/superpowers/specs/shadow-sessions/PLAN.md` (T0.5) exists to make
 * unrepresentable. `PerBriefResearchAgent` closed the analogous hole for
 * the research tool-agent itself (T0.1); this class needed the same fix
 * for the same reason.
 *
 * The fix: every `search()` call builds a brand-new session via
 * `createSession()` below, with `persistSession: false`. A single
 * `search()` is a single turn, so the cross-call `resume` rationale for
 * reuse never applied here to begin with — there is no second turn to
 * resume. This makes the provider itself stateless: no instance field
 * holds a session, so there is nothing left to race, and no orphaned
 * `~/.claude/projects/` transcript accumulates per call either, since a
 * non-persisted session is never written there.
 *
 * This does re-pay the Claude Code preamble (~18k cache-write tokens) on
 * every `search()` call instead of once per provider instance. T0.4
 * measures whether that is actually expensive once cross-session prompt
 * caching is accounted for; if it proves prohibitive, the plan's recorded
 * fallback is an internal FIFO queue on this provider instead of one-shot
 * sessions — not implemented here, since T0.5's default is this simple,
 * stateless fix.
 *
 * `close()` is deliberately not called on the session after the turn: per
 * `AgenticSession.close()`'s own doc (`@shadow/model`), it is a no-op for a
 * session created with `persistSession: false`, because nothing was ever
 * written to `~/.claude/projects/` for it to delete. Calling it would cost
 * nothing but buy nothing either, so it is skipped — the same call
 * `PerBriefResearchAgent`'s one-shot sessions make (T0.1).
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

/** The reference `SearchProvider` implementation — see the module doc. Stateless: no session lives across `search()` calls (T0.5). */
export class AgenticSearchProvider implements SearchProvider {
  constructor(private readonly deps: AgenticSearchProviderDeps) {}

  async search(request: SearchRequest, _fetchImpl: FetchLike): Promise<SearchResponse> {
    const session = this.createSession();
    const prompt = buildSearchPrompt(request);
    const result = await runToCompletion(session, prompt);

    if (result.isError) {
      throw new SearchSessionTurnFailedError(request.query, result.stopReason, result.text);
    }

    const hits = parseSearchResults(request.query, result.text, request.maxResults);

    // Deliberately not calling `session.close()` here — see the module
    // doc's "One-shot sessions, not shared" section: a `persistSession:
    // false` session was never written to `~/.claude/projects/`, so
    // `close()` on it is a documented no-op.

    return {
      query: request.query,
      hits,
      retrievedAt: new Date().toISOString(),
      transport: "live",
    };
  }

  /** Builds a fresh, non-persisted, one-shot session for a single `search()` call — see the module doc's "One-shot sessions, not shared" section (T0.5). */
  private createSession(): AgenticSession {
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
      // This session receives exactly one turn, ever — one `search()` call
      // is one turn — so there is no second turn to `resume` and nothing
      // that needs persisting. See the module doc (T0.5) for the
      // concurrency hazard this closes: reusing one handle across calls
      // meant concurrent `search()`s could resume the same SDK session id
      // from two subprocesses at once.
      persistSession: false,
    };

    return this.deps.sessions.createSession(options);
  }
}
