/**
 * Seed data for `FakeApiClient`'s default state. Narrated to match
 * `docs/ACCEPTANCE.md`'s critical path (Linear/Notion UI, Epoch one-pagers)
 * so `bun run dev` demonstrates every state the operator interface must
 * make visible: a passing audit with clay citations, a failing audit with
 * named claims, and an orphaned citation rendered as a warning (D22).
 */

import type {
  AuditResult,
  Chapter,
  ChapterSummary,
  Claim,
  IndexTree,
  LedgerEvent,
  SourceRecord,
  Volume,
  VolumeSummary,
} from "./types.ts";

export interface SeedChapter {
  readonly chapter: Chapter;
  readonly claims: readonly Claim[];
  readonly audit: AuditResult;
}

export interface SeedVolume {
  readonly volume: Volume;
  readonly chapters: readonly SeedChapter[];
  readonly index: IndexTree;
  readonly sources: readonly SourceRecord[];
  readonly snapshots: Readonly<Record<string, string>>;
  readonly ledger: readonly LedgerEvent[];
}

const now = "2026-08-11T09:00:00.000Z";

const linearSource: SourceRecord = {
  id: "src_linear_docs",
  url: "https://linear.app/method/writing-things-down",
  title: "Linear Method — Writing things down",
  author: "Linear",
  publishedAt: "2023-04-11",
  transport: "live",
  retrievedAt: now,
};

const notionSource: SourceRecord = {
  id: "src_notion_design",
  url: "https://www.notion.so/blog/inside-the-design",
  title: "Inside the design of Notion",
  author: "Notion",
  publishedAt: "2022-09-02",
  transport: "live",
  retrievedAt: now,
};

const epochSource: SourceRecord = {
  id: "src_epoch_onepager",
  url: "https://epoch.example/journal/one-pager-craft",
  title: "Epoch — the craft of the one-pager",
  author: "Epoch Editorial",
  publishedAt: "2021-11-20",
  transport: "live",
  retrievedAt: now,
};

const operatorSource: SourceRecord = {
  id: "src_session_2026_08_11",
  url: "session://2026-08-11T09:00:00.000Z",
  title: "Operator session, 2026-08-11",
  author: null,
  publishedAt: null,
  transport: "session",
  retrievedAt: now,
};

const linearChapterBody = `Linear favours a tight 4px spacing scale and restrained borders over shadows.[^lin-4px]
Notion leans on generous whitespace and a near-monochrome palette to keep content in front.[^notion-whitespace]
The operator believes both are worth studying because they read as quiet and deliberate rather than decorative.[^belief-quiet]

## Density

Linear's density comes from tight alignment and purposeful use of borders as the primary structural device, rather than shadows.[^lin-borders]
`;

const linearClaims: Claim[] = [
  {
    label: "lin-4px",
    kind: "sourced",
    text: "Linear favours a tight 4px spacing scale and restrained borders over shadows.",
    checkRequired: true,
    status: "supported",
    evidence: [
      {
        sourceId: linearSource.id,
        snapshotHash: "snap_linear_4px",
        exact: "We use a 4px spacing scale throughout and prefer borders to shadows.",
        anchorStatus: "anchored",
      },
    ],
  },
  {
    label: "notion-whitespace",
    kind: "sourced",
    text: "Notion leans on generous whitespace and a near-monochrome palette to keep content in front.",
    checkRequired: true,
    status: "supported",
    evidence: [
      {
        sourceId: notionSource.id,
        snapshotHash: "snap_notion_whitespace",
        exact:
          "Generous whitespace and a near-monochrome palette keep the content, not the chrome, in front.",
        anchorStatus: "anchored",
      },
    ],
  },
  {
    label: "belief-quiet",
    kind: "operator",
    text: "The operator believes both are worth studying because they read as quiet and deliberate rather than decorative.",
    checkRequired: true,
    status: "supported",
    evidence: [
      {
        sourceId: operatorSource.id,
        snapshotHash: "snap_operator_quiet",
        exact: "I believe in how Linear and Notion design UI.",
        anchorStatus: "anchored",
      },
    ],
  },
  {
    label: "lin-borders",
    kind: "sourced",
    text: "Linear's density comes from tight alignment and purposeful use of borders as the primary structural device, rather than shadows.",
    checkRequired: true,
    status: "supported",
    evidence: [
      {
        sourceId: linearSource.id,
        snapshotHash: "snap_linear_4px",
        exact: "We use a 4px spacing scale throughout and prefer borders to shadows.",
        anchorStatus: "anchored",
      },
    ],
  },
];

const linearAudit: AuditResult = {
  verdict: "pass",
  findings: [],
  narrativeRatio: 0.15,
  extractiveness: 0.22,
};

const epochChapterBody = `Epoch's one-pagers use a single dominant image and one clear point of entry for the eye.[^epoch-entry]
Every one-pager Epoch has ever published uses exactly three colours.[^epoch-three-colours]
The layout grid is derived from classical print proportions.[^epoch-grid]
`;

