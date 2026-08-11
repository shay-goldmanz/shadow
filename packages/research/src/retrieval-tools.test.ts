/**
 * End-to-end tests for the three research tools (`retrieval-tools.ts`)
 * against fixtures — fully offline, no model. This is deliberately where
 * the acceptance criteria's heaviest requirements are proven, because
 * these handlers *are* the real production code path: `WebResearchToolAgent`
 * (`web-research-tool-agent.test.ts`) wires these exact same tool
 * definitions into a live agentic session, but the Agent SDK's own
 * tool-dispatch loop cannot be run offline — see that file's module doc
 * for the split and why it's honest rather than a coverage gap.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemVolumeStore, toVolumeSlug, type VolumeSlug } from "@shadow/core";
import { FileSystemEvidenceStore, toSourceId } from "@shadow/evidence";
import type { ResearchBrief } from "./brief.ts";
import { FixtureCorpus } from "./fixture-corpus.ts";
import { ReplayTransport } from "./replay-transport.ts";
import { ResearchRun } from "./research-run.ts";
import {
  buildResearchTools,
  MAX_TOOL_RESULT_CHARS,
  type ResearchToolsDeps,
} from "./retrieval-tools.ts";

const LINEAR_URL = "https://linear.app/blog/design-system";
const LINEAR_HTML =
  "<html><body><nav>Home</nav><main><p>Linear renders its sidebar on a 4px spacing scale. " +
  "Every measurement in the sidebar is a multiple of four.</p></main>" +
  "<footer>Copyright Linear</footer></body></html>";

const COMMENTARY_URL = "https://example.com/commentary";
const COMMENTARY_HTML =
  "<html><body><main><p>Commentators note that Linear favors borders over drop shadows for cards.</p></main></body></html>";

async function withCorpus<T>(fn: (corpus: FixtureCorpus) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "shadow-research-tools-corpus-"));
  try {
    return await fn(new FixtureCorpus(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withVolume<T>(
  fn: (evidenceStore: FileSystemEvidenceStore, volume: VolumeSlug) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "shadow-research-tools-volume-"));
  try {
    const volumeStore = new FileSystemVolumeStore(root);
    const volume = toVolumeSlug("test-volume");
    await volumeStore.createVolume({ slug: volume, title: "Test Volume" });
    return await fn(new FileSystemEvidenceStore(volumeStore), volume);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function seedLinearPage(corpus: FixtureCorpus): Promise<void> {
  return corpus.writePage({
    requestedUrl: LINEAR_URL,
    finalUrl: LINEAR_URL,
    httpStatus: 200,
    contentType: "text/html",
    headers: { "content-type": "text/html" },
    bytes: new TextEncoder().encode(LINEAR_HTML),
    retrievedAt: "2026-08-11T09:14:22.000Z",
    transport: "live",
  });
}

function seedCommentaryPage(corpus: FixtureCorpus): Promise<void> {
  return corpus.writePage({
    requestedUrl: COMMENTARY_URL,
    finalUrl: COMMENTARY_URL,
    httpStatus: 200,
    contentType: "text/html",
    headers: { "content-type": "text/html" },
    bytes: new TextEncoder().encode(COMMENTARY_HTML),
    retrievedAt: "2026-08-11T09:20:00.000Z",
    transport: "live",
  });
}

function seedSearch(corpus: FixtureCorpus): Promise<void> {
  return corpus.writeSearch(
    {
      query: "how linear designs its ui",
      hits: [{ url: LINEAR_URL, title: "Linear's design system" }],
      retrievedAt: "2026-08-11T09:10:00.000Z",
      transport: "live",
    },
    undefined,
  );
}

interface Harness {
  readonly tools: ReturnType<typeof buildResearchTools>;
  readonly run: ResearchRun;
  readonly transport: ReplayTransport;
  readonly evidenceStore: FileSystemEvidenceStore;
  readonly volume: VolumeSlug;
}

/** Wires `buildResearchTools` exactly as `WebResearchToolAgent` does, with one fixed active run/brief for the duration of the test. */
function buildHarness(
  corpus: FixtureCorpus,
  evidenceStore: FileSystemEvidenceStore,
  volume: VolumeSlug,
  briefOverrides: Partial<ResearchBrief> = {},
): Harness {
  const transport = new ReplayTransport(corpus);
  const brief: ResearchBrief = {
    volume,
    goal: "how does Linear design its sidebar",
    subjectDomains: ["linear.app"],
    ...briefOverrides,
  };
  const run = new ResearchRun(brief.maxSources);
  const deps: ResearchToolsDeps = {
    transport,
    evidenceStore,
    agentId: "@shadow/research/test-agent@0.0.0",
    getActive: () => ({ run, brief }),
  };
  return { tools: buildResearchTools(deps), run, transport, evidenceStore, volume };
}

