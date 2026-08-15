import "../test/dom-setup.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { FakeApiClient } from "../api/fake-client.ts";
import { RulebookGroupPage } from "./RulebookGroupPage.tsx";

afterEach(() => cleanup());

describe("RulebookGroupPage", () => {
  test("renders a group's rules as bullets, with footnote markers for each cited rule", async () => {
    const client = new FakeApiClient();
    const { findByText } = render(
      <RulebookGroupPage
        client={client}
        slug="loan-agreement-rules"
        groupSlug="interest-and-fees"
        navigate={() => {}}
      />,
    );

    expect(await findByText("Interest & Fees")).toBeTruthy();
    expect(
      await findByText(/Borrowers must pay interest at a fixed annual rate of 6.5%/),
    ).toBeTruthy();
    expect(await findByText("Audit passed")).toBeTruthy();
  });

  test("a group with a failing audit names the overreaching rule, not just a generic error", async () => {
    const client = new FakeApiClient();
    const { findByText, getAllByText } = render(
      <RulebookGroupPage
        client={client}
        slug="loan-agreement-rules"
        groupSlug="default-and-remedies"
        navigate={() => {}}
      />,
    );

    expect(await findByText("Audit failed")).toBeTruthy();
    expect(getAllByText("[^default-forfeit]").length).toBeGreaterThan(0);
    expect(getAllByText(/generalizes to permanent forfeiture/).length).toBeGreaterThan(0);
  });

  test("a rule's citation opens the real evidence snapshot through the rule book's own evidence routes", async () => {
    const client = new FakeApiClient();
    const { findByLabelText, findByText } = render(
      <RulebookGroupPage
        client={client}
        slug="loan-agreement-rules"
        groupSlug="interest-and-fees"
        navigate={() => {}}
      />,
    );

    const citation = await findByLabelText(/Citation int-rate/);
    fireEvent.click(citation);

    // The fixture snapshot text and source title come from
    // `fake-data.ts`'s `SeedRulebook.sources`/`snapshots` — a real fetch
    // through `getRulebookSource`/`getRulebookSnapshot`, not the
    // "source-unreachable" placeholder this used to show.
    expect(
      await findByText(/the Borrower shall pay interest at a fixed rate of six and one-half/),
    ).toBeTruthy();
    expect(await findByText("Loan Agreement (rnb_loan.pdf)")).toBeTruthy();
  });
});
