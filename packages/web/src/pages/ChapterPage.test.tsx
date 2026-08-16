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

  test("clicking outside the evidence dialog closes it", async () => {
    const client = new FakeApiClient();
    const { findByLabelText, findByText, queryByText, container } = render(
      <ChapterPage
        client={client}
        slug="design-inspiration"
        chapterSlug="linear-and-notion-ui"
        navigate={() => {}}
      />,
    );

    fireEvent.click(await findByLabelText(/Citation lin-4px/));
    expect(await findByText("Linear Method — Writing things down")).toBeTruthy();

    // A click on the `<dialog>` element itself only happens via the
    // backdrop — clicking its content always targets a descendant.
    const dialog = container.querySelector("dialog");
    if (!dialog) throw new Error("expected the snapshot dialog to be in the DOM");
    fireEvent.click(dialog);

    expect(queryByText("Linear Method — Writing things down")).toBeNull();
  });

  test("a derived claim renders neutral and opens the claims it was derived from, not a dead click", async () => {
    const client = new FakeApiClient();
    const { findByLabelText, findByText, findAllByText } = render(
      <ChapterPage
        client={client}
        slug="design-inspiration"
        chapterSlug="linear-and-notion-ui"
        navigate={() => {}}
      />,
    );

    const citation = await findByLabelText(/Citation lin-and-notion-restraint/);
    // Rendered distinctly from a sourced claim (clay) — a derived claim
    // has no evidence span of its own, so it must not look like one that
    // does and then silently do nothing on click.
    expect(citation.getAttribute("data-tone")).toBe("neutral");
    expect(citation.getAttribute("aria-label")).toContain("derived from other claims");

    fireEvent.click(citation);

    expect(await findByText("Derived from [^lin-and-notion-restraint]")).toBeTruthy();
    // Both supporting claims' text also appears in the chapter's own prose
    // (each cited inline) — the dialog repeats it, so query for "at least
    // one", not "exactly one".
    expect(
      (
        await findAllByText(
          "Linear favours a tight 4px spacing scale and restrained borders over shadows.",
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(
      (
        await findAllByText(
          "Notion leans on generous whitespace and a near-monochrome palette to keep content in front.",
        )
      ).length,
    ).toBeGreaterThan(0);
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

  test("clicking an anchored citation shows the highlighted excerpt and expand toggle", async () => {
    const client = new FakeApiClient();
    const { findByLabelText, findByText } = render(
      <ChapterPage
        client={client}
        slug="design-inspiration"
        chapterSlug="linear-and-notion-ui"
        navigate={() => {}}
      />,
    );

    fireEvent.click(await findByLabelText(/Citation lin-4px/));

    // The exact quoted text appears highlighted in the excerpt.
    expect(await findByText(/We use a 4px spacing scale throughout/)).toBeTruthy();
    // The expand toggle is present, collapsed by default.
    expect(await findByText("▾ Show full source")).toBeTruthy();
  });

  test("an anchored-fuzzy citation shows the approximate badge and excerpt", async () => {
    const client = new FakeApiClient();
    const { findByLabelText, findByText } = render(
      <ChapterPage
        client={client}
        slug="design-inspiration"
        chapterSlug="epoch-one-pagers"
        navigate={() => {}}
      />,
    );

    fireEvent.click(await findByLabelText(/Citation epoch-fuzzy/));

    // The excerpt uses refinedBy offsets — the exact text at start=0..end=42.
    expect(await findByText(/The editorial tone is measured/)).toBeTruthy();
    // Fuzzy badge appears next to the source meta line.
    expect(await findByText("≈ approximate")).toBeTruthy();
    // Expand toggle is present.
    expect(await findByText("▾ Show full source")).toBeTruthy();
  });

  test("an orphaned citation shows the not-found badge, plain selector text, and a fallback toggle", async () => {
    const client = new FakeApiClient();
    const { findByLabelText, findByText } = render(
      <ChapterPage
        client={client}
        slug="design-inspiration"
        chapterSlug="epoch-one-pagers"
        navigate={() => {}}
      />,
    );

    fireEvent.click(await findByLabelText(/Citation epoch-grid/));

    // Selector exact rendered as plain text (not highlighted).
    expect(
      await findByText(
        "The grid nods to classical print proportions without copying them outright.",
      ),
    ).toBeTruthy();
    // Danger badge.
    expect(await findByText("⚠ not found")).toBeTruthy();
    // Toggle frames it as a fallback, not a confirmation.
    expect(await findByText("View full source anyway")).toBeTruthy();
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
