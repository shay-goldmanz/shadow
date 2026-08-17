import "../test/dom-setup.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { FakeApiClient } from "../api/fake-client.ts";
import type { ChatStreamEvent, SessionEventEnvelope } from "../api/types.ts";
import { ChatPage } from "./ChatPage.tsx";

/** `FakeApiClient`, but `getSessionEvents` yields a fixed, controlled sequence then throws — standing in for a follow connection that drops mid-turn (T2.8's "stream ends with no boundary at all" shape). Subclassed (not spread) so every other `ShadowApiClient` method stays real (`FakeApiClient`'s prototype methods aren't own-enumerable, so `{...instance}` would silently drop them). */
class DroppingSessionEventsClient extends FakeApiClient {
  override async *getSessionEvents(): AsyncGenerator<SessionEventEnvelope> {
    yield { event: "operator", data: { text: "please finish this" }, seq: 1 };
    yield { event: "text", data: { delta: "partway through..." }, seq: 2 };
    throw new Error("connection dropped");
  }
}

/**
 * F3 review fix — `FakeApiClient`, but `getSessionEvents` yields a COMPLETE
 * turn (ending with `turn.ended`, the F3 wire signal) before the connection
 * drops. Standing in for a follow connection that drops AFTER the turn it
 * was watching already finished — no fault of the turn itself, e.g. a
 * network blip during the idle gap before the next one. Before F3, nothing
 * on the wire ever cleared `turnPending` for a follow viewer (`?follow=true`
 * never sends `done`), so this exact drop shape used to mis-render an
 * interrupted marker with a live Retry on a turn that had already
 * succeeded — resending would have duplicated it.
 */
class DroppingAfterCompletedTurnClient extends FakeApiClient {
  override async *getSessionEvents(): AsyncGenerator<SessionEventEnvelope> {
    yield { event: "operator", data: { text: "already finished" }, seq: 1 };
    yield { event: "text", data: { delta: "done talking", seq: 4 }, seq: 4 };
    yield { event: "turn.ended", data: {}, seq: 5 };
    throw new Error("connection dropped after the turn completed");
  }
}

afterEach(() => cleanup());

function send(
  getByLabelText: (label: string | RegExp) => HTMLElement,
  getByText: (t: string) => HTMLElement,
  message: string,
) {
  const textarea = getByLabelText("Message Shadow") as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: message } });
  fireEvent.click(getByText("Send"));
}

