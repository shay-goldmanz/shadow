import "../test/dom-setup.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { FakeApiClient } from "../api/fake-client.ts";
import { ChapterPage } from "./ChapterPage.tsx";

afterEach(() => cleanup());

describe("ChapterPage", () => {
  test("a chapter with a failing audit renders the failure state and names the failing claims", async () => {
    const client = new FakeApiClient();
    const { findByText, getAllByText } = render(
      <ChapterPage
        client={client}
        slug="design-inspiration"
        chapterSlug="epoch-one-pagers"
        navigate={() => {}}
      />,
    );

    expect(await findByText("Audit failed")).toBeTruthy();
    // The failing claim is named, not just a generic error.
    expect(getAllByText("[^epoch-three-colours]").length).toBeGreaterThan(0);
    expect(getAllByText(/generalizes to 'every one-pager/).length).toBeGreaterThan(0);
  });

  test("a passing audit renders as passed, not as a failure", async () => {
    const client = new FakeApiClient();
    const { findByText, queryByText } = render(
      <ChapterPage
        client={client}
        slug="design-inspiration"
        chapterSlug="linear-and-notion-ui"
        navigate={() => {}}
      />,
    );

    expect(await findByText("Audit passed")).toBeTruthy();
    expect(queryByText("Audit failed")).toBeNull();
  });

  test("evidence history is scoped to this chapter's own claims, not the whole volume's ledger", async () => {
    const client = new FakeApiClient();
    const { findByText, queryByText } = render(
      <ChapterPage
        client={client}
        slug="design-inspiration"
        chapterSlug="linear-and-notion-ui"
        navigate={() => {}}
      />,
    );

    // The seeded ledger's only claim.restated event belongs to the *other*
    // chapter (epoch-one-pagers, claim "epoch-three-colours") — it must not
    // leak onto this one just because the ledger is volume-wide.
    await findByText("How Linear and Notion Design UI");
    expect(queryByText("What Shadow softened")).toBeNull();
  });

  test("a grounded claim renders in the citation colour and its citation opens the snapshot", async () => {
    const client = new FakeApiClient();
    const { findByLabelText, findByText } = render(
      <ChapterPage
        client={client}
        slug="design-inspiration"
        chapterSlug="linear-and-notion-ui"
        navigate={() => {}}
      />,
    );

    const citation = await findByLabelText(/Citation lin-4px/);
    expect(citation.getAttribute("data-tone")).toBe("clay");

    fireEvent.click(citation);

    expect(await findByText(/We use a 4px spacing scale throughout/)).toBeTruthy();
    expect(await findByText("Linear Method — Writing things down")).toBeTruthy();
  });

  test("the audit's failing claim renders red, not clay", async () => {
    const client = new FakeApiClient();
    const { findByLabelText } = render(
      <ChapterPage
        client={client}
        slug="design-inspiration"
        chapterSlug="epoch-one-pagers"
        navigate={() => {}}
      />,
    );
    const citation = await findByLabelText(/Citation epoch-three-colours/);
    expect(citation.getAttribute("data-tone")).toBe("red");
  });

  test("an orphaned citation renders as a warning, not a failure", async () => {
    const client = new FakeApiClient();
    const { findByLabelText } = render(
      <ChapterPage
        client={client}
        slug="design-inspiration"
        chapterSlug="epoch-one-pagers"
        navigate={() => {}}
      />,
    );

    // epoch-grid's evidence has drifted (anchorStatus: "orphaned") but is not
    // one of the audit's failing findings — it must render amber, not red.
    const citation = await findByLabelText(/Citation epoch-grid/);
    expect(citation.getAttribute("data-tone")).toBe("amber");
    expect(citation.getAttribute("aria-label")).toContain("source drifted");
    expect(citation.getAttribute("aria-label")).not.toContain("audit failed");
  });

  test("surfaces what Shadow softened via the ledger, not swallowed", async () => {
    const client = new FakeApiClient();
    const { findByText } = render(
      <ChapterPage
        client={client}
        slug="design-inspiration"
        chapterSlug="epoch-one-pagers"
        navigate={() => {}}
      />,
    );

    expect(await findByText("What Shadow softened")).toBeTruthy();
    expect(await findByText(/Original phrasing overstated the source/)).toBeTruthy();
  });
});
