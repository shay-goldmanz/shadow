import "../test/dom-setup.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { FakeApiClient } from "../api/fake-client.ts";
import type { NavigateOptions, Route } from "../routing/useHashRoute.ts";
import { SessionList } from "./SessionList.tsx";

afterEach(() => cleanup());

const SLUG = "design-inspiration";

/** Mints (or resumes) a session on `SLUG` by draining a real chat turn through the fake — the same "seed through the client" convention `ChatPage.test.tsx` uses. Returns the session id (minted fresh when `sessionId` is omitted). */
async function seedSession(
  client: FakeApiClient,
  message: string,
  sessionId?: string,
  volume: string = SLUG,
): Promise<string> {
  let mintedId = sessionId;
  for await (const event of client.chat({ volumeSlug: volume, sessionId, message })) {
    if (event.event === "session") mintedId = event.data.sessionId;
  }
  if (!mintedId) throw new Error("expected a sessionId from the chat stream");
  return mintedId;
}

function recordingNavigate(): {
  readonly navigate: (route: Route, options?: NavigateOptions) => void;
  readonly calls: Array<{ route: Route; options: NavigateOptions | undefined }>;
} {
  const calls: Array<{ route: Route; options: NavigateOptions | undefined }> = [];
  return { navigate: (route, options) => calls.push({ route, options }), calls };
}

