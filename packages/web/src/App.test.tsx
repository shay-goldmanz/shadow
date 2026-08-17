import "./test/dom-setup.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { App } from "./App.tsx";
import type { GetSessionEventsOptions } from "./api/client.ts";
import { FakeApiClient } from "./api/fake-client.ts";
import type { SessionEventEnvelope } from "./api/types.ts";
import { ThemeProvider } from "./theme/ThemeProvider.tsx";

/**
 * `FakeApiClient`, but counting `getSessionEvents` calls — F6's whole test
 * signal. `ChatPage`'s follow subscription only ever opens when the mount
 * it's running in was given a `sessionId` AT MOUNT (`ChatPage.tsx`'s own
 * doc: `followingRef` is captured once). A REMOUNT is therefore directly
 * observable as an extra `getSessionEvents` call — no DOM inspection needed,
 * and no risk of the assertion accidentally passing either way because the
 * fake's own store happens to make a remount's content look identical to no
 * remount at all.
 */
class TrackingClient extends FakeApiClient {
  getSessionEventsCalls = 0;

  override async *getSessionEvents(
    sessionId: string,
    options?: GetSessionEventsOptions,
  ): AsyncGenerator<SessionEventEnvelope> {
    this.getSessionEventsCalls += 1;
    yield* super.getSessionEvents(sessionId, options);
  }
}

function send(
  getByLabelText: (label: string | RegExp) => HTMLElement,
  getByText: (t: string) => HTMLElement,
  message: string,
) {
  const textarea = getByLabelText("Message Shadow") as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: message } });
  fireEvent.click(getByText("Send"));
}

beforeEach(() => {
  location.hash = "";
});

afterEach(() => {
  cleanup();
  location.hash = "";
  document.documentElement.removeAttribute("data-theme");
  localStorage.clear();
});

describe("App — F6 review fix: ChatPage keyed by the route's session id", () => {
  test("first send in a new chat does NOT remount (no follow subscription ever opens for a self-minted id)", async () => {
    const client = new TrackingClient({ streamDelayMs: 0 });
    location.hash = "#/v/design-inspiration/chat";
    const { getByLabelText, getByText, findByText } = render(
      <ThemeProvider>
        <App client={client} />
      </ThemeProvider>,
    );

    send(getByLabelText, getByText, "I believe in Linear and Notion's UI, and Epoch's one-pagers.");
    expect(await findByText("Audit failed")).toBeTruthy();

    // The URL swapped to the id-carrying form (`ChatPage`'s own
    // replace-navigate on its first `session` event) — proof the send
    // actually ran the self-mint transition this test is exercising, not a
    // no-op.
    expect(location.hash).toBe("#/v/design-inspiration/chat/sess_1");

    // The core assertion: a remount would have given the fresh instance a
    // defined `sessionId` at mount (the URL already carries one by the time
    // React processes the state update), which would have opened a follow
    // subscription — something an id-less "new chat" mount never does on
    // its own. Zero calls is the direct proof no remount happened.
    expect(client.getSessionEventsCalls).toBe(0);

    // The transcript itself also has to have survived intact — one send's
    // worth of content, not reset partway through.
    expect(document.querySelectorAll(".chat-transcript__item--user").length).toBe(1);
  });

  test("navigating from session A's URL to session B's URL DOES remount (fresh follow reopens for B, sends go to B)", async () => {
    const client = new TrackingClient({ streamDelayMs: 0 });
    // Seed two independent sessions directly through the client — standing
    // in for history from earlier page loads, before either URL is ever
    // visited in this render.
    for await (const _event of client.chat({
      volumeSlug: "design-inspiration",
      sessionId: "sess_a",
      message: "belief A",
    })) {
      // drain
    }
    for await (const _event of client.chat({
      volumeSlug: "design-inspiration",
      sessionId: "sess_b",
      message: "belief B",
    })) {
      // drain
    }

    location.hash = "#/v/design-inspiration/chat/sess_a";
    const { getByLabelText, getByText, findByText } = render(
      <ThemeProvider>
        <App client={client} />
      </ThemeProvider>,
    );
    expect(await findByText("belief A")).toBeTruthy();
    // One follow subscription opened for session A's mount.
    expect(client.getSessionEventsCalls).toBe(1);
    expect(document.querySelectorAll(".chat-transcript__item--user").length).toBe(1);

    location.hash = "#/v/design-inspiration/chat/sess_b";
    expect(await findByText("belief B")).toBeTruthy();

    // A SECOND follow subscription opened — direct proof of a remount, not
    // the same instance quietly re-rendering with new props.
    expect(client.getSessionEventsCalls).toBe(2);
    // Fresh state: exactly session B's own one user bubble, not both
    // sessions' content concatenated onto a stale instance.
    expect(document.querySelectorAll(".chat-transcript__item--user").length).toBe(1);
    expect(document.body.textContent).not.toContain("belief A");

    // Sends from here go to the NEW session, not the old one silently kept
    // alive by an unremounted instance — a THIRD belief lands alongside B's,
    // never alongside A's (which this same DOM tree no longer even renders).
    send(getByLabelText, getByText, "a third belief, sent after switching to B");
    expect(await findByText("a third belief, sent after switching to B")).toBeTruthy();
    expect(document.querySelectorAll(".chat-transcript__item--user").length).toBe(2);
    expect(document.body.textContent).not.toContain("belief A");
  });
});