describe("ChatPage", () => {
  test("streams the scripted turn in order, including research progress", async () => {
    const client = new FakeApiClient({ streamDelayMs: 0 });
    const { getByLabelText, getByText, findByText } = render(
      <ChatPage client={client} slug="design-inspiration" navigate={() => {}} />,
    );

    send(getByLabelText, getByText, "I believe in Linear and Notion's UI, and Epoch's one-pagers.");

    // Research progress is visible while the turn streams, not swallowed.
    expect(await findByText("How do Linear and Notion design their UI chrome?")).toBeTruthy();
    expect(await findByText("Linear Method — Writing things down")).toBeTruthy();
    expect(await findByText("Inside the design of Notion")).toBeTruthy();

    // The turn concludes: audit and restatement events are both visible.
    expect(await findByText("Audit failed")).toBeTruthy();
    expect(await findByText("Claim restated")).toBeTruthy();

    const transcript = document.querySelector(".chat-transcript");
    expect(transcript).toBeTruthy();
    const itemTypes = [...(transcript?.children ?? [])].map((el) =>
      el.className.replace("chat-transcript__item chat-transcript__item--", ""),
    );

    // Ordering matches the script exactly (arrival order, @shadow/api's real event mapping).
    expect(itemTypes).toEqual([
      "user",
      "assistant",
      "research.started",
      "research.source",
      "research.source",
      "research.finished",
      "assistant",
      "chapter.drafted",
      "audit",
      "chapter.published",
      "assistant",
      "research.started",
      "research.source",
      "research.finished",
      "chapter.restated",
      "chapter.drafted",
      "audit",
      "chapter.rejected",
    ]);
  });

  test("T2.8: a new chat navigates (replacing the current URL) to the id-carrying route once the first send mints a session id", async () => {
    const client = new FakeApiClient({
      streamDelayMs: 0,
      chatScript: (sessionId, input): ChatStreamEvent[] => [
        { event: "session", data: { sessionId } },
        { event: "operator", data: { text: input.message } },
        { event: "text", data: { delta: "ok" } },
        { event: "done", data: {} },
      ],
    });
    const navCalls: unknown[] = [];
    const { getByLabelText, getByText, findByText } = render(
      <ChatPage
        client={client}
        slug="design-inspiration"
        navigate={(route, options) => navCalls.push({ route, options })}
      />,
    );

    send(getByLabelText, getByText, "first message");
    await findByText("ok");

    expect(navCalls).toEqual([
      {
        route: { name: "chat", slug: "design-inspiration", sessionId: "sess_1" },
        options: { replace: true },
      },
    ]);

    // A second send on the SAME mount does not navigate again — the id is
    // already known.
    send(getByLabelText, getByText, "second message");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(navCalls).toHaveLength(1);
  });

  test("echoes the session id from the first turn on the next message (D6 session reuse)", async () => {
    const seenSessionIds: (string | undefined)[] = [];
    const client = new FakeApiClient({
      streamDelayMs: 0,
      chatScript: (sessionId, input) => {
        seenSessionIds.push(input.sessionId);
        const events: ChatStreamEvent[] = [
          { event: "session", data: { sessionId } },
          { event: "operator", data: { text: input.message } },
          { event: "text", data: { delta: "ok" } },
          { event: "done", data: {} },
        ];
        return events;
      },
    });
    const { getByLabelText, getByText, findByText } = render(
      <ChatPage client={client} slug="design-inspiration" navigate={() => {}} />,
    );

    send(getByLabelText, getByText, "first message");
    await findByText("ok");

    send(getByLabelText, getByText, "second message");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seenSessionIds[0]).toBeUndefined();
    expect(seenSessionIds[1]).toBe("sess_1");
  });

  test("T1.4: retries the failed operator message on the same session after a terminal error", async () => {
    let calls = 0;
    const seenSessionIds: (string | undefined)[] = [];
    const client = new FakeApiClient({
      streamDelayMs: 0,
      chatScript: (sessionId, input) => {
        calls += 1;
        seenSessionIds.push(input.sessionId);
        if (calls === 1) {
          const events: ChatStreamEvent[] = [
            { event: "session", data: { sessionId } },
            { event: "operator", data: { text: input.message } },
            { event: "error", data: { message: "Upstream overloaded", code: "shadow_turn_error" } },
          ];
          return events;
        }
        const events: ChatStreamEvent[] = [
          { event: "session", data: { sessionId } },
          { event: "operator", data: { text: input.message } },
          { event: "text", data: { delta: "recovered" } },
          { event: "done", data: {} },
        ];
        return events;
      },
    });

    const { getByLabelText, getByText, findByText } = render(
      <ChatPage client={client} slug="design-inspiration" navigate={() => {}} />,
    );

    send(getByLabelText, getByText, "please write it up");
    await findByText("Upstream overloaded");

    const retryButton = await findByText("Retry last message");
    fireEvent.click(retryButton);
    await findByText("recovered");

    // The retry re-sent the same session id the failed turn minted, as
    // just another turn on it — no server change needed for a resend.
    expect(seenSessionIds).toEqual([undefined, "sess_1"]);

    // History keeps the failed turn's user bubble and its error item; the
    // retry's own user bubble and reply follow. The superseded error item
    // no longer offers a retry affordance.
    const transcript = document.querySelector(".chat-transcript");
    const itemTypes = [...(transcript?.children ?? [])].map((el) =>
      el.className.replace("chat-transcript__item chat-transcript__item--", ""),
    );
    expect(itemTypes).toEqual(["user", "error", "user", "assistant"]);
    expect(document.querySelectorAll(".button--retry").length).toBe(0);

    // The turn settled, so input follows the ordinary streaming convention.
    const textarea = getByLabelText("Message Shadow") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
  });

  test("disables the input while a turn is streaming", async () => {
    const client = new FakeApiClient({ streamDelayMs: 20 });
    const { getByLabelText, getByText } = render(
      <ChatPage client={client} slug="design-inspiration" navigate={() => {}} />,
    );

    send(getByLabelText, getByText, "hello");
    const textarea = getByLabelText("Message Shadow") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
  });

  // T2.8: the operator wire event is the single source of user bubbles now
  // — ChatPage no longer appends its own local one on send, so a message
  // renders exactly once regardless of what else the turn does.
  test("T2.8: exactly one user bubble is rendered per send (operator event, no local append)", async () => {
    const client = new FakeApiClient({ streamDelayMs: 0 });
    const { getByLabelText, getByText, findByText } = render(
      <ChatPage client={client} slug="design-inspiration" navigate={() => {}} />,
    );

    send(getByLabelText, getByText, "I believe in Linear and Notion's UI, and Epoch's one-pagers.");
    await findByText("Audit failed");

    expect(document.querySelectorAll(".chat-transcript__item--user").length).toBe(1);
    expect(document.querySelector(".chat-transcript__item--user")?.textContent).toContain(
      "I believe in Linear and Notion's UI, and Epoch's one-pagers.",
    );
  });

  test("T2.8: mounting an existing session id replays its stored transcript via follow", async () => {
    const client = new FakeApiClient({ streamDelayMs: 0 });
    // Seed the session directly through the client — standing in for
    // history from an earlier page load, before this `ChatPage` ever
    // mounted.
    for await (const _event of client.chat({
      volumeSlug: "design-inspiration",
      sessionId: "sess_seeded",
      message: "seeded belief",
    })) {
      // drain
    }

    const { findByText } = render(
      <ChatPage
        client={client}
        slug="design-inspiration"
        sessionId="sess_seeded"
        navigate={() => {}}
      />,
    );

    expect(await findByText("seeded belief")).toBeTruthy();
    expect(await findByText("Audit failed")).toBeTruthy();
    expect(document.querySelectorAll(".chat-transcript__item--user").length).toBe(1);
  });

  test("T2.8: a passive tab watching a session sees another tab's later turn appear live via follow", async () => {
    let calls = 0;
    const client = new FakeApiClient({
      streamDelayMs: 0,
      chatScript: (sessionId, input): ChatStreamEvent[] => {
        calls += 1;
        return [
          { event: "session", data: { sessionId } },
          { event: "operator", data: { text: input.message } },
          { event: "text", data: { delta: `reply ${calls}` } },
          { event: "done", data: {} },
        ];
      },
    });
    // Seed the session so both tabs can mount at a known id.
    for await (const _event of client.chat({
      volumeSlug: "design-inspiration",
      sessionId: "sess_shared",
      message: "opening message",
    })) {
      // drain
    }

    // Two independent mounts, both attached to `document.body` — every
    // query below is scoped with `within(...)` so a tab's assertions can
    // never accidentally match the OTHER tab's DOM tree.
    const tabA = render(
      <ChatPage
        client={client}
        slug="design-inspiration"
        sessionId="sess_shared"
        navigate={() => {}}
      />,
    );
    const a = within(tabA.container);
    expect(await a.findByText("reply 1")).toBeTruthy();

    const tabB = render(
      <ChatPage
        client={client}
        slug="design-inspiration"
        sessionId="sess_shared"
        navigate={() => {}}
      />,
    );
    const b = within(tabB.container);
    expect(await b.findByText("reply 1")).toBeTruthy(); // tabB's own replay catches up first

    send(
      (label) => b.getByLabelText(label),
      (text) => b.getByText(text),
      "message from tab B",
    );
    expect(await b.findByText("reply 2")).toBeTruthy();

    // tabA never sent anything — its input was never disabled by tab B's
    // turn (PLAN.md: "input disabled while THIS tab's own turn streams") —
    // but the new content still just appears, via tabA's own follow
    // subscription to the same session.
    expect(await a.findByText("message from tab B")).toBeTruthy();
    expect(await a.findByText("reply 2")).toBeTruthy();
    const tabAInput = a.getByLabelText("Message Shadow") as HTMLTextAreaElement;
    expect(tabAInput.disabled).toBe(false);
  });

  test("T2.8: a connection that drops mid-turn renders an interrupted marker with Retry", async () => {
    const dropping = new DroppingSessionEventsClient({ streamDelayMs: 0 });

    const { findByText } = render(
      <ChatPage
        client={dropping}
        slug="design-inspiration"
        sessionId="sess_dropped"
        navigate={() => {}}
      />,
    );

    expect(await findByText("please finish this")).toBeTruthy();
    const retryButton = await findByText("Retry last message");
    expect(retryButton).toBeTruthy();
    expect(document.querySelector(".chat-transcript__item--interrupted")).toBeTruthy();
  });

  // F3 review fix — extends the T2.8 passive-tab scenario above (a follow
  // viewer watching a turn it didn't send) with the one state the review
  // flagged as unasserted there: what happens when the CONNECTION itself
  // drops after the turn it was watching already completed.
  test("F3: a follow connection that drops AFTER a completed turn does not render an interrupted marker", async () => {
    const dropping = new DroppingAfterCompletedTurnClient({ streamDelayMs: 0 });

    const { findByText } = render(
      <ChatPage
        client={dropping}
        slug="design-inspiration"
        sessionId="sess_done"
        navigate={() => {}}
      />,
    );

    expect(await findByText("done talking")).toBeTruthy();
    // Let the dropped connection's rejection propagate through ChatPage's
    // own catch/finally (`markInterruptedIfPending`'s defensive call on
    // every stream end, per its own doc) before asserting its absence.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector(".chat-transcript__item--interrupted")).toBeNull();
    expect(document.querySelectorAll(".button--retry").length).toBe(0);
  });
});
