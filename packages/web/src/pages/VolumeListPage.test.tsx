import "../test/dom-setup.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { FakeApiClient } from "../api/fake-client.ts";
import { VolumeListPage } from "./VolumeListPage.tsx";

afterEach(() => cleanup());

describe("VolumeListPage", () => {
  test("renders existing volumes from the client", async () => {
    const client = new FakeApiClient();
    const { findByText } = render(<VolumeListPage client={client} navigate={() => {}} />);

    expect(await findByText("Design Inspiration")).toBeTruthy();
    expect(await findByText(/2 chapters/)).toBeTruthy();
  });

  test("an empty volume list shows the empty state rather than nothing", async () => {
    const client = new FakeApiClient({ volumes: [] });
    const { findByText } = render(<VolumeListPage client={client} navigate={() => {}} />);

    expect(await findByText(/No volumes yet/)).toBeTruthy();
  });

  test("submitting the create-volume form calls the client and navigates to the new volume", async () => {
    const client = new FakeApiClient({ volumes: [] });
    let navigatedTo: unknown;
    const { findByLabelText, getByRole } = render(
      <VolumeListPage client={client} navigate={(route) => (navigatedTo = route)} />,
    );

    const titleInput = await findByLabelText("Title");
    fireEvent.change(titleInput, { target: { value: "New Beliefs" } });
    fireEvent.click(getByRole("button", { name: "Create volume" }));

    await waitFor(() => {
      expect(navigatedTo).toEqual({ name: "volume", slug: "new-beliefs" });
    });

    const volumes = await client.listVolumes();
    expect(volumes).toHaveLength(1);
    expect(volumes[0]).toMatchObject({ slug: "new-beliefs", title: "New Beliefs" });
  });

  test("a duplicate slug surfaces the client's error rather than navigating", async () => {
    const client = new FakeApiClient();
    let navigated = false;
    const { findByLabelText, getByRole, findByRole } = render(
      <VolumeListPage client={client} navigate={() => (navigated = true)} />,
    );

    const titleInput = await findByLabelText("Title");
    fireEvent.change(titleInput, { target: { value: "Design Inspiration" } });
    fireEvent.click(getByRole("button", { name: "Create volume" }));

    expect(await findByRole("alert")).toBeTruthy();
    expect(navigated).toBe(false);
  });
});
