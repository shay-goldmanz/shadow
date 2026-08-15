import { describe, expect, test } from "bun:test";
import { FakeRuleBookPort } from "@shadow/agent/test-helpers";
import { toVolumeSlug } from "@shadow/core";
import type { FakeAgenticTurnResponder } from "@shadow/model";
import { ZERO_USAGE } from "@shadow/model";
import type { RulebookEvent, RulebookResult } from "@shadow/rulebook";
import { readAllSseEvents, seedVolume, withScriptedApi } from "../test-helpers.ts";

describe("Chat — SSE", () => {
  test("sessionId arrives first, text deltas stream, done is last — and the client can echo sessionId to continue", async () => {
    const respond: FakeAgenticTurnResponder = (_prompt, { turnIndex }) => {
      if (turnIndex === 0)
        return { text: "Hello! ", events: [{ type: "text-delta", text: "Hello! " }] };
      return { text: "Welcome back." };
    };

    await withScriptedApi({ respond }, async ({ baseUrl, deps, sessions }) => {
      const volume = toVolumeSlug("design-craft");
      await seedVolume(deps, volume);

      const firstRes = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ volumeSlug: "design-craft", message: "Hi Shadow!" }),
      });
      expect(firstRes.status).toBe(200);
      expect(firstRes.headers.get("content-type")).toContain("text/event-stream");

      const firstEvents = await readAllSseEvents(firstRes);
      const firstEvent = firstEvents[0];
      if (!firstEvent) throw new Error("expected a first SSE event");
      expect(firstEvent.event).toBe("session");
      const sessionId = (firstEvent.data as { sessionId: string }).sessionId;
      expect(typeof sessionId).toBe("string");
      expect(sessionId.length).toBeGreaterThan(0);

      expect(firstEvents.some((e) => e.event === "text")).toBe(true);
      expect(firstEvents.at(-1)?.event).toBe("done");

      // No stray error events on the happy path.
      expect(firstEvents.some((e) => e.event === "error")).toBe(false);

      // Echo the sessionId back to continue the SAME conversation (D6).
      const secondRes = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, message: "Second message." }),
      });
      expect(secondRes.status).toBe(200);
      const secondEvents = await readAllSseEvents(secondRes);
      const secondFirstEvent = secondEvents[0];
      if (!secondFirstEvent) throw new Error("expected a first SSE event on the second turn");
      expect((secondFirstEvent.data as { sessionId: string }).sessionId).toBe(sessionId);
      expect(secondEvents.at(-1)?.event).toBe("done");

      // The underlying AgenticSession was created once and reused across
      // both HTTP requests — exactly D6's point.
      expect(sessions.sessions).toHaveLength(1);
      expect(sessions.sessions[0]?.prompts).toHaveLength(2);
    });
  });

  test("an unknown sessionId is 404 session_not_found, before any SSE stream opens", async () => {
    await withScriptedApi({}, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "does-not-exist", message: "hi" }),
      });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("session_not_found");
    });
  });

  test("starting a conversation without volumeSlug or sessionId is 400", async () => {
    await withScriptedApi({}, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hi" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid_request");
    });
  });

  test("a chapter.restated event reaches the stream when a claim needs repair", async () => {
    const OPERATOR_MESSAGE = "I believe spacing should be systemic, not per-screen.";
    // The claim must be `sourced`, not `operator`: operator claims verify at
    // Tier 0 by exact quote match and are deliberately excluded from the Tier 2
    // judge (docs/EVIDENCE.md), so a scripted judge would never be consulted
    // and nothing would ever need repairing.
    const SNAPSHOT_TEXT = "Linear standardizes every sidebar measurement on a 4 px grid.";
    const QUOTE = "every sidebar measurement on a 4 px grid";
    let sourcedId = "";

    const respond: FakeAgenticTurnResponder = (_prompt, { turnIndex }) => {
      if (turnIndex === 0) {
        const chapter = {
          slug: "spacing",
          title: "Spacing",
          body: `Linear puts every measurement on a 4 px grid.[^lin-grid]`,
          frontmatter: { when_to_use: "Designing dense UI." },
          claims: [
            {
              label: "lin-grid",
              kind: "sourced",
              text: "Linear puts every measurement on a 4 px grid.",
              evidence: [{ sourceId: sourcedId, quote: QUOTE }],
            },
          ],
        };
        return {
          text: ["```shadow:chapter", JSON.stringify(chapter), "```"].join("\n"),
        };
      }
      return { text: "Done." };
    };

    await withScriptedApi(
      {
        respond,
        // Always "unsupported" so the repair loop fires AND the verdict
        // keeps failing after repair (only "unsupported" blocks C3 —
        // "partial"/"conflicted" are warnings only), whatever the
        // restated text says.
        entailmentRelevanceJudge: {
          judge: async (inputs) =>
            inputs.map(() => ({
              entailment: { status: "unsupported" as const, rationale: "test: always unsupported" },
              relevance: { relevance: "on-topic" as const, rationale: "test" },
            })),
        },
        claimRestater: {
          restate: async (inputs) =>
            inputs.map((input) => ({
              to: `${input.text} (as far as I can confirm)`,
              reason: "test: softened to what the transcript actually supports",
            })),
        },
      },
      async ({ baseUrl, deps }) => {
        const volume = toVolumeSlug("design-craft");
        await seedVolume(deps, volume);

        // A real retrieval witness, so the quote resolves in a stored snapshot
        // — the judge only ever sees resolved bytes (D24).
        const source = await deps.evidenceStore.putSourceFromRetrieval(
          volume,
          {
            requestedUrl: "https://linear.app/blog/design-system",
            finalUrl: "https://linear.app/blog/design-system",
            httpStatus: 200,
            contentType: "text/html",
            bytes: new TextEncoder().encode(`<p>${SNAPSHOT_TEXT}</p>`),
            extractedText: SNAPSHOT_TEXT,
            retrievedAt: "2026-08-11T09:14:22Z",
            transport: "live",
          },
          {
            title: "How we built Linear's design system",
            agent: "test",
            authority: { tier: "primary", rationale: "first-party publisher" },
            volatility: "slow-changing",
          },
        );
        sourcedId = source.id;

        const res = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ volumeSlug: "design-craft", message: OPERATOR_MESSAGE }),
        });
        expect(res.status).toBe(200);
        const events = await readAllSseEvents(res);

        const restated = events.filter((e) => e.event === "chapter.restated");
        expect(restated.length).toBeGreaterThan(0);
        const first = restated[0]?.data as {
          claim: string;
          from: string;
          to: string;
          reason: string;
          outcome: string;
        };
        expect(first.claim).toBe("lin-grid");
        expect(first.to).toContain("as far as I can confirm");
        expect(["applied", "escalated"]).toContain(first.outcome);

        // The audit event carries the (failing, since this judge never
        // clears anything) verdict — still 200, still a normal SSE stream.
        const auditEvents = events.filter((e) => e.event === "audit");
        expect(auditEvents.length).toBeGreaterThan(0);
        const firstAudit = auditEvents[0];
        if (!firstAudit) throw new Error("expected an audit event");
        expect((firstAudit.data as { passed: boolean }).passed).toBe(false);

        expect(events.some((e) => e.event === "chapter.rejected")).toBe(true);
        expect(events.at(-1)?.event).toBe("done");
      },
    );
  });

  test("a shadow:rulebook block maps every RulebookEvent to its rulebook.* SSE counterpart", async () => {
    const result: RulebookResult = {
      slug: "rnb-loan-agreement",
      sourceId: "src_rnb_loan",
      ruleCount: 12,
      groupCount: 2,
      publishedGroups: ["borrower-obligations"],
      rejectedGroups: ["fees"],
      failedChunks: 0,
      assemblyDroppedQuotes: 0,
      assemblyDroppedRules: 0,
      usage: ZERO_USAGE,
    };
    const script: RulebookEvent[] = [
      { type: "started", slug: "rnb-loan-agreement", docPath: "/tmp/rnb_loan.pdf" },
      { type: "planned", chunkCount: 5, groups: ["borrower-obligations", "fees"] },
      {
        type: "chunk-extracted",
        completed: 1,
        total: 5,
        rulesSoFar: 3,
        cached: false,
        failed: false,
      },
      { type: "merged", ruleCount: 14, droppedQuotes: 1, consolidated: 12 },
      {
        type: "group-audited",
        group: "borrower-obligations",
        passed: true,
        repairs: 0,
        issues: [],
      },
      { type: "completed", result },
    ];
    const ruleBookPort = new FakeRuleBookPort([script]);

    const respond: FakeAgenticTurnResponder = (_prompt, { turnIndex }) => {
      if (turnIndex === 0) {
        return {
          text: [
            "```shadow:rulebook",
            JSON.stringify({
              slug: "rnb-loan-agreement",
              title: "RNB Loan Agreement",
              docPath: "/tmp/rnb_loan.pdf",
            }),
            "```",
          ].join("\n"),
        };
      }
      return { text: "Done." };
    };

    await withScriptedApi({ respond, ruleBookPort }, async ({ baseUrl, deps }) => {
      const volume = toVolumeSlug("design-craft");
      await seedVolume(deps, volume);

      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          volumeSlug: "design-craft",
          message: "Build a rule book from /tmp/rnb_loan.pdf",
        }),
      });
      expect(res.status).toBe(200);
      const events = await readAllSseEvents(res);

      const byEvent = (name: string) => events.filter((e) => e.event === name);

      expect(byEvent("rulebook.started")).toHaveLength(1);
      expect(byEvent("rulebook.started")[0]?.data).toEqual({
        slug: "rnb-loan-agreement",
        docPath: "/tmp/rnb_loan.pdf",
      });

      expect(byEvent("rulebook.planned")[0]?.data).toEqual({
        slug: "rnb-loan-agreement",
        chunkCount: 5,
        groups: ["borrower-obligations", "fees"],
      });

      expect(byEvent("rulebook.chunk")[0]?.data).toEqual({
        slug: "rnb-loan-agreement",
        completed: 1,
        total: 5,
        rulesSoFar: 3,
        cached: false,
        failed: false,
      });

      expect(byEvent("rulebook.merged")[0]?.data).toEqual({
        slug: "rnb-loan-agreement",
        ruleCount: 14,
        droppedQuotes: 1,
        consolidated: 12,
      });

      expect(byEvent("rulebook.group.audited")[0]?.data).toEqual({
        slug: "rnb-loan-agreement",
        group: "borrower-obligations",
        passed: true,
        repairs: 0,
        issues: [],
      });

      const completed = byEvent("rulebook.completed");
      expect(completed).toHaveLength(1);
      expect(completed[0]?.data).toEqual({ slug: "rnb-loan-agreement", result });

      expect(events.some((e) => e.event === "rulebook.failed")).toBe(false);
      expect(events.at(-1)?.event).toBe("done");
    });
  });

  test("a failed RulebookEvent maps to a rulebook.failed SSE event, not an error", async () => {
    const script: RulebookEvent[] = [
      { type: "started", slug: "broken-doc", docPath: "/tmp/broken.pdf" },
      { type: "failed", error: "document could not be decoded" },
    ];
    const ruleBookPort = new FakeRuleBookPort([script]);

    const respond: FakeAgenticTurnResponder = (_prompt, { turnIndex }) => {
      if (turnIndex === 0) {
        return {
          text: [
            "```shadow:rulebook",
            JSON.stringify({
              slug: "broken-doc",
              title: "Broken Doc",
              docPath: "/tmp/broken.pdf",
            }),
            "```",
          ].join("\n"),
        };
      }
      return { text: "Done." };
    };

    await withScriptedApi({ respond, ruleBookPort }, async ({ baseUrl, deps }) => {
      const volume = toVolumeSlug("design-craft");
      await seedVolume(deps, volume);

      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          volumeSlug: "design-craft",
          message: "Build a rule book from /tmp/broken.pdf",
        }),
      });
      expect(res.status).toBe(200);
      const events = await readAllSseEvents(res);

      expect(events.some((e) => e.event === "rulebook.failed")).toBe(true);
      const failed = events.find((e) => e.event === "rulebook.failed");
      expect(failed?.data).toEqual({
        slug: "broken-doc",
        error: "document could not be decoded",
      });
      // A port-level `failed` event is data, not a thrown fault — no
      // top-level SSE `error` event, same as `@shadow/agent`'s own
      // "failed is a follow-up, not a rejection" contract.
      expect(events.some((e) => e.event === "error")).toBe(false);
      expect(events.at(-1)?.event).toBe("done");
    });
  });
});
