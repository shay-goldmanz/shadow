import "../test/dom-setup.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { FakeApiClient } from "../api/fake-client.ts";
import { RulebookListPage } from "./RulebookListPage.tsx";

afterEach(() => cleanup());

describe("RulebookListPage", () => {
  test("renders the seeded rule book with its status and group count", async () => {
    const client = new FakeApiClient();
    const { findByText } = render(<RulebookListPage client={client} navigate={() => {}} />);

    expect(await findByText("Loan Agreement Rules")).toBeTruthy();
    expect(await findByText(/2 groups/)).toBeTruthy();
  });

  test("an empty rule-book list shows the empty state, not nothing", async () => {
    const client = new FakeApiClient({ rulebooks: [] });
    const { findByText } = render(<RulebookListPage client={client} navigate={() => {}} />);

    expect(await findByText(/No rule books yet/)).toBeTruthy();
  });
});
