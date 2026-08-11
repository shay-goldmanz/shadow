/**
 * Retrieval capabilities exposed to a tool-agent as custom MCP tools
 * (`@shadow/model`'s `defineTool`/`createToolServer`), addressed as
 * `mcp__{server}__{tool}` once wired into `AgenticSessionOptions.toolServers`
 * (`web-research-tool-agent.ts`).
 *
 * **This is the load-bearing seam.** Every one of these handlers is a plain
 * TypeScript closure over an injected `RetrievalTransport` and
 * `EvidenceStore` — never the global `fetch`, never an AI SDK's own
 * web-browsing feature. The Agent SDK addresses a custom tool by name, and
 * `web-research-tool-agent.ts` passes `AgenticSessionOptions.allowedTools`
 * as *exactly* the three tool names below plus `disallowedTools` explicitly
 * naming the SDK's built-in `WebFetch`/`WebSearch`/`Bash`. A tool the model
 * is not allowed to call is inert (`@shadow/model`'s own tools doc), so the
 * model has no path to the network that does not pass through `search` or
 * `fetch` here — and both of those only ever call `transport`, which in
 * every offline test is `ReplayTransport` over a fixture corpus. Swap the
 * transport, and every tool-agent that uses it becomes deterministic; there
 * is no second code path to remember to swap.
 */

import type { EvidenceStore, RetrievalWitness, SourceMetadata } from "@shadow/evidence";
import { normalizeNfcWs, toSourceId } from "@shadow/evidence";
import { defineTool, type ToolDefinition } from "@shadow/model";
import { z } from "zod";
import type { ResearchBrief } from "./brief.ts";
import { extractMainContent } from "./content.ts";
import { UnboundCitationError } from "./errors.ts";
import type { ResearchRun } from "./research-run.ts";
import type { RetrievalTransport } from "./types.ts";

/** How much of a fetched page's normalized text is handed back to the model in one tool result, so a single long page cannot blow the context budget. Purely a context-budget cap, not a security boundary: `research-run.ts`'s citation validation always checks the *full* normalized text (the same text hashed into the persisted snapshot), never just the truncated preview — so this constant can be tuned freely without changing what counts as a bound citation. */
export const MAX_TOOL_RESULT_CHARS = 6_000;

const AUTHORITY_TIERS = ["primary", "secondary", "community", "unknown"] as const;
const VOLATILITIES = ["never", "slow-changing", "fast-changing", "unknown"] as const;

/**
 * Default `authority.tier` for a fetched URL, from the brief's declared
 * `subjectDomains` — see `deps.ts` in the module doc's design-rationale
 * section (repeated briefly here): identifying *who the subject is* is
 * something only the brief (formed by Shadow, from the operator's intent)
 * can know ahead of any fetch, so it is the deterministic half of the
 * authority judgment. The tool-agent may still override it per fetch (a
 * `primary`-domain page can still be a third-party guest post) — this is
 * only the default when it does not.
 */
function inferAuthorityTier(finalUrl: string, subjectDomains: readonly string[] | undefined) {
  if (!subjectDomains || subjectDomains.length === 0) return "unknown" as const;
  let host: string;
  try {
    host = new URL(finalUrl).hostname.toLowerCase();
  } catch {
    return "unknown" as const;
  }
  const isSubject = subjectDomains.some(
    (domain) => host === domain.toLowerCase() || host.endsWith(`.${domain.toLowerCase()}`),
  );
  return isSubject ? ("primary" as const) : ("secondary" as const);
}

export interface ResearchToolsDeps {
  readonly transport: RetrievalTransport;
  readonly evidenceStore: EvidenceStore;
  /** Which tool-agent to record on `retrieval.agent` — e.g. `"@shadow/research/web-research-tool-agent@0.1.0"`. */
  readonly agentId: string;
  /**
   * Returns the run + brief currently active on the shared session, or
   * `undefined` if none is (a tool call arrived outside a `research()`
   * call — defensive; should not happen in normal operation). A getter
   * rather than a fixed value because the tool server is built once and
   * reused across every `research()` call on the same `WebResearchToolAgent`
   * (D6) — see `web-research-tool-agent.ts`.
   */
  readonly getActive: () =>
    | { readonly run: ResearchRun; readonly brief: ResearchBrief }
    | undefined;
}

function requireActive(deps: ResearchToolsDeps) {
  const active = deps.getActive();
  if (!active) {
    throw new Error(
      "Research tool called with no active research run — this indicates a bug in " +
        "WebResearchToolAgent, not a model error.",
    );
  }
  return active;
}

/** The `search` tool: `RetrievalTransport.search` and nothing else. */
function buildSearchTool(deps: ResearchToolsDeps) {
  return defineTool({
    name: "search",
    description:
      "Search the web for pages relevant to a query. Returns candidate URLs — use `fetch` on " +
      "one to actually retrieve and cite it. Does not itself produce a citable source.",
    inputSchema: {
      query: z.string().min(1),
      maxResults: z.number().int().positive().max(20).optional(),
    },
    handler: async ({ query, maxResults }) => {
      requireActive(deps);
      const response = await deps.transport.search({ query, maxResults });
      if (response.hits.length === 0) {
        return { content: "No results." };
      }
      const lines = response.hits.map(
        (hit) => `- ${hit.url} — ${hit.title}${hit.snippet ? `\n  ${hit.snippet}` : ""}`,
      );
      return { content: lines.join("\n") };
    },
  });
}

