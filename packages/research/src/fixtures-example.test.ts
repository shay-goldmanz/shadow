/**
 * Reads the small, fixed, committed example fixture at
 * `packages/research/fixtures/` — versioned in git, generated once by
 * recording against a fake page (see the module doc on `fixture-corpus.ts`
 * for the on-disk format). Unlike the other test files, which use a fresh
 * `mkdtemp` corpus per test, this one exercises the actual committed
 * corpus location to prove the format works as checked into the repo, not
 * just in an ephemeral temp directory.
 *
 * This is read-only: it must never write into `fixtures/`, or `bun test`
 * would mutate tracked files on every run.
 */

import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { normalizeNfcWs } from "@shadow/evidence";
import { extractMainContent } from "./content.ts";
import { FixtureCorpus } from "./fixture-corpus.ts";
import { ReplayTransport } from "./replay-transport.ts";

const FIXTURES_ROOT = fileURLToPath(new URL("../fixtures", import.meta.url));

describe("the committed example fixture corpus", () => {
  test("replays the example page fixture", async () => {
    const transport = new ReplayTransport(new FixtureCorpus(FIXTURES_ROOT));
    const page = await transport.fetchPage({ url: "https://example.com/blog/design-system" });

    expect(page.httpStatus).toBe(200);
    expect(page.transport).toBe("fixture");
    const html = new TextDecoder().decode(page.bytes);
    expect(html).toContain("Linear renders its sidebar on a 4px spacing scale.");

    const normalized = normalizeNfcWs(extractMainContent(html));
    expect(normalized).toContain("Linear renders its sidebar on a 4px spacing scale.");
    expect(normalized).not.toContain("Copyright Linear"); // footer stripped
    expect(normalized).not.toContain("Home"); // nav stripped
  });

  test("replays the example search fixture", async () => {
    const transport = new ReplayTransport(new FixtureCorpus(FIXTURES_ROOT));
    const response = await transport.search({ query: "how linear designs its UI", maxResults: 5 });
    expect(response.hits).toHaveLength(1);
    expect(response.hits[0]?.url).toBe("https://example.com/blog/design-system");
  });
});
