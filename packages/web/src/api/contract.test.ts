/**
 * THE offline contract test: `HttpApiClient` — `@shadow/web`'s real,
 * production implementation of `ShadowApiClient` — driven against
 * `createServer` wired to a fully real (fakes-only, offline) `ApiDeps`
 * (`@shadow/api`'s own `withApi`/`withScriptedApi` test harness). Both
 * halves already existed before this reconciliation; nothing before this
 * file ever pointed them at each other. Every wire-shape divergence in the
 * reconciliation report was caught here, before a single page component
 * was touched — that is the whole point of writing this first.
 *
 * `@shadow/web` has no package dependency on `@shadow/api` (this package
 * ships to a browser; `@shadow/api` is Node/Bun-only server code) — this
 * file reaches `@shadow/api/src/test-helpers.ts` by *relative* path
 * instead, the same convention `tests/e2e` already uses for a cross-package
 * test that needs another package's source directly (see that directory's
 * `build-corpus.ts` module doc): Bun runs TypeScript source directly (D7),
 * so a relative import into a sibling package's `src/` is exactly as real
 * as a `@shadow/*` specifier, just addressed by path. `test-helpers.ts` is
 * deliberately not re-exported from `@shadow/api`'s public `index.ts` (it's
 * test-only plumbing) — reaching it by relative path here is the intended
 * use the task calls for ("both sides already have complete fakes and the
 * plumbing exists"), not a boundary violation: nothing here imports a
 * private file to bypass `@shadow/api`'s real HTTP surface, it only builds
 * the *server* half offline the same way `@shadow/api`'s own tests do.
 */

import { describe, expect, test } from "bun:test";
import { toChapterSlug, toVolumeSlug } from "../../../core/src/index.ts";
import type { WithApiOptions } from "../../../api/src/test-helpers.ts";
import { withApi, withScriptedApi } from "../../../api/src/test-helpers.ts";
import { parseChapterBody } from "../components/chapter-body.ts";
import {
  appendUserMessage,
  applyStreamEvent,
  beginStreaming,
  INITIAL_CHAT_STATE,
} from "../pages/chat-transcript.ts";
import { HttpApiClient } from "./http-client.ts";
import { ApiError, type VolumeSummary } from "./types.ts";

