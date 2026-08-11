/**
 * The golden query set (T4.1), versioned against `fixtures/corpus`.
 *
 * Bump `GOLDEN_SET_VERSION` whenever a query is added, removed, or
 * re-judged. Do NOT edit an existing query's `relevant`/`judgedIrrelevant`
 * set to make a disappointing result look better — that is precisely the
 * "golden set drifts into scoring only the slice it already has labels
 * for" failure D17 exists to catch, and the brief this package was built
 * against says plainly: "measure honestly, not to confirm."
 */

import { chapterId } from "../corpus/chapter-id.ts";
import type { GoldenQuery } from "./types.ts";

export const GOLDEN_SET_VERSION = "2026-08-11.1";

const id = chapterId;

export const GOLDEN_QUERIES: readonly GoldenQuery[] = [
  // ---- single-chapter, exact/near vocabulary overlap — sanity checks ----
  {
    id: "density-exact",
    query: "How should I set row height for a dense data table like Linear's?",
    relevant: [id("interface-design", "information-density")],
    judgedIrrelevant: [
      id("interface-design", "loading-and-skeletons"),
      id("interface-design", "navigation-hierarchy"),
    ],
    tags: ["single-chapter", "exact-vocabulary"],
  },
  {
    id: "commit-exact",
    query: "What's the right way to write a commit message?",
    relevant: [id("writing-craft", "commit-messages")],
    judgedIrrelevant: [
      id("writing-craft", "pr-descriptions"),
      id("writing-craft", "changelog-voice"),
    ],
    tags: ["single-chapter", "exact-vocabulary"],
  },
  {
    id: "flag-exact",
    query: "When should I use a feature flag and how long can it live?",
    relevant: [id("architecture-practice", "feature-flags")],
    judgedIrrelevant: [id("architecture-practice", "migration-safety")],
    tags: ["single-chapter", "exact-vocabulary"],
  },
  {
    id: "postmortem-exact",
    query: "How do we run a blameless postmortem after an incident?",
    relevant: [id("team-process", "incident-postmortems")],
    judgedIrrelevant: [id("team-process", "on-call-rotation")],
    tags: ["single-chapter", "exact-vocabulary"],
  },
  {
    id: "empty-exact",
    query: "What should an empty state say when there's no data yet?",
    relevant: [id("interface-design", "empty-states")],
    judgedIrrelevant: [
      id("interface-design", "loading-and-skeletons"),
      id("interface-design", "onboarding-flows"),
    ],
    tags: ["single-chapter", "exact-vocabulary"],
  },
  {
    id: "errorcopy-exact",
    query: "How should error messages be written for end users?",
    relevant: [id("writing-craft", "error-copy")],
    judgedIrrelevant: [id("writing-craft", "changelog-voice")],
    tags: ["single-chapter", "exact-vocabulary"],
  },
  {
    id: "versioning-exact",
    query: "How do I version a public API without breaking every client on every change?",
    relevant: [id("architecture-practice", "api-versioning")],
    judgedIrrelevant: [id("architecture-practice", "migration-safety")],
    tags: ["single-chapter", "exact-vocabulary"],
  },
  {
    id: "ports-exact",
    query:
      "When does a dependency deserve its own interface boundary instead of being called directly?",
    relevant: [id("architecture-practice", "ports-and-adapters")],
    judgedIrrelevant: [id("architecture-practice", "monorepo-boundaries")],
    tags: ["single-chapter", "exact-vocabulary"],
  },
  {
    id: "form-exact",
    query:
      "When should a form show a validation error — as soon as I start typing, or after I leave the field?",
    relevant: [id("interface-design", "form-validation")],
    judgedIrrelevant: [id("interface-design", "empty-states")],
    tags: ["single-chapter", "exact-vocabulary"],
  },
  {
    id: "onepager-exact",
    query: "How do I write a one-page proposal that argues for a single decision?",
    relevant: [id("writing-craft", "one-pagers")],
    judgedIrrelevant: [id("writing-craft", "readme-structure")],
    tags: ["single-chapter", "exact-vocabulary"],
  },

  // ---- single-chapter, NO vocabulary overlap — the crux ----
  {
    id: "onboarding-noverlap",
    query:
      "Our first-run experience walks brand-new signups through a five-screen tour before they can do anything real — good idea?",
    relevant: [id("interface-design", "onboarding-flows")],
    judgedIrrelevant: [id("interface-design", "empty-states")],
    tags: ["single-chapter", "no-vocabulary-overlap"],
    notes: "Avoids 'onboarding'/'welcome screen'; paraphrases as 'first-run experience'/'tour'.",
  },
  {
    id: "pr-noverlap",
    query:
      "What should I actually write in the box GitHub gives me before someone reviews my code changes?",
    relevant: [id("writing-craft", "pr-descriptions")],
    judgedIrrelevant: [
      id("writing-craft", "commit-messages"),
      id("team-process", "code-review-norms"),
    ],
    tags: ["single-chapter", "no-vocabulary-overlap"],
    notes: "Avoids 'pull request'/'PR description' entirely.",
  },
  {
    id: "migration-noverlap",
    query:
      "We changed a column's name in a single deploy step against a live production database and now some rows are missing data — what went wrong?",
    relevant: [id("architecture-practice", "migration-safety")],
    judgedIrrelevant: [id("architecture-practice", "api-versioning")],
    tags: ["single-chapter", "no-vocabulary-overlap"],
    notes: "Avoids 'migration'/'rollback'/'backfill'/'NOT NULL'.",
  },
  {
    id: "errors-noverlap",
    query:
      "Is it fine to catch an error and check if its text contains a certain phrase to decide what to do next?",
    relevant: [id("architecture-practice", "error-handling-philosophy")],
    judgedIrrelevant: [id("writing-craft", "error-copy")],
    tags: ["single-chapter", "no-vocabulary-overlap"],
    notes: "Avoids 'typed error'/'instanceof'/'exception hierarchy'.",
  },
  {
    id: "nav-noverlap",
    query:
      "At what point does clicking through nested menus become worse than just letting people type what they want?",
    relevant: [id("interface-design", "navigation-hierarchy")],
    judgedIrrelevant: [id("interface-design", "information-density")],
    tags: ["single-chapter", "no-vocabulary-overlap"],
    notes: "Avoids 'sidebar'/'command palette'/'Cmd-K'/'tabs'.",
  },
  {
    id: "decision-noverlap",
    query:
      "Our team keeps re-arguing the same architectural choice every few months because nobody remembers why we picked it — how do we stop that?",
    relevant: [id("team-process", "decision-records")],
    judgedIrrelevant: [id("architecture-practice", "ports-and-adapters")],
    tags: ["single-chapter", "no-vocabulary-overlap"],
    notes: "Avoids 'decision record'/'ADR'/'rationale'.",
  },
  {
    id: "testing-noverlap",
    query:
      "We have almost every line of code covered by a test and the product still broke in production — what's missing?",
    relevant: [id("architecture-practice", "testing-strategy")],
    judgedIrrelevant: [id("team-process", "incident-postmortems")],
    tags: ["single-chapter", "no-vocabulary-overlap"],
    notes: "Avoids 'unit test'/'end-to-end'/'coverage' as a term of art.",
  },
  {
    id: "oncall-noverlap",
    query: "How do we stop the same one engineer from getting woken up every single night?",
    relevant: [id("team-process", "on-call-rotation")],
    judgedIrrelevant: [id("team-process", "incident-postmortems")],
    tags: ["single-chapter", "no-vocabulary-overlap"],
    notes: "Avoids 'on-call'/'rotation'/'pager'/'escalation'.",
  },
  {
    id: "darkmode-noverlap",
    query:
      "If I just flip every white pixel to black for a night theme, why does it look worse than the light version?",
    relevant: [id("interface-design", "dark-mode-tokens")],
    judgedIrrelevant: [id("interface-design", "information-density")],
    tags: ["single-chapter", "no-vocabulary-overlap"],
    notes: "Avoids 'dark mode'/'tokens'/'elevation'/'surface'.",
  },
  {
    id: "monorepo-noverlap",
    query:
      "Two parts of our codebase live in the same repo but never change together — should they still share one package?",
    relevant: [id("architecture-practice", "monorepo-boundaries")],
    judgedIrrelevant: [id("architecture-practice", "ports-and-adapters")],
    tags: ["single-chapter", "no-vocabulary-overlap"],
    notes: "Avoids 'monorepo'/'workspace'/'package boundary'.",
  },
  {
    id: "loading-noverlap",
    query:
      "Our page flashes a spinner for barely a tenth of a second before the content pops in — should we even show it?",
    relevant: [id("interface-design", "loading-and-skeletons")],
    judgedIrrelevant: [id("interface-design", "empty-states")],
    tags: ["single-chapter", "no-vocabulary-overlap"],
    notes: "Avoids 'skeleton'/'spinner' as a labeled term/'400ms'.",
  },
  {
    id: "codereview-noverlap",
    query:
      "Should every comment I leave on someone's code change be treated as something they must fix before merging?",
    relevant: [id("team-process", "code-review-norms")],
    judgedIrrelevant: [id("writing-craft", "pr-descriptions")],
    tags: ["single-chapter", "no-vocabulary-overlap"],
    notes: "Avoids 'code review'/'nit'/'blocking comment'.",
  },
  {
    id: "sprint-noverlap",
    query: "Is it better to size upcoming work in hours, or by how unfamiliar it is?",
    relevant: [id("team-process", "sprint-planning-critique")],
    judgedIrrelevant: [id("architecture-practice", "testing-strategy")],
    tags: ["single-chapter", "no-vocabulary-overlap"],
    notes: "Avoids 'sprint planning'/'story points'/'estimation'.",
  },

  // ---- multi-chapter: genuinely answered by more than one chapter ----
  {
    id: "multi-reader-decides",
    query:
      "I'm writing documentation meant to be read quickly by someone deciding whether my project or my change is relevant to them.",
    relevant: [id("writing-craft", "readme-structure"), id("writing-craft", "changelog-voice")],
    judgedIrrelevant: [id("writing-craft", "one-pagers")],
    tags: ["multi-chapter"],
  },
  {
    id: "multi-breaking-signal",
    query: "What's the right way to signal a breaking change to people who depend on my code?",
    relevant: [
      id("architecture-practice", "api-versioning"),
      id("writing-craft", "changelog-voice"),
    ],
    judgedIrrelevant: [id("architecture-practice", "migration-safety")],
    tags: ["multi-chapter"],
  },
  {
    id: "multi-newhire",
    query:
      "How much should a new teammate be expected to figure out on their own versus have written down for them?",
    relevant: [
      id("team-process", "documentation-debt"),
      id("interface-design", "onboarding-flows"),
    ],
    judgedIrrelevant: [id("writing-craft", "readme-structure")],
    tags: ["multi-chapter", "no-vocabulary-overlap"],
  },
  {
    id: "multi-firstimpression",
    query: "What's the first thing a new reader or new user should see, before anything else?",
    relevant: [id("writing-craft", "readme-structure"), id("interface-design", "onboarding-flows")],
    judgedIrrelevant: [id("writing-craft", "one-pagers")],
    tags: ["multi-chapter"],
  },

  // ---- not-in-corpus: genuinely absent topics ----
  {
    id: "notincorpus-pricing",
    query: "What's the best way to price an enterprise SaaS contract with volume discounts?",
    relevant: [],
    expectNotInCorpus: true,
    tags: ["not-in-corpus"],
  },
  {
    id: "notincorpus-k8s",
    query: "How should I configure autoscaling thresholds for a Kubernetes deployment?",
    relevant: [],
    expectNotInCorpus: true,
    judgedIrrelevant: [id("architecture-practice", "monorepo-boundaries")],
    tags: ["not-in-corpus", "distractor"],
    notes: "Infra-adjacent to the architecture volume, but genuinely uncovered.",
  },
  {
    id: "notincorpus-typeface",
    query: "What typeface pairs well with a serif body font for marketing emails?",
    relevant: [],
    expectNotInCorpus: true,
    judgedIrrelevant: [id("interface-design", "dark-mode-tokens")],
    tags: ["not-in-corpus", "distractor"],
    notes:
      "interface-design's VOLUME.md not_for explicitly excludes marketing site theming and brand identity.",
  },
  {
    id: "notincorpus-salestax",
    query: "How do I calculate sales tax nexus for a multi-state e-commerce business?",
    relevant: [],
    expectNotInCorpus: true,
    tags: ["not-in-corpus"],
  },
  {
    id: "notincorpus-compression",
    query: "What's a good algorithm for compressing images losslessly?",
    relevant: [],
    expectNotInCorpus: true,
    judgedIrrelevant: [id("architecture-practice", "testing-strategy")],
    tags: ["not-in-corpus"],
  },

  // ---- distractor: a lexically tempting chapter is explicitly wrong ----
  {
    id: "distractor-onboarding-whitespace",
    query: "How much whitespace should a mobile-first onboarding screen have?",
    relevant: [id("interface-design", "onboarding-flows")],
    judgedIrrelevant: [id("interface-design", "information-density")],
    tags: ["single-chapter", "distractor"],
    notes:
      "information-density's own not_for lists 'onboarding flows' and 'mobile-first layouts' explicitly — a correct router must not be pulled there by the shared word 'whitespace'.",
  },
  {
    id: "distractor-search-empty",
    query: "Our search box shows 'no results' right now — what should replace that message?",
    relevant: [id("interface-design", "empty-states")],
    judgedIrrelevant: [
      id("interface-design", "navigation-hierarchy"),
      id("interface-design", "loading-and-skeletons"),
    ],
    tags: ["single-chapter", "distractor"],
  },
  {
    id: "distractor-backfill-rollback",
    query:
      "Should I add a rollback plan for a one-off backfill script an engineer runs by hand once?",
    relevant: [],
    expectNotInCorpus: true,
    judgedIrrelevant: [id("architecture-practice", "migration-safety")],
    tags: ["not-in-corpus", "distractor"],
    notes:
      "migration-safety's own not_for explicitly excludes one-off manual backfills run by an engineer — the chapter that most resembles the answer is the one that says it doesn't apply.",
  },
];
