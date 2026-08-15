import "../test/dom-setup.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { FakeApiClient } from "../api/fake-client.ts";
import { RulebookViewPage } from "./RulebookViewPage.tsx";

afterEach(() => cleanup());

describe("RulebookViewPage", () => {
  test("renders both seeded groups, with rule counts", async () => {
    const client = new FakeApiClient();
    const { findByText } = render(
      <RulebookViewPage client={client} slug="loan-agreement-rules" navigate={() => {}} />,
    );

    expect(await findByText("Loan Agreement Rules")).toBeTruthy();
    expect(await findByText("Interest & Fees")).toBeTruthy();
    expect(await findByText("Default & Remedies")).toBeTruthy();
    expect(await findByText(/Answering questions about this loan agreement's terms/)).toBeTruthy();
  });

  test("a missing rule book renders the error state, not a crash", async () => {
    const client = new FakeApiClient();
    const { findByText } = render(
      <RulebookViewPage client={client} slug="nope" navigate={() => {}} />,
    );

    expect(await findByText(/Could not load this rule book/)).toBeTruthy();
  });
});