describe("contract: HttpApiClient against a real @shadow/api server", () => {
  test("volumes: create, list, and get round-trip with the real wire shape (no chapterCount, ever)", async () => {
    await withApi(async ({ baseUrl }) => {
      const client = new HttpApiClient(`${baseUrl}/api`);

      expect(await client.listVolumes()).toEqual([]);

      const created = await client.createVolume({
        title: "Contract Test Volume",
        description: "Exercised by the offline contract test.",
      });
      expect(created.slug).toBe("contract-test-volume");

      const listed = await client.listVolumes();
      expect(listed).toHaveLength(1);
      // `GET /api/volumes` returns full `Volume`s, never a `chapterCount` —
      // the old `VolumeSummary` guess had one; the real wire never does.
      expect(Object.hasOwn(listed[0] as VolumeSummary, "chapterCount")).toBe(false);

      const { volume, chapters } = await client.getVolume(created.slug);
      expect(volume.slug).toBe(created.slug);
      expect(chapters).toEqual([]);
    });
  });

  test("a freshly created volume's index 404s index_not_built — a normal state, not a crash", async () => {
    await withApi(async ({ baseUrl }) => {
      const client = new HttpApiClient(`${baseUrl}/api`);
      await client.createVolume({ title: "No Chapters Yet" });

      // `expect(promise).rejects...` is documented Bun API, but its
      // matchers are typed `void` despite needing an await, which trips
      // oxlint's type-aware `await-thenable` rule — plain try/catch
      // sidesteps it (matching `@shadow/cli`'s `loaders.test.ts` convention).
      const error = await client.getIndex("no-chapters-yet").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("index_not_built");
    });
  });

  test("write a chapter, then view it: claims is the sidecar (.claims is the array), audit.verdict.passed is a boolean, and the index builds", async () => {
    await withApi(async ({ baseUrl }) => {
      const client = new HttpApiClient(`${baseUrl}/api`);
      await client.createVolume({ title: "Design Craft" });

      const body =
        "Spacing reads as deliberate when it follows a consistent scale, not per-screen judgment calls.";
      const putResult = await client.putChapter("design-craft", "spacing", {
        title: "Spacing",
        body,
        frontmatter: { when_to_use: "Designing dense UI." },
      });

      // `PutChapterAudit` — a THIRD distinct audit shape from `AuditRecord`
      // and the chat SSE `audit` event: `{ verdict: { passed }, outcomes,
      // repairs, published }`, always present (a PUT always audits).
      expect(putResult.audit.verdict.passed).toBe(true);
      expect(putResult.audit.published).toBe(true);
      expect(Array.isArray(putResult.audit.outcomes)).toBe(true);
      expect(Array.isArray(putResult.audit.repairs)).toBe(true);

      const getResult = await client.getChapter("design-craft", "spacing");
      expect(getResult.chapter.body).toBe(body);

      // The bug this line would have caught: `claims` is a `ClaimSidecar`
      // object, not a `Claim[]` — `getResult.claims.map` throws
      // "claims.map is not a function" if this ever regresses to the old
      // guessed shape.
      expect(getResult.claims).toBeDefined();
      expect(Array.isArray(getResult.claims?.claims)).toBe(true);

      // The bug this line would have caught: `audit.verdict` is an object
      // (`{ chapter, passed, outcomes }`), never the bare string `"pass"` —
      // `AuditBanner`'s old `audit.verdict === "pass"` comparison is always
      // false against this real shape, so every passing audit rendered red.
      expect(getResult.audit).toBeDefined();
      expect(typeof getResult.audit?.verdict.passed).toBe("boolean");
      expect(getResult.audit?.verdict.passed).toBe(true);
      expect(Array.isArray(getResult.audit?.verdict.outcomes)).toBe(true);

      // A passing publish reindexes as a side effect — the index that
      // 404'd before this chapter existed must now resolve, in the real
      // `VolumeIndexDocument` shape (`.volume.chapters`, snake_case),
      // not the old guessed `{ nodes: [...] }`.
      const index = await client.getIndex("design-craft");
      expect(index.volume.chapter_count).toBe(1);
      expect(index.volume.chapters.map((c) => c.slug)).toEqual(["spacing"]);
    });
  });

  test("chat: every SSE event the server actually sends survives the transcript reducer without wiping state, including events with no docs/API.md row", async () => {
    // An `operator`-kind claim's evidence quote must appear verbatim in the
    // operator-turn transcript source (D19/D23: witnessed, not minted) —
    // so the citation text and the chat message it's quoting have to be the
    // exact same string, mirroring @shadow/api's own `chat.test.ts`
    // "chapter.restated" scenario.
    const OPERATOR_MESSAGE = "The operator said this belongs here.";
    const chapterDirective = {
      slug: "chat-chapter",
      title: "Chat Chapter",
      body: `${OPERATOR_MESSAGE}[^~op-belief]`,
      frontmatter: { when_to_use: "Contract test." },
      claims: [{ label: "op-belief", kind: "operator", text: OPERATOR_MESSAGE }],
    };

    const respond: WithApiOptions["respond"] = (prompt, { turnIndex }) => {
      if (turnIndex === 0) {
        const match = /Operator \(sourceId: (\S+)\):/.exec(prompt);
        const operatorSourceId = match?.[1];
        if (!operatorSourceId) throw new Error("operator sourceId not found in prompt");
        const withEvidence = {
          ...chapterDirective,
          claims: [
            {
              ...chapterDirective.claims[0],
              evidence: [{ sourceId: operatorSourceId, quote: OPERATOR_MESSAGE }],
            },
          ],
        };
        return { text: ["```shadow:chapter", JSON.stringify(withEvidence), "```"].join("\n") };
      }
      return { text: "Done." };
    };

    await withScriptedApi({ respond }, async ({ baseUrl }) => {
      const client = new HttpApiClient(`${baseUrl}/api`);
      await client.createVolume({ slug: "chat-craft", title: "Chat Craft" });

      let state = beginStreaming(appendUserMessage(INITIAL_CHAT_STATE, OPERATOR_MESSAGE));
      const seenEvents: string[] = [];
      for await (const event of client.chat({
        volumeSlug: "chat-craft",
        message: OPERATOR_MESSAGE,
      })) {
        seenEvents.push(event.event);
        state = applyStreamEvent(state, event);
        // The bug this line would have caught: an unhandled `ChatStreamEvent`
        // used to fall through the reducer's `switch` with no `default`,
        // silently returning `undefined` — every field access on `state`
        // for the REST of the stream would then throw. Asserting `state` is
        // a real object after literally every event is what catches that
        // the moment it regresses, not several events later.
        expect(state).toBeDefined();
        expect(Array.isArray(state.items)).toBe(true);
      }

      // The real server does emit events with no `docs/API.md` row
      // (`chapter.published`/`chapter.rejected` — see `handlers/chat.ts`'s
      // module doc) — assert at least one arrived, so this test would fail
      // outright (not just silently pass) if the scripted turn stopped
      // exercising them.
      expect(seenEvents).toContain("audit");
      expect(seenEvents).toContain("chapter.published");
      expect(state.streaming).toBe(false);

      const auditItem = state.items.find((item) => item.type === "audit");
      expect(auditItem).toMatchObject({ passed: true });

      // Close the loop on the citation-marker regex fix (D18's `[^~label]`
      // operator form): parse the REAL chapter body the server persisted
      // and confirm the marker survives as a citation segment, not literal
      // `[^~op-belief]` text with an un-stripped definition line beneath it.
      const written = await client.getChapter("chat-craft", "chat-chapter");
      const blocks = parseChapterBody(written.chapter.body);
      const citationLabels = blocks
        .flatMap((block) => block.segments)
        .filter((segment) => segment.type === "citation")
        .map((segment) => segment.label);
      expect(citationLabels).toContain("op-belief");
    });
  });

  test("rule books: list, detail, and group round-trip with the real wire shape (group mirrors getChapter's optionality)", async () => {
    await withApi(async ({ baseUrl, deps }) => {
      const client = new HttpApiClient(`${baseUrl}/api`);

      expect(await client.listRulebooks()).toEqual([]);

      const slug = toVolumeSlug("loan-agreement-rules");
      await deps.rulebookStore.createRulebook({ slug, title: "Loan Agreement Rules" });
      await deps.rulebookStore.putGroup(slug, {
        slug: toChapterSlug("interest-and-fees"),
        title: "Interest & Fees",
        body: "- Borrowers must pay interest at a fixed annual rate of 6.5%.[^int-rate]",
      });

      const listed = await client.listRulebooks();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        slug: "loan-agreement-rules",
        title: "Loan Agreement Rules",
        status: "draft",
        groupCount: 1,
      });

      const { rulebook, groups } = await client.getRulebook("loan-agreement-rules");
      expect(rulebook.slug).toBe("loan-agreement-rules");
      expect(groups).toEqual([
        { slug: "interest-and-fees", title: "Interest & Fees", status: "draft", ruleCount: 1 },
      ]);

      // Never published through `publishGroup` in this test — `claims`/
      // `audit` are `undefined`, the same optionality `getChapter` has for
      // an unaudited chapter (the bug this line would catch: `claims` ever
      // regressing to a bare array-or-empty-array guess for an unaudited
      // group instead of staying genuinely absent).
      const group = await client.getRulebookGroup("loan-agreement-rules", "interest-and-fees");
      expect(group.group.slug).toBe("interest-and-fees");
      expect(group.claims).toBeUndefined();
      expect(group.audit).toBeUndefined();
    });
  });

  test("a client disconnect mid-turn does not crash the server for the next request (cancel() is guarded)", async () => {
    const respond: WithApiOptions["respond"] = (_prompt, { turnIndex }) =>
      turnIndex === 0
        ? { text: "hello", events: [{ type: "text-delta", text: "hello" }] }
        : { text: "again" };

    await withScriptedApi({ respond }, async ({ baseUrl }) => {
      const setupClient = new HttpApiClient(`${baseUrl}/api`);
      await setupClient.createVolume({ slug: "disconnect-test", title: "Disconnect" });

      const controller = new AbortController();
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ volumeSlug: "disconnect-test", message: "hi" }),
        signal: controller.signal,
      });
      const reader = res.body?.getReader();
      await reader?.read(); // read the `session` event, then abandon the stream
      controller.abort();
      await reader?.cancel().catch(() => {});

      // The server must still be healthy: a fresh HttpApiClient call
      // succeeds normally after the aborted stream.
      const client = new HttpApiClient(`${baseUrl}/api`);
      const volumes = await client.listVolumes();
      expect(volumes.map((v) => v.slug)).toContain("disconnect-test");
    });
  });
});