/** The `fetch` tool: `RetrievalTransport.fetchPage` + `extractMainContent` + `EvidenceStore.putSourceFromRetrieval`. The only place a `SourceId` ever comes from. */
function buildFetchTool(deps: ResearchToolsDeps) {
  return defineTool({
    name: "fetch",
    description:
      "Fetch a URL, extract its main content, and record it as a witnessed source in the " +
      "evidence ledger. Returns a sourceId — you MUST use this exact sourceId, with an exact " +
      "quoted span copied from the returned text, when you cite this page in submit_findings. " +
      "Optionally override authorityTier (relationship to the subject: primary = the subject's " +
      "own domain writing about itself, secondary = a third party discussing it, community = " +
      "user-generated, unknown = unclear) and volatility (never | slow-changing | fast-changing " +
      "| unknown — how quickly this specific page's content is likely to change) if you have a " +
      "better read on either than the default.",
    inputSchema: {
      url: z.string().min(1),
      title: z.string().optional(),
      authorityTier: z.enum(AUTHORITY_TIERS).optional(),
      authorityRationale: z.string().optional(),
      volatility: z.enum(VOLATILITIES).optional(),
    },
    handler: async (input) => {
      const { run, brief } = requireActive(deps);

      const page = await deps.transport.fetchPage({ url: input.url });
      const html = new TextDecoder("utf-8", { fatal: false }).decode(page.bytes);
      const extractedText = extractMainContent(html);

      const witness: RetrievalWitness = {
        requestedUrl: page.requestedUrl,
        finalUrl: page.finalUrl,
        httpStatus: page.httpStatus,
        contentType: page.contentType,
        bytes: page.bytes,
        extractedText,
        retrievedAt: page.retrievedAt,
        transport: page.transport,
      };

      const tier = input.authorityTier ?? inferAuthorityTier(page.finalUrl, brief.subjectDomains);
      const metadata: SourceMetadata = {
        title: input.title ?? page.finalUrl,
        agent: deps.agentId,
        query: brief.goal,
        authority: {
          tier,
          rationale:
            input.authorityRationale ??
            (tier === "primary"
              ? `${new URL(page.finalUrl).hostname} is a declared subject domain for this brief.`
              : "Not a declared subject domain for this brief."),
        },
        volatility: input.volatility ?? "unknown",
      };

      let record: Awaited<ReturnType<EvidenceStore["putSourceFromRetrieval"]>>;
      try {
        record = await deps.evidenceStore.putSourceFromRetrieval(brief.volume, witness, metadata);
      } catch (error) {
        return {
          content: `Fetch of ${input.url} succeeded but could not be recorded: ${
            error instanceof Error ? error.message : String(error)
          }`,
          isError: true,
        };
      }

      // Same normalization the evidence store hashed into
      // `record.snapshot.normalizedTextSha256` — so a quote that resolves
      // here is a quote that will also resolve against the persisted
      // snapshot. See `research-run.ts`.
      const normalizedText = normalizeNfcWs(extractedText);
      try {
        run.recordFetch({ source: record, normalizedText });
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }

      const shown =
        normalizedText.length > MAX_TOOL_RESULT_CHARS
          ? `${normalizedText.slice(0, MAX_TOOL_RESULT_CHARS)}\n…(truncated)`
          : normalizedText;
      return {
        content: `sourceId: ${record.id}\ntitle: ${record.title}\nurl: ${record.finalUrl}\n---\n${shown}`,
      };
    },
  });
}

/** The `submit_findings` tool: the only path into `ResearchRun.submit`, i.e. the only way a `Finding` can ever leave a `research()` call. */
function buildSubmitFindingsTool(deps: ResearchToolsDeps) {
  return defineTool({
    name: "submit_findings",
    description:
      "Submit your final findings for this research brief. Each finding must cite at least one " +
      "source by the exact sourceId returned from fetch, with an exact quote copied from that " +
      "fetch's returned text. Findings citing anything not fetched in this session, or a quote " +
      "that does not appear verbatim in the fetched text, are rejected as a whole batch — fix " +
      "and resubmit. This is the only way findings are returned to the caller.",
    inputSchema: {
      findings: z.array(
        z.object({
          text: z.string().min(1),
          citations: z
            .array(z.object({ sourceId: z.string().min(1), quote: z.string().min(1) }))
            .min(1),
        }),
      ),
    },
    handler: async ({ findings }) => {
      const { run } = requireActive(deps);
      if (findings.length === 0) {
        return { content: "Submit at least one finding.", isError: true };
      }
      try {
        const candidates = findings.map((finding) => ({
          text: finding.text,
          citations: finding.citations.map((citation) => ({
            sourceId: toSourceId(citation.sourceId),
            quote: citation.quote,
          })),
        }));
        run.submit(candidates);
        return { content: `Accepted ${findings.length} finding(s).` };
      } catch (error) {
        if (error instanceof UnboundCitationError) {
          return { content: `Rejected: ${error.message}`, isError: true };
        }
        // Malformed sourceId (InvalidIdError from toSourceId) is the same
        // family of refusal as an unfetched one — the id was never handed
        // out by `fetch`, so it can't resolve. Surface it the same way.
        return {
          content: `Rejected: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  });
}

/**
 * Build the three research tools, all closing over `deps` (never anything
 * global). Pass the result to `@shadow/model`'s `createToolServer`.
 *
 * Note: the return type is intentionally the loose
 * `ToolDefinition<any>[]` shape `createToolServer` itself expects
 * (`tools.ts`'s own doc explains why the array is heterogeneous) — each
 * builder above still has a fully-typed `inputSchema`/`handler` pair.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches @shadow/model's createToolServer parameter type — see comment above
export function buildResearchTools(deps: ResearchToolsDeps): ReadonlyArray<ToolDefinition<any>> {
  return [buildSearchTool(deps), buildFetchTool(deps), buildSubmitFindingsTool(deps)];
}
