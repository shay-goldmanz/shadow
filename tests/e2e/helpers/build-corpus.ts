/**
 * Builds the realistic fixture corpus this suite reasons over, directly
 * against `@shadow/core`'s real `FileSystemVolumeStore` — the same store a
 * running `shadow` binary reads. Imported by *relative path* into the
 * package's TypeScript source (`../../../packages/core/src/index.ts`)
 * rather than the `@shadow/core` specifier: this directory is deliberately
 * not a workspace member (see `tests/e2e/README` note in the task report —
 * kept out of `packages/*` on purpose), so there is no `node_modules`
 * symlink for it to resolve against. Bun runs TypeScript source directly
 * (D7), so a relative import into a sibling package's source is exactly as
 * real as the `@shadow/*` specifier every in-package test already uses —
 * same files, same runtime, just addressed by path instead of by package
 * name. Nothing here modifies `packages/core` or `packages/indexing`; it
 * only calls their exported, public API, exactly as `packages/cli`'s own
 * `test-fixture.ts` does for the CLI's in-package tests.
 *
 * The corpus mirrors the acceptance critical path (Linear/Notion UI design,
 * Epoch's one-pager expertise) plus enough plausible distractors — a
 * near-neighbor "investor report" chapter in the *same* volume as the
 * target, an unrelated UI-design volume, and a wholly unrelated
 * process/engineering volume — that a query resolving to the right chapter
 * is actually discriminating between real alternatives, not just finding
 * the only chapter that exists.
 */

import {
  FileSystemVolumeStore,
  toChapterSlug,
  toVolumeSlug,
  type VolumeStore,
} from "../../../packages/core/src/index.ts";

/** The chapter this suite's queries are meant to resolve to. */
export const TARGET_CHAPTER_TITLE = "How Epoch designs a one-pager";

/**
 * The target chapter's authored routing fields, exported so the D11a
 * non-overlapping-vocabulary test can compute "the target chapter's
 * vocabulary" from the exact same strings that get written to disk, rather
 * than a second hand-copied literal that could drift from the fixture.
 */
export const TARGET_CHAPTER_ROUTING = {
  title: TARGET_CHAPTER_TITLE,
  when_to_use: "Designing a one-pager: a single-page editorial layout for a pitch handout.",
  not_for: "multi-page reports, slide decks, long-form articles",
  keywords: ["epoch", "one-pager", "editorial", "pitch", "handout"],
} as const;

