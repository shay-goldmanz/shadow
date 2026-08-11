import "../test/dom-setup.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { FakeApiClient } from "../api/fake-client.ts";
import type { ChatStreamEvent } from "../api/types.ts";
import { ChatPage } from "./ChatPage.tsx";

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

  test("echoes the session id from the first turn on the next message (D6 session reuse)", async () => {
    const seenSessionIds: (string | undefined)[] = [];
    const client = new FakeApiClient({
      streamDelayMs: 0,
      chatScript: (sessionId, input) => {
        seenSessionIds.push(input.sessionId);
        const events: ChatStreamEvent[] = [
          { event: "session", data: { sessionId } },
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

  test("disables the input while a turn is streaming", async () => {
    const client = new FakeApiClient({ streamDelayMs: 20 });
    const { getByLabelText, getByText } = render(
      <ChatPage client={client} slug="design-inspiration" navigate={() => {}} />,
    );

    send(getByLabelText, getByText, "hello");
    const textarea = getByLabelText("Message Shadow") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
  });
});
