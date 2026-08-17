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
import type { WithApiOptions } from "../../../api/src/test-helpers.ts";
import { withApi, withScriptedApi } from "../../../api/src/test-helpers.ts";
import { parseChapterBody } from "../components/chapter-body.ts";
import { applyStreamEvent, beginStreaming, INITIAL_CHAT_STATE } from "../pages/chat-transcript.ts";
import { FakeApiClient } from "./fake-client.ts";
import { HttpApiClient } from "./http-client.ts";
import { ApiError, type ChatStreamEvent, type VolumeSummary } from "./types.ts";

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

      // T2.8: the `operator` wire event is the single source of the user
      // bubble now — no local seed here any more (that would double it,
      // one from this line and one from the real server's own `operator`
      // event on the stream below).
      let state = beginStreaming(INITIAL_CHAT_STATE);
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
      expect(seenEvents).toContain("operator");
      expect(seenEvents).toContain("audit");
      expect(seenEvents).toContain("chapter.published");
      expect(state.streaming).toBe(false);

      // Exactly one user bubble, minted from the real server's `operator`
      // event — the T2.8 property this contract test exists to pin against
      // the real wire, not just the fake.
      const userItems = state.items.filter((item) => item.type === "user");
      expect(userItems).toEqual([expect.objectContaining({ text: OPERATOR_MESSAGE })]);

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

  describe("T2.8: getSessionEvents — GET /api/sessions/:id/events", () => {
    test("replays a turn's transcript via HttpApiClient, seq-stamped, ending with done", async () => {
      const respond: WithApiOptions["respond"] = () => ({ text: "Full reply text." });

      await withScriptedApi({ respond }, async ({ baseUrl }) => {
        const client = new HttpApiClient(`${baseUrl}/api`);
        await client.createVolume({ slug: "session-events-craft", title: "Session Events" });

        let sessionId: string | undefined;
        for await (const event of client.chat({
          volumeSlug: "session-events-craft",
          message: "Hello Shadow",
        })) {
          if (event.event === "session") sessionId = event.data.sessionId;
        }
        if (!sessionId) throw new Error("expected a sessionId from the chat stream");

        const replayed: string[] = [];
        const seqs: (number | undefined)[] = [];
        for await (const envelope of client.getSessionEvents(sessionId)) {
          replayed.push(envelope.event);
          seqs.push(envelope.seq);
        }

        expect(replayed).toEqual(["operator", "text", "turn.ended", "done"]);
        // Every record-derived event carries a seq; `done` (not derived
        // from any one record) does not.
        expect(seqs[0]).toBeGreaterThan(0);
        expect(seqs[1]).toBeGreaterThan(seqs[0] as number);
        expect(seqs[2]).toBeGreaterThan(seqs[1] as number);
        expect(seqs[3]).toBeUndefined();
      });
    });

    test("fromSeq dedupes on reconnect: only events at or after the given seq come back (T2.7's inclusive contract)", async () => {
      const respond: WithApiOptions["respond"] = (_prompt, { turnIndex }) =>
        turnIndex === 0 ? { text: "first reply" } : { text: "second reply" };

      await withScriptedApi({ respond }, async ({ baseUrl }) => {
        const client = new HttpApiClient(`${baseUrl}/api`);
        await client.createVolume({ slug: "reconnect-craft", title: "Reconnect" });

        let sessionId: string | undefined;
        for await (const event of client.chat({
          volumeSlug: "reconnect-craft",
          message: "first message",
        })) {
          if (event.event === "session") sessionId = event.data.sessionId;
        }
        if (!sessionId) throw new Error("expected a sessionId from the chat stream");
        for await (const _event of client.chat({ sessionId, message: "second message" })) {
          // drain
        }

        // A client that saw everything through some seq N reconnects with
        // fromSeq = N + 1 — simulated here by first reading the full
        // transcript once to learn where the second turn's `operator`
        // event landed.
        const full: { readonly event: string; readonly seq: number | undefined }[] = [];
        for await (const envelope of client.getSessionEvents(sessionId)) {
          full.push({ event: envelope.event, seq: envelope.seq });
        }
        const operatorSeqs = full.filter((e) => e.event === "operator").map((e) => e.seq);
        expect(operatorSeqs).toHaveLength(2);
        const secondOperatorSeq = operatorSeqs[1];
        if (secondOperatorSeq === undefined) throw new Error("expected the second operator's seq");

        const reconnected: string[] = [];
        const seqs: (number | undefined)[] = [];
        for await (const envelope of client.getSessionEvents(sessionId, {
          fromSeq: secondOperatorSeq,
        })) {
          reconnected.push(envelope.event);
          seqs.push(envelope.seq);
        }

        // Only the second turn — the first turn's lower-seq events never
        // reappear.
        expect(reconnected).toEqual(["operator", "text", "turn.ended", "done"]);
        expect(seqs.every((seq) => seq === undefined || seq >= (secondOperatorSeq as number))).toBe(
          true,
        );
      });
    });
  });

  describe("T2.8: FakeApiClient's getSessionEvents behaves like HttpApiClient's for an equivalent turn", () => {
    test("replay-only produces the same event-type sequence, shaped identically, on both clients", async () => {
      const respond: WithApiOptions["respond"] = () => ({ text: "reply text" });

      await withScriptedApi({ respond }, async ({ baseUrl }) => {
        const real = new HttpApiClient(`${baseUrl}/api`);
        await real.createVolume({ slug: "parity-craft", title: "Parity" });

        let realSessionId: string | undefined;
        for await (const event of real.chat({ volumeSlug: "parity-craft", message: "hello" })) {
          if (event.event === "session") realSessionId = event.data.sessionId;
        }
        if (!realSessionId) throw new Error("expected a sessionId");

        const fake = new FakeApiClient({
          streamDelayMs: 0,
          chatScript: (sessionId, input): ChatStreamEvent[] => [
            { event: "session", data: { sessionId } },
            { event: "operator", data: { text: input.message } },
            { event: "text", data: { delta: "reply text" } },
            { event: "done", data: {} },
          ],
        });
        let fakeSessionId: string | undefined;
        for await (const event of fake.chat({ volumeSlug: "parity-craft", message: "hello" })) {
          if (event.event === "session") fakeSessionId = event.data.sessionId;
        }
        if (!fakeSessionId) throw new Error("expected a sessionId");

        const realReplay: string[] = [];
        for await (const envelope of real.getSessionEvents(realSessionId)) {
          realReplay.push(envelope.event);
        }
        const fakeReplay: string[] = [];
        for await (const envelope of fake.getSessionEvents(fakeSessionId)) {
          fakeReplay.push(envelope.event);
        }

        // Same wire vocabulary and order for the same interaction — the
        // contract `ChatPage` relies on (`applyStreamEvent` doesn't care
        // which client produced the event).
        expect(fakeReplay).toEqual(realReplay);
        expect(realReplay).toEqual(["operator", "text", "turn.ended", "done"]);
      });
    });

    // F9 review fix: the review flagged `follow` itself as contract-untested
    // — every case above exercises plain replay only. This drives a
    // multi-chunk message (`events: [...]`, matching `session-service.test.ts`'s
    // own tee-test pattern) through `?follow=true` on BOTH clients and
    // checks the shapes agree, including the two things F2/F4 changed: a
    // seq-stamped `text` carrying the FULL accumulated string (not a
    // per-delta shape), and `turn.ended` (F3) — `follow` never sends `done`
    // on either client, so this reads only up through `turn.ended`.
    test("follow=true produces the same event-type sequence, seq-shape, and full text on both clients", async () => {
      const respond: WithApiOptions["respond"] = () => ({
        text: "reply text",
        events: [
          { type: "text-delta", text: "reply " },
          { type: "text-delta", text: "text" },
        ],
      });

      await withScriptedApi({ respond }, async ({ baseUrl }) => {
        const real = new HttpApiClient(`${baseUrl}/api`);
        await real.createVolume({ slug: "parity-follow-craft", title: "Parity Follow" });

        let realSessionId: string | undefined;
        for await (const event of real.chat({
          volumeSlug: "parity-follow-craft",
          message: "hello",
        })) {
          if (event.event === "session") realSessionId = event.data.sessionId;
        }
        if (!realSessionId) throw new Error("expected a sessionId");

        const fake = new FakeApiClient({
          streamDelayMs: 0,
          chatScript: (sessionId, input): ChatStreamEvent[] => [
            { event: "session", data: { sessionId } },
            { event: "operator", data: { text: input.message } },
            { event: "text", data: { delta: "reply " } },
            { event: "text", data: { delta: "text" } },
            { event: "done", data: {} },
          ],
        });
        let fakeSessionId: string | undefined;
        for await (const event of fake.chat({
          volumeSlug: "parity-follow-craft",
          message: "hello",
        })) {
          if (event.event === "session") fakeSessionId = event.data.sessionId;
        }
        if (!fakeSessionId) throw new Error("expected a sessionId");

        // The turn has already completed by the time follow subscribes
        // here — this is `follow`'s REPLAY half, but it's the half that
        // carries the shape F2/F4 changed (a seq-stamped, full-text
        // `text`), and the one the review flagged as never driven through
        // `follow=true` on either client at all.
        async function collectFollow(
          client: HttpApiClient | FakeApiClient,
          sessionId: string,
        ): Promise<ReadonlyArray<{ event: string; hasSeq: boolean; delta: string | undefined }>> {
          const out: { event: string; hasSeq: boolean; delta: string | undefined }[] = [];
          for await (const envelope of client.getSessionEvents(sessionId, { follow: true })) {
            const data = envelope.data as { readonly delta?: string } | undefined;
            out.push({
              event: envelope.event,
              hasSeq: envelope.seq !== undefined,
              delta: data?.delta,
            });
            // Neither client ever sends `done` under `?follow=true` (this
            // module's own doc, `../../api/src/handlers/session-events.ts`'s
            // module doc) — `turn.ended` is the last stored-derived event
            // for a turn that already finished, so this is where a
            // bounded collection has to stop instead of waiting forever.
            if (envelope.event === "turn.ended") break;
          }
          return out;
        }

        const realFollow = await collectFollow(real, realSessionId);
        const fakeFollow = await collectFollow(fake, fakeSessionId);

        expect(fakeFollow).toEqual(realFollow);
        expect(realFollow.map((e) => e.event)).toEqual(["operator", "text", "turn.ended"]);

        const textEntry = realFollow.find((e) => e.event === "text");
        // The ONE stored `text` entry carries a seq (F2/F4: it's the
        // authoritative full-text replace, not a delta to append) and the
        // FULL accumulated string — never the two individual chunks
        // `respond`'s `events` streamed live.
        expect(textEntry?.hasSeq).toBe(true);
        expect(textEntry?.delta).toBe("reply text");
      });
    });
  });
});