const epochClaims: Claim[] = [
  {
    label: "epoch-entry",
    kind: "sourced",
    text: "Epoch's one-pagers use a single dominant image and one clear point of entry for the eye.",
    checkRequired: true,
    status: "supported",
    evidence: [
      {
        sourceId: epochSource.id,
        snapshotHash: "snap_epoch_entry",
        exact: "Every spread opens on a single dominant image, one clear point of entry.",
        anchorStatus: "anchored",
      },
    ],
  },
  {
    label: "epoch-three-colours",
    kind: "sourced",
    text: "Every one-pager Epoch has ever published uses exactly three colours.",
    checkRequired: true,
    status: "unsupported",
    rationale:
      "The cited snapshot describes the most recent issue's palette, not a universal rule across every issue Epoch has published. The absolute claim overreaches its evidence.",
    evidence: [
      {
        sourceId: epochSource.id,
        snapshotHash: "snap_epoch_colour",
        exact: "This issue restrains itself to three colours: ink, paper, and a single accent.",
        anchorStatus: "anchored",
      },
    ],
  },
  {
    label: "epoch-grid",
    kind: "sourced",
    text: "The layout grid is derived from classical print proportions.",
    checkRequired: true,
    status: "unchecked",
    evidence: [
      {
        sourceId: epochSource.id,
        snapshotHash: "snap_epoch_grid_stale",
        exact: "The grid nods to classical print proportions without copying them outright.",
        anchorStatus: "orphaned",
      },
    ],
  },
];

const epochAudit: AuditResult = {
  verdict: "fail",
  findings: [
    {
      claim: "epoch-three-colours",
      check: "span-entailment",
      message:
        "Cited span describes only the current issue; the claim generalizes to 'every one-pager Epoch has ever published'.",
    },
  ],
  narrativeRatio: 0.1,
  extractiveness: 0.31,
};

const seedIndex: IndexTree = {
  volume: "design-inspiration",
  generatedAt: now,
  nodes: [
    {
      id: "chap_linear_notion",
      title: "How Linear and Notion Design UI",
      headingPath: ["How Linear and Notion Design UI"],
      whenToUse: "Designing UI chrome for a tool the operator will use daily.",
      children: [
        {
          id: "chap_linear_notion#density",
          title: "Density",
          headingPath: ["How Linear and Notion Design UI", "Density"],
        },
      ],
    },
    {
      id: "chap_epoch",
      title: "How Epoch Magazine Designs One-Pagers",
      headingPath: ["How Epoch Magazine Designs One-Pagers"],
      whenToUse: "Designing a single-page, print-flavoured layout.",
      notFor: "Multi-page or scroll-heavy interfaces.",
    },
  ],
};

export function seedVolume(): SeedVolume {
  const volume: Volume = {
    slug: "design-inspiration",
    title: "Design Inspiration",
    description: "Beliefs about how Linear, Notion, and Epoch design their interfaces.",
    frontmatter: {},
    createdAt: now,
    updatedAt: now,
  };

  return {
    volume,
    chapters: [
      {
        chapter: {
          slug: "linear-and-notion-ui",
          title: "How Linear and Notion Design UI",
          body: linearChapterBody,
          frontmatter: {
            when_to_use: "Designing UI chrome for a tool the operator will use daily.",
          },
          createdAt: now,
          updatedAt: now,
        },
        claims: linearClaims,
        audit: linearAudit,
      },
      {
        chapter: {
          slug: "epoch-one-pagers",
          title: "How Epoch Magazine Designs One-Pagers",
          body: epochChapterBody,
          frontmatter: { when_to_use: "Designing a single-page, print-flavoured layout." },
          createdAt: now,
          updatedAt: now,
        },
        claims: epochClaims,
        audit: epochAudit,
      },
    ],
    index: seedIndex,
    sources: [linearSource, notionSource, epochSource, operatorSource],
    snapshots: {
      snap_linear_4px:
        "We use a 4px spacing scale throughout and prefer borders to shadows. Density without clutter is the goal: tight alignment, restrained colour, purposeful whitespace.",
      snap_notion_whitespace:
        "Generous whitespace and a near-monochrome palette keep the content, not the chrome, in front. Notion treats the page as the interface.",
      snap_operator_quiet:
        "I believe in how Linear and Notion design UI, and that Epoch magazine are experts in designing one-pagers.",
      snap_epoch_entry:
        "Every spread opens on a single dominant image, one clear point of entry. The reader's eye should never have to search for where to start.",
      snap_epoch_colour:
        "This issue restrains itself to three colours: ink, paper, and a single accent. Restraint is the house style.",
      snap_epoch_grid_stale:
        "The grid nods to classical print proportions without copying them outright.",
    },
    ledger: [
      { ts: now, event: "source.retrieved", sourceId: linearSource.id },
      { ts: now, event: "source.retrieved", sourceId: notionSource.id },
      { ts: now, event: "audit.completed", chapter: "linear-and-notion-ui", result: "pass" },
      { ts: now, event: "source.retrieved", sourceId: epochSource.id },
      {
        ts: now,
        event: "claim.restated",
        claimId: "epoch-three-colours",
        from: "Epoch magazine always uses exactly three colours in every one-pager they have ever made.",
        to: "Every one-pager Epoch has ever published uses exactly three colours.",
        reason:
          "Original phrasing overstated the source, which describes only the current issue's palette.",
        outcome: "applied",
      },
      {
        ts: now,
        event: "source.drifted",
        sourceId: epochSource.id,
        invalidatedClaims: 1,
      },
      { ts: now, event: "audit.completed", chapter: "epoch-one-pagers", result: "fail" },
    ],
  };
}

export function volumeSummaryOf(seed: SeedVolume): VolumeSummary {
  return {
    slug: seed.volume.slug,
    title: seed.volume.title,
    description: seed.volume.description,
    chapterCount: seed.chapters.length,
    updatedAt: seed.volume.updatedAt,
  };
}

export function chapterSummariesOf(seed: SeedVolume): ChapterSummary[] {
  return seed.chapters.map((c) => ({
    slug: c.chapter.slug,
    title: c.chapter.title,
    whenToUse: c.chapter.frontmatter.when_to_use as string | undefined,
    updatedAt: c.chapter.updatedAt,
  }));
}