describe("SessionList", () => {
  test("renders sessions newest-first, with title and last-active", async () => {
    const client = new FakeApiClient({ streamDelayMs: 0 });
    await seedSession(client, "first belief about typography");
    await seedSession(client, "second belief about grids");

    const { navigate } = recordingNavigate();
    const { findAllByRole } = render(
      <SessionList client={client} slug={SLUG} currentSessionId={undefined} navigate={navigate} />,
    );

    const titles = await findAllByRole("button", { name: /belief/ });
    expect(titles.map((el) => el.textContent)).toEqual([
      "second belief about grids",
      "first belief about typography",
    ]);
    // Last-active is rendered per row (exact formatting is locale-owned;
    // presence is what matters here).
    expect(document.querySelectorAll(".session-row__meta")).toHaveLength(2);
  });

  test("only lists sessions for the given volume", async () => {
    const client = new FakeApiClient({ streamDelayMs: 0 });
    await seedSession(client, "in this volume");
    // A second volume's session must never leak into this list.
    await seedSession(client, "in another volume", undefined, "other-volume");

    const { navigate } = recordingNavigate();
    const { findByText, queryByText } = render(
      <SessionList client={client} slug={SLUG} currentSessionId={undefined} navigate={navigate} />,
    );

    expect(await findByText("in this volume")).toBeTruthy();
    expect(queryByText("in another volume")).toBeNull();
  });

  test("resume navigates to the session's own URL", async () => {
    const client = new FakeApiClient({ streamDelayMs: 0 });
    const id = await seedSession(client, "resume me");

    const { navigate, calls } = recordingNavigate();
    const { findByText } = render(
      <SessionList client={client} slug={SLUG} currentSessionId={undefined} navigate={navigate} />,
    );

    fireEvent.click(await findByText("resume me"));

    expect(calls).toEqual([
      { route: { name: "chat", slug: SLUG, sessionId: id }, options: undefined },
    ]);
  });

  test("+ New chat navigates to the id-less chat route", async () => {
    const client = new FakeApiClient({ streamDelayMs: 0 });
    await seedSession(client, "existing session");

    const { navigate, calls } = recordingNavigate();
    const { findByText } = render(
      <SessionList client={client} slug={SLUG} currentSessionId={undefined} navigate={navigate} />,
    );

    fireEvent.click(await findByText("+ New chat"));

    expect(calls).toEqual([{ route: { name: "chat", slug: SLUG }, options: undefined }]);
  });

  test("inline rename commits via PATCH and updates the row", async () => {
    const client = new FakeApiClient({ streamDelayMs: 0 });
    const id = await seedSession(client, "original title");

    const { navigate } = recordingNavigate();
    const { findByText, findByLabelText } = render(
      <SessionList client={client} slug={SLUG} currentSessionId={undefined} navigate={navigate} />,
    );

    fireEvent.click(await findByText("Rename"));
    const input = (await findByLabelText(/Rename "original title"/)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "renamed title" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await findByText("renamed title")).toBeTruthy();

    // The server-side title actually changed — a fresh list call proves the
    // PATCH landed, not just local component state.
    const sessions = await client.listSessions(SLUG);
    expect(sessions.find((s) => s.id === id)?.title).toBe("renamed title");
  });

  test("inline rename commits on blur too", async () => {
    const client = new FakeApiClient({ streamDelayMs: 0 });
    await seedSession(client, "blur me");

    const { navigate } = recordingNavigate();
    const { findByText, findByLabelText } = render(
      <SessionList client={client} slug={SLUG} currentSessionId={undefined} navigate={navigate} />,
    );

    fireEvent.click(await findByText("Rename"));
    const input = (await findByLabelText(/Rename "blur me"/)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "committed on blur" } });
    fireEvent.blur(input);

    expect(await findByText("committed on blur")).toBeTruthy();
  });

  // F4 review fix — probe-confirmed: `suppressBlurRef` was set by
  // Enter/Escape but nothing ever reset it, because unmounting the input
  // (when `editing` flips back to `false`) never fires a real blur event to
  // consume it. The flag survived into the NEXT edit on the same row and
  // silently ate ITS blur-commit.
  test("rename via Enter, then rename the SAME row via blur — the second edit's blur-commit is not swallowed", async () => {
    const client = new FakeApiClient({ streamDelayMs: 0 });
    await seedSession(client, "first title");

    const { navigate } = recordingNavigate();
    const { findByText, findByLabelText } = render(
      <SessionList client={client} slug={SLUG} currentSessionId={undefined} navigate={navigate} />,
    );

    // First edit: committed via Enter — the handler that sets
    // `suppressBlurRef.current = true`, so the blur that follows the
    // input's unmount doesn't ALSO commit.
    fireEvent.click(await findByText("Rename"));
    const firstInput = (await findByLabelText(/Rename "first title"/)) as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "second title" } });
    fireEvent.keyDown(firstInput, { key: "Enter" });
    expect(await findByText("second title")).toBeTruthy();

    // Second edit on the SAME row, this time committed via blur — before
    // the fix, the leftover flag from the FIRST edit ate this commit
    // silently: `onBlur` saw `suppressBlurRef.current === true`, cleared it,
    // and returned without ever calling `commit()`.
    fireEvent.click(await findByText("Rename"));
    const secondInput = (await findByLabelText(/Rename "second title"/)) as HTMLInputElement;
    fireEvent.change(secondInput, { target: { value: "third title" } });
    fireEvent.blur(secondInput);

    expect(await findByText("third title")).toBeTruthy();
  });

  test("Escape cancels the rename without sending a PATCH", async () => {
    const client = new FakeApiClient({ streamDelayMs: 0 });
    await seedSession(client, "keep this title");

    const { navigate } = recordingNavigate();
    const { findByText, findByLabelText, queryByText } = render(
      <SessionList client={client} slug={SLUG} currentSessionId={undefined} navigate={navigate} />,
    );

    fireEvent.click(await findByText("Rename"));
    const input = (await findByLabelText(/Rename "keep this title"/)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "should not be saved" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(await findByText("keep this title")).toBeTruthy();
    expect(queryByText("should not be saved")).toBeNull();
  });

  test("delete requires confirm, then removes the session from the list", async () => {
    const client = new FakeApiClient({ streamDelayMs: 0 });
    await seedSession(client, "delete me");
    const keepId = await seedSession(client, "keep me");

    const { navigate } = recordingNavigate();
    const { findAllByText, findByText, queryByText } = render(
      <SessionList client={client} slug={SLUG} currentSessionId={undefined} navigate={navigate} />,
    );

    expect(await findByText("delete me")).toBeTruthy();

    const deleteButtons = await findAllByText("Delete");
    // Newest-first: "keep me" (seeded second) renders first, so "delete me"
    // is the SECOND row's Delete button.
    fireEvent.click(deleteButtons[1] as HTMLElement);

    // Confirm affordance — the row is not removed by a single click.
    expect(await findByText("Delete this session?")).toBeTruthy();
    expect(queryByText("delete me")).toBeTruthy();

    fireEvent.click(await findByText("Confirm"));

    expect(await findByText("keep me")).toBeTruthy();
    expect(queryByText("delete me")).toBeNull();

    const remaining = await client.listSessions(SLUG);
    expect(remaining.map((s) => s.id)).toEqual([keepId]);
  });

  test("delete confirm Cancel keeps the session", async () => {
    const client = new FakeApiClient({ streamDelayMs: 0 });
    await seedSession(client, "do not delete me");

    const { navigate } = recordingNavigate();
    const { findByText } = render(
      <SessionList client={client} slug={SLUG} currentSessionId={undefined} navigate={navigate} />,
    );

    fireEvent.click(await findByText("Delete"));
    expect(await findByText("Delete this session?")).toBeTruthy();

    fireEvent.click(await findByText("Cancel"));

    expect(await findByText("do not delete me")).toBeTruthy();
    expect(await client.listSessions(SLUG)).toHaveLength(1);
  });

  test("409 session_busy renders a 'turn still running' message and keeps the session listed", async () => {
    // `busySessionIds` scripts `deleteSession` to 409 for a known id — the
    // fake mints ids sequentially starting at "sess_1", so the first
    // session this client ever creates gets that id.
    const busyClient = new FakeApiClient({ streamDelayMs: 0, busySessionIds: ["sess_1"] });
    await seedSession(busyClient, "busy session");

    const { navigate } = recordingNavigate();
    const { findByText } = render(
      <SessionList
        client={busyClient}
        slug={SLUG}
        currentSessionId={undefined}
        navigate={navigate}
      />,
    );

    fireEvent.click(await findByText("Delete"));
    fireEvent.click(await findByText("Confirm"));

    expect(
      await findByText("Turn still running — try deleting again once it finishes."),
    ).toBeTruthy();
    // Still there — the 409 must not have removed the row.
    expect(await findByText("busy session")).toBeTruthy();
  });

  test("deleting the currently-open session navigates to new chat", async () => {
    const client = new FakeApiClient({ streamDelayMs: 0 });
    const id = await seedSession(client, "the open session");

    const { navigate, calls } = recordingNavigate();
    const { findByText } = render(
      <SessionList client={client} slug={SLUG} currentSessionId={id} navigate={navigate} />,
    );

    fireEvent.click(await findByText("Delete"));
    fireEvent.click(await findByText("Confirm"));

    await findByText(/No sessions yet/);

    expect(calls).toEqual([{ route: { name: "chat", slug: SLUG }, options: undefined }]);
  });

  test("deleting a session that is NOT currently open does not navigate", async () => {
    const client = new FakeApiClient({ streamDelayMs: 0 });
    const openId = await seedSession(client, "stays open");
    await seedSession(client, "gets deleted");

    const { navigate, calls } = recordingNavigate();
    const { findAllByText, findByText, queryByText } = render(
      <SessionList client={client} slug={SLUG} currentSessionId={openId} navigate={navigate} />,
    );

    // "gets deleted" was seeded second, so it's the newest — first row.
    const deleteButtons = await findAllByText("Delete");
    fireEvent.click(deleteButtons[0] as HTMLElement);
    fireEvent.click(await findByText("Confirm"));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queryByText("gets deleted")).toBeNull();
    expect(await findByText("stays open")).toBeTruthy();
    expect(calls).toEqual([]);
  });
});
