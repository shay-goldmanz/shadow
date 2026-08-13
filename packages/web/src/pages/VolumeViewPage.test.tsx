import "../test/dom-setup.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { FakeApiClient } from "../api/fake-client.ts";
import { VolumeViewPage } from "./VolumeViewPage.tsx";

afterEach(() => cleanup());

describe("VolumeViewPage", () => {
  test("a freshly created volume (no index yet) renders the empty state, not a crash", async () => {
    const client = new FakeApiClient({ volumes: [] });
    await client.createVolume({ title: "Brand New Volume" });

    const { findByText, findByRole } = render(
      <VolumeViewPage client={client} slug="brand-new-volume" navigate={() => {}} />,
    );

    expect(await findByText("Brand New Volume")).toBeTruthy();
    expect(await findByText(/No chapters yet/)).toBeTruthy();
    // A missing index is a normal state, not an error banner — the outline
    // is folded into each chapter's own card now (`ChapterOutline`), so with
    // zero chapters there's nowhere for it to attach; the only thing that
    // must hold is that a missing index doesn't crash the page or block the
    // chat button, the critical path's very next step.
    expect(await findByRole("button", { name: "Chat with Shadow" })).toBeTruthy();
  });

  test("a volume with a built index renders each chapter's own outline inline", async () => {
    const client = new FakeApiClient();

    const { findByText } = render(
      <VolumeViewPage client={client} slug="design-inspiration" navigate={() => {}} />,
    );

    expect(await findByText("Design Inspiration")).toBeTruthy();
    // The chapter title now appears once — inside its own card — not once
    // there and once more in a separate index tree the operator had to
    // cross-reference by title (`ChapterOutline` renders only its sections
    // /key_items, not the title, matching the real `VolumeIndexDocument`
    // shape without crashing on `.nodes`, which was the original bug here).
    expect(await findByText("How Linear and Notion Design UI")).toBeTruthy();
    expect(await findByText("How Epoch Magazine Designs One-Pagers")).toBeTruthy();
  });
});