export async function buildAgentConsumptionFixture(root: string): Promise<VolumeStore> {
  const store = new FileSystemVolumeStore(root);

  // ---- volume: writing (contains the target chapter + two near-neighbor distractors) ----
  const writing = toVolumeSlug("writing");
  await store.createVolume({
    slug: writing,
    title: "Writing",
    frontmatter: {
      when_to_use: "Drafting documents: one-pagers, reports, editorial formats, blog posts.",
      not_for: "UI design, code, process docs",
      keywords: ["writing", "editorial", "one-pager", "report", "blog"],
    },
  });

  await store.putChapter(writing, {
    slug: toChapterSlug("epoch-onepager"),
    title: TARGET_CHAPTER_TITLE,
    body:
      "# How Epoch designs a one-pager\n\n" +
      "Epoch magazine leans on strong editorial hierarchy: one dominant image up top, " +
      "a single pulled excerpt beneath it, and tight typographic rhythm so the whole " +
      "thing reads in one glance.\n\n" +
      "## Hierarchy over density\n\n" +
      "Whitespace does the organizing work; there is exactly one focal point per sheet, " +
      "never two competing ones.\n",
    frontmatter: {
      when_to_use: TARGET_CHAPTER_ROUTING.when_to_use,
      not_for: TARGET_CHAPTER_ROUTING.not_for,
      keywords: TARGET_CHAPTER_ROUTING.keywords,
      confidence: "high",
    },
  });

  await store.putChapter(writing, {
    slug: toChapterSlug("investor-report-structure"),
    title: "Structuring a quarterly investor report",
    body:
      "# Structuring a quarterly investor report\n\n" +
      "Open with a one-paragraph summary, then walk metrics section by section " +
      "across several pages, closing with a forward-looking outlook.\n",
    frontmatter: {
      when_to_use: "Multi-page investor updates, board reports, quarterly financial summaries.",
      not_for: "one-pagers, marketing collateral, social copy",
      keywords: ["report", "investor", "quarterly", "board"],
      confidence: "medium",
    },
  });

  await store.putChapter(writing, {
    slug: toChapterSlug("blog-post-narrative"),
    title: "Narrative arc for a blog post",
    body:
      "# Narrative arc for a blog post\n\n" +
      "Open on tension, resolve it by the final section, and keep paragraphs short " +
      "enough to read on a phone.\n",
    frontmatter: {
      when_to_use: "Long-form blog posts, narrative essays, opinion pieces.",
      not_for: "one-pagers, technical reference docs",
      keywords: ["blog", "narrative", "essay"],
      confidence: "medium",
    },
  });

  // ---- volume: ui-design (unrelated to the target query, distractor volume) ----
  const uiDesign = toVolumeSlug("ui-design");
  await store.createVolume({
    slug: uiDesign,
    title: "Interface Design",
    frontmatter: {
      when_to_use: "Designing UI: layout, density, navigation, component behavior.",
      not_for: "brand identity, illustration, motion design",
      keywords: ["linear", "notion", "density"],
    },
  });

  await store.putChapter(uiDesign, {
    slug: toChapterSlug("linear-density"),
    title: "How Linear handles information density",
    body:
      "# How Linear handles information density\n\n" +
      "Linear renders table rows at a tight 32px height and truncates labels " +
      "aggressively so dense data still scans quickly.\n",
    frontmatter: {
      when_to_use:
        "Designing list views, tables, dashboards. Choosing between density and whitespace.",
      not_for: "marketing pages, onboarding flows, empty states",
      keywords: ["density", "list view", "table", "row height", "linear"],
      confidence: "high",
    },
  });

  await store.putChapter(uiDesign, {
    slug: toChapterSlug("notion-whitespace"),
    title: "Notion's near-zero chrome",
    body:
      "# Notion's near-zero chrome\n\n" +
      "Notion favors generous whitespace and near-monochrome warm grey, with almost " +
      "no visible chrome around the content itself.\n",
    frontmatter: {
      when_to_use: "Designing calm, content-first surfaces with minimal UI chrome.",
      not_for: "dense data tables, dashboards",
      keywords: ["notion", "whitespace", "chrome", "calm"],
      confidence: "medium",
    },
  });

  // ---- volume: process (wholly unrelated domain, for the not-in-corpus proof) ----
  const processVolume = toVolumeSlug("process");
  await store.createVolume({
    slug: processVolume,
    title: "Team Process",
    frontmatter: {
      when_to_use: "Team process: code review, incident response, engineering rituals.",
      not_for: "design, writing, product strategy",
      keywords: ["process", "engineering"],
    },
  });

  await store.putChapter(processVolume, {
    slug: toChapterSlug("code-review-checklist"),
    title: "What we check before approving a pull request",
    body:
      "# What we check before approving a pull request\n\n" +
      "Every pull request needs a passing test, a clear description, and no unrelated " +
      "changes bundled in.\n",
    frontmatter: {
      when_to_use: "Reviewing a pull request before merge: correctness, tests, scope.",
      not_for: "design review, writing review",
      keywords: ["code review", "pull request", "merge"],
      confidence: "high",
    },
  });

  await store.putChapter(processVolume, {
    slug: toChapterSlug("incident-postmortem-format"),
    title: "How we write an incident postmortem",
    body:
      "# How we write an incident postmortem\n\n" +
      "Start with a timeline, then root cause, then follow-up actions with named " +
      "owners and dates.\n",
    frontmatter: {
      when_to_use: "Writing up an incident after resolution: timeline, root cause, follow-ups.",
      not_for: "pull request reviews, feature planning",
      keywords: ["incident", "postmortem", "root cause"],
      confidence: "medium",
    },
  });

  return store;
}
