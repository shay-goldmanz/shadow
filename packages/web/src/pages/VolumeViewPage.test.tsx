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
    // A missing index is a normal state, not an error banner, and must not
    // block the chat button — the critical path's very next step.
    expect(await findByText(/Not indexed yet/)).toBeTruthy();
    expect(await findByRole("button", { name: "Chat with Shadow" })).toBeTruthy();
  });

  test("a volume with a built index renders its chapters and index tree", async () => {
    const client = new FakeApiClient();

    const { findByText, findAllByText } = render(
      <VolumeViewPage client={client} slug="design-inspiration" navigate={() => {}} />,
    );

    expect(await findByText("Design Inspiration")).toBeTruthy();
    // Each chapter title legitimately appears twice — once in the chapter
    // list, once in the index tree (`IndexTreeView` rendering the real
    // `VolumeIndexDocument` shape without crashing on `.nodes`, which was
    // this divergence's other half).
    expect((await findAllByText("How Linear and Notion Design UI")).length).toBeGreaterThan(0);
    expect((await findAllByText("How Epoch Magazine Designs One-Pagers")).length).toBeGreaterThan(
      0,
    );
  });
});