function toolByName(tools: ReturnType<typeof buildResearchTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool;
}

function extractSourceId(fetchContent: string): string {
  const match = fetchContent.match(/^sourceId: (\S+)/m);
  if (!match?.[1]) throw new Error(`could not find sourceId in: ${fetchContent}`);
  return match[1];
}

describe("research tools — end to end against fixtures", () => {
  test("a brief's search -> fetch -> submit_findings produces findings whose citations resolve in the evidence ledger", async () => {
    await withCorpus(async (corpus) => {
      await seedLinearPage(corpus);
      await seedSearch(corpus);
      await withVolume(async (evidenceStore, volume) => {
        const h = buildHarness(corpus, evidenceStore, volume);
        const search = toolByName(h.tools, "search");
        const fetchTool = toolByName(h.tools, "fetch");
        const submit = toolByName(h.tools, "submit_findings");

        const searchResult = await search.handler({
          query: "how linear designs its ui",
          maxResults: undefined,
        });
        expect(searchResult.content).toContain(LINEAR_URL);

        const fetchResult = await fetchTool.handler({
          url: LINEAR_URL,
          title: undefined,
          authorityTier: undefined,
          authorityRationale: undefined,
          volatility: undefined,
        });
        expect(fetchResult.isError).toBeUndefined();
        expect(fetchResult.content).toContain(
          "Every measurement in the sidebar is a multiple of four.",
        );
        const sourceId = extractSourceId(fetchResult.content);

        const submitResult = await submit.handler({
          findings: [
            {
              text: "Linear renders its sidebar on a 4px spacing scale.",
              citations: [
                { sourceId, quote: "Every measurement in the sidebar is a multiple of four." },
              ],
            },
          ],
        });
        expect(submitResult.isError).toBeUndefined();
        expect(submitResult.content).toContain("Accepted 1");
        expect(h.run.findingCount).toBe(1);

        // Resolve the citation against the actual on-disk evidence ledger,
        // not just the in-memory run — this is the acceptance bar.
        const stored = await evidenceStore.getSource(volume, toSourceId(sourceId));
        expect(stored.retrieval.transport).toBe("fixture");
        expect(stored.retrieval.agent).toBe("@shadow/research/test-agent@0.0.0");
        const snapshotText = await evidenceStore.getSnapshotText(
          volume,
          stored.snapshot.normalizedTextSha256,
        );
        expect(snapshotText).toContain("Every measurement in the sidebar is a multiple of four.");
        // Boilerplate was stripped by extraction, so it never entered the ledger.
        expect(snapshotText).not.toContain("Copyright Linear");
        expect(snapshotText).not.toContain("Home");
      });
    });
  });

  test("every source in the ledger came from a real retrieval — one fetch call, one source, no more", async () => {
    await withCorpus(async (corpus) => {
      await seedLinearPage(corpus);
      await seedCommentaryPage(corpus);
      await withVolume(async (evidenceStore, volume) => {
        const h = buildHarness(corpus, evidenceStore, volume);
        const fetchTool = toolByName(h.tools, "fetch");

        await fetchTool.handler({
          url: LINEAR_URL,
          title: undefined,
          authorityTier: undefined,
          authorityRationale: undefined,
          volatility: undefined,
        });
        await fetchTool.handler({
          url: COMMENTARY_URL,
          title: undefined,
          authorityTier: undefined,
          authorityRationale: undefined,
          volatility: undefined,
        });

        const sources = await evidenceStore.listSources(volume);
        expect(sources).toHaveLength(2);
        for (const source of sources) {
          // Never "session" — this package only ever witnesses real
          // retrievals, never a transcript (that's transcript-source.ts,
          // a different origin entirely).
          expect(source.retrieval.transport).toBe("fixture");
        }
        expect(h.run.fetchedCount).toBe(2);
      });
    });
  });

  test("submit_findings citing a sourceId never fetched in this run fails, and no phantom source is created", async () => {
    await withCorpus(async (corpus) => {
      await seedLinearPage(corpus);
      await withVolume(async (evidenceStore, volume) => {
        const h = buildHarness(corpus, evidenceStore, volume);
        const fetchTool = toolByName(h.tools, "fetch");
        const submit = toolByName(h.tools, "submit_findings");

        await fetchTool.handler({
          url: LINEAR_URL,
          title: undefined,
          authorityTier: undefined,
          authorityRationale: undefined,
          volatility: undefined,
        });
        expect(await evidenceStore.listSources(volume)).toHaveLength(1);

        // A plausible-looking but never-fetched sourceId — fabricated by
        // whatever generated it, not returned by `fetch`.
        const fabricatedId = "src_01HQ8ZK4M2N7P9R3T5V8W1X6Y1";
        const result = await submit.handler({
          findings: [
            {
              text: "Linear never uses shadows.",
              citations: [{ sourceId: fabricatedId, quote: "anything" }],
            },
          ],
        });

        expect(result.isError).toBe(true);
        expect(result.content).toContain("Rejected");
        expect(h.run.findingCount).toBe(0);
        // No new source materialized from the rejected citation attempt.
        expect(await evidenceStore.listSources(volume)).toHaveLength(1);
      });
    });
  });

  test("submit_findings citing a quote never actually in the fetched text fails the same way", async () => {
    await withCorpus(async (corpus) => {
      await seedLinearPage(corpus);
      await withVolume(async (evidenceStore, volume) => {
        const h = buildHarness(corpus, evidenceStore, volume);
        const fetchTool = toolByName(h.tools, "fetch");
        const submit = toolByName(h.tools, "submit_findings");

        const fetchResult = await fetchTool.handler({
          url: LINEAR_URL,
          title: undefined,
          authorityTier: undefined,
          authorityRationale: undefined,
          volatility: undefined,
        });
        const sourceId = extractSourceId(fetchResult.content);

        const result = await submit.handler({
          findings: [
            {
              text: "Linear never uses shadows.",
              citations: [{ sourceId, quote: "Linear never uses shadows anywhere" }],
            },
          ],
        });

        expect(result.isError).toBe(true);
        expect(h.run.findingCount).toBe(0);
      });
    });
  });

  test("fixture replay: the same brief run twice produces identical digests, freshly-minted source ids", async () => {
    await withCorpus(async (corpus) => {
      await seedLinearPage(corpus);

      const fetchOnce = async () =>
        withVolume(async (evidenceStore, volume) => {
          const h = buildHarness(corpus, evidenceStore, volume);
          const fetchTool = toolByName(h.tools, "fetch");
          const fetchResult = await fetchTool.handler({
            url: LINEAR_URL,
            title: undefined,
            authorityTier: undefined,
            authorityRationale: undefined,
            volatility: undefined,
          });
          const sourceId = extractSourceId(fetchResult.content);
          return evidenceStore.getSource(volume, toSourceId(sourceId));
        });

      const first = await fetchOnce();
      const second = await fetchOnce();

      expect(second.id).not.toBe(first.id); // fresh witnessed event each time
      expect(second.url).toBe(first.url);
      expect(second.snapshot.payloadSha256).toBe(first.snapshot.payloadSha256);
      expect(second.snapshot.normalizedTextSha256).toBe(first.snapshot.normalizedTextSha256);
      expect(second.snapshot.chars).toBe(first.snapshot.chars);
    });
  });

  test("authority.tier defaults to primary for a declared subject domain, secondary otherwise", async () => {
    await withCorpus(async (corpus) => {
      await seedLinearPage(corpus);
      await seedCommentaryPage(corpus);
      await withVolume(async (evidenceStore, volume) => {
        const h = buildHarness(corpus, evidenceStore, volume, { subjectDomains: ["linear.app"] });
        const fetchTool = toolByName(h.tools, "fetch");

        const linear = await fetchTool.handler({
          url: LINEAR_URL,
          title: undefined,
          authorityTier: undefined,
          authorityRationale: undefined,
          volatility: undefined,
        });
        const commentary = await fetchTool.handler({
          url: COMMENTARY_URL,
          title: undefined,
          authorityTier: undefined,
          authorityRationale: undefined,
          volatility: undefined,
        });

        const linearSource = await evidenceStore.getSource(
          volume,
          toSourceId(extractSourceId(linear.content)),
        );
        const commentarySource = await evidenceStore.getSource(
          volume,
          toSourceId(extractSourceId(commentary.content)),
        );
        expect(linearSource.authority.tier).toBe("primary");
        expect(commentarySource.authority.tier).toBe("secondary");
      });
    });
  });

  test("the model can override authority.tier and volatility per fetch when it has better judgment", async () => {
    await withCorpus(async (corpus) => {
      await seedCommentaryPage(corpus);
      await withVolume(async (evidenceStore, volume) => {
        const h = buildHarness(corpus, evidenceStore, volume, { subjectDomains: ["linear.app"] });
        const fetchTool = toolByName(h.tools, "fetch");

        const result = await fetchTool.handler({
          url: COMMENTARY_URL,
          title: undefined,
          authorityTier: "community",
          authorityRationale: "This is a forum thread, not editorial commentary.",
          volatility: "fast-changing",
        });
        const source = await evidenceStore.getSource(
          volume,
          toSourceId(extractSourceId(result.content)),
        );
        expect(source.authority.tier).toBe("community");
        expect(source.authority.rationale).toBe(
          "This is a forum thread, not editorial commentary.",
        );
        expect(source.volatility).toBe("fast-changing");
      });
    });
  });

  test("volatility defaults to unknown when the tool-agent does not specify it", async () => {
    await withCorpus(async (corpus) => {
      await seedLinearPage(corpus);
      await withVolume(async (evidenceStore, volume) => {
        const h = buildHarness(corpus, evidenceStore, volume);
        const fetchTool = toolByName(h.tools, "fetch");
        const result = await fetchTool.handler({
          url: LINEAR_URL,
          title: undefined,
          authorityTier: undefined,
          authorityRationale: undefined,
          volatility: undefined,
        });
        const source = await evidenceStore.getSource(
          volume,
          toSourceId(extractSourceId(result.content)),
        );
        expect(source.volatility).toBe("unknown");
      });
    });
  });

  test("a non-2xx page the transport hands back is recorded as-is — this package does not re-gate on httpStatus", async () => {
    await withCorpus(async (corpus) => {
      await corpus.writePage({
        requestedUrl: "https://example.com/gone",
        finalUrl: "https://example.com/gone",
        httpStatus: 404,
        contentType: "text/html",
        headers: {},
        bytes: new TextEncoder().encode("<html><body><main><p>Not found.</p></main></body></html>"),
        retrievedAt: "2026-08-11T09:00:00.000Z",
        transport: "live",
      });
      await withVolume(async (evidenceStore, volume) => {
        const h = buildHarness(corpus, evidenceStore, volume);
        const fetchTool = toolByName(h.tools, "fetch");
        const result = await fetchTool.handler({
          url: "https://example.com/gone",
          title: undefined,
          authorityTier: undefined,
          authorityRationale: undefined,
          volatility: undefined,
        });
        expect(result.isError).toBeUndefined();
        const source = await evidenceStore.getSource(
          volume,
          toSourceId(extractSourceId(result.content)),
        );
        expect(source.retrieval.httpStatus).toBe(404);
      });
    });
  });

  test("long pages are truncated in what the model sees, but a genuine quote from beyond the cutoff still validates", async () => {
    await withCorpus(async (corpus) => {
      const filler = "Padding sentence about nothing in particular. ".repeat(300); // well over MAX_TOOL_RESULT_CHARS
      const tail = "This exact sentence lives past the truncation cutoff.";
      const html = `<html><body><main><p>${filler}${tail}</p></main></body></html>`;
      expect(filler.length).toBeGreaterThan(MAX_TOOL_RESULT_CHARS);
      await corpus.writePage({
        requestedUrl: "https://example.com/long",
        finalUrl: "https://example.com/long",
        httpStatus: 200,
        contentType: "text/html",
        headers: {},
        bytes: new TextEncoder().encode(html),
        retrievedAt: "2026-08-11T09:00:00.000Z",
        transport: "live",
      });
      await withVolume(async (evidenceStore, volume) => {
        const h = buildHarness(corpus, evidenceStore, volume);
        const fetchTool = toolByName(h.tools, "fetch");
        const submit = toolByName(h.tools, "submit_findings");

        const fetchResult = await fetchTool.handler({
          url: "https://example.com/long",
          title: undefined,
          authorityTier: undefined,
          authorityRationale: undefined,
          volatility: undefined,
        });
        expect(fetchResult.content).toContain("(truncated)");
        expect(fetchResult.content).not.toContain(tail);
        const sourceId = extractSourceId(fetchResult.content);

        const submitResult = await submit.handler({
          findings: [{ text: "a claim about the tail", citations: [{ sourceId, quote: tail }] }],
        });
        expect(submitResult.isError).toBeUndefined();
      });
    });
  });
});
