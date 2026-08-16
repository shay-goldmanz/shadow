/**
 * Seed data for `FakeApiClient`'s default state. Narrated to match
 * `docs/ACCEPTANCE.md`'s critical path (Linear/Notion UI, Epoch one-pagers)
 * so `bun run dev` demonstrates every state the operator interface must
 * make visible: a passing audit with clay citations, a failing audit with
 * named claims, and an orphaned citation rendered as a warning (D22).
 *
 * Every shape here is the reconciled wire shape (`./types.ts`), the same
 * one `@shadow/api` actually sends — not the earlier good-faith guess.
 */

import type {
  AuditRecord,
  Chapter,
  ChapterSummary,
  Claim,
  ClaimSidecar,
  LedgerEvent,
  Rulebook,
  RulebookGroupSummary,
  RulebookSummary,
  SourceRecord,
  Volume,
  VolumeIndexDocument,
  VolumeSummary,
} from "./types.ts";

export interface SeedChapter {
  readonly chapter: Chapter;
  readonly claims: ClaimSidecar;
  readonly audit: AuditRecord;
}

export interface SeedVolume {
  readonly volume: Volume;
  readonly chapters: readonly SeedChapter[];
  readonly index: VolumeIndexDocument;
  readonly sources: readonly SourceRecord[];
  readonly snapshots: Readonly<Record<string, string>>;
  readonly ledger: readonly LedgerEvent[];
}

/** A rule-book group is a chapter-shaped document (`group` reuses `Chapter`, same as the real API — `handlers/rulebooks.ts`'s module doc) — mirroring `SeedChapter`'s shape rather than inventing a parallel one. */
export interface SeedRulebookGroup {
  readonly group: Chapter;
  readonly claims: ClaimSidecar;
  readonly audit: AuditRecord;
}

export interface SeedRulebook {
  readonly rulebook: Rulebook;
  readonly groups: readonly SeedRulebookGroup[];
  readonly sources: readonly SourceRecord[];
  readonly snapshots: Readonly<Record<string, string>>;
}

const now = "2026-08-11T09:00:00.000Z";

function source(overrides: {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly author: string | null;
  readonly publishedAt: string | null;
  readonly transport: "live" | "fixture" | "session" | "file";
}): SourceRecord {
  return {
    schemaVersion: "1.0",
    id: overrides.id,
    url: overrides.url,
    finalUrl: overrides.url,
    title: overrides.title,
    author: overrides.author,
    publishedAt: overrides.publishedAt,
    retrieval: {
      retrievedAt: now,
      agent: "fake-client-seed",
      transport: overrides.transport,
    },
    snapshot: {
      path: `snapshots/${overrides.id}.txt`,
      payloadSha256: `sha256:${overrides.id}`,
      normalizedTextSha256: `sha256:${overrides.id}-normalized`,
      normalization: "nfc-ws-v1",
      chars: 200,
    },
    authority: { tier: "primary", rationale: "seed fixture" },
    volatility: "slow-changing",
  };
}

const linearSource = source({
  id: "src_linear_docs",
  url: "https://linear.app/method/writing-things-down",
  title: "Linear Method — Writing things down",
  author: "Linear",
  publishedAt: "2023-04-11",
  transport: "live",
});

const notionSource = source({
  id: "src_notion_design",
  url: "https://www.notion.so/blog/inside-the-design",
  title: "Inside the design of Notion",
  author: "Notion",
  publishedAt: "2022-09-02",
  transport: "live",
});

const epochSource = source({
  id: "src_epoch_onepager",
  url: "https://epoch.example/journal/one-pager-craft",
  title: "Epoch — the craft of the one-pager",
  author: "Epoch Editorial",
  publishedAt: "2021-11-20",
  transport: "live",
});

const operatorSource = source({
  id: "src_session_2026_08_11",
  url: "session://2026-08-11T09:00:00.000Z",
  title: "Operator session, 2026-08-11",
  author: null,
  publishedAt: null,
  transport: "session",
});

function claim(overrides: {
  readonly id: string;
  readonly label: string;
  readonly kind: Claim["kind"];
  readonly text: string;
  readonly status: Claim["verification"]["status"];
  readonly sourceId: string;
  readonly snapshotHash: string;
  readonly exact: string;
  readonly anchorStatus: Claim["evidence"][number]["anchorStatus"];
  readonly rationale?: string;
}): Claim {
  return {
    id: overrides.id,
    label: overrides.label,
    kind: overrides.kind,
    text: overrides.text,
    decontextualized: overrides.text,
    checkRequired: true,
    evidence: [
      {
        sourceId: overrides.sourceId,
        snapshotHash: overrides.snapshotHash,
        selector: { type: "TextQuoteSelector", exact: overrides.exact },
        relation: "supports",
        anchorStatus: overrides.anchorStatus,
      },
    ],
    supports: [],
    verification: {
      status: overrides.status,
      inputHash: `sha256:${overrides.id}-input`,
      rationale: overrides.rationale,
    },
  };
}

const linearChapterBody = `Linear favours a tight 4px spacing scale and restrained borders over shadows.[^lin-4px]
Notion leans on generous whitespace and a near-monochrome palette to keep content in front.[^notion-whitespace]
The operator believes both are worth studying because they read as quiet and deliberate rather than decorative.[^~belief-quiet]

## Density

Linear's density comes from tight alignment and purposeful use of borders as the primary structural device, rather than shadows.[^lin-borders]
Read together, both are the same instinct: control what borders and space communicate rather than decorating with them.[^=lin-and-notion-restraint]
`;

const linearClaims: Claim[] = [
  claim({
    id: "clm_lin_4px",
    label: "lin-4px",
    kind: "sourced",
    text: "Linear favours a tight 4px spacing scale and restrained borders over shadows.",
    status: "supported",
    sourceId: linearSource.id,
    snapshotHash: "snap_linear_4px",
    exact: "We use a 4px spacing scale throughout and prefer borders to shadows.",
    anchorStatus: "anchored",
  }),
  claim({
    id: "clm_notion_ws",
    label: "notion-whitespace",
    kind: "sourced",
    text: "Notion leans on generous whitespace and a near-monochrome palette to keep content in front.",
    status: "supported",
    sourceId: notionSource.id,
    snapshotHash: "snap_notion_whitespace",
    exact:
      "Generous whitespace and a near-monochrome palette keep the content, not the chrome, in front.",
    anchorStatus: "anchored",
  }),
  claim({
    id: "clm_belief_quiet",
    label: "belief-quiet",
    kind: "operator",
    text: "The operator believes both are worth studying because they read as quiet and deliberate rather than decorative.",
    status: "supported",
    sourceId: operatorSource.id,
    snapshotHash: "snap_operator_quiet",
    exact: "I believe in how Linear and Notion design UI.",
    anchorStatus: "anchored",
  }),
  claim({
    id: "clm_lin_borders",
    label: "lin-borders",
    kind: "sourced",
    text: "Linear's density comes from tight alignment and purposeful use of borders as the primary structural device, rather than shadows.",
    status: "supported",
    sourceId: linearSource.id,
    snapshotHash: "snap_linear_4px",
    exact: "We use a 4px spacing scale throughout and prefer borders to shadows.",
    anchorStatus: "anchored",
  }),
  // A `derived` claim (D19): a synthesis of the two `sourced` claims above,
  // not sourced itself — `evidence` is deliberately empty, `supports`
  // points back at what it follows from. The fixture that exposed clicking
  // one of these doing nothing (`claim.evidence[0]` was `undefined`).
  {
    id: "clm_lin_and_notion_restraint",
    label: "lin-and-notion-restraint",
    kind: "derived",
    text: "Read together, both are the same instinct: control what borders and space communicate rather than decorating with them.",
    decontextualized:
      "Read together, both are the same instinct: control what borders and space communicate rather than decorating with them.",
    checkRequired: true,
    evidence: [],
    supports: ["lin-4px", "notion-whitespace"],
    verification: {
      status: "supported",
      inputHash: "sha256:clm_lin_and_notion_restraint-input",
    },
  },
];

const linearAudit: AuditRecord = {
  chapter: "linear-and-notion-ui",
  auditedAt: now,
  verdict: { chapter: "linear-and-notion-ui", passed: true, outcomes: [] },
};

const epochChapterBody = `Epoch's one-pagers use a single dominant image and one clear point of entry for the eye.[^epoch-entry]
Every one-pager Epoch has ever published uses exactly three colours.[^epoch-three-colours]
The layout grid is derived from classical print proportions.[^epoch-grid]
The editorial voice is measured and deliberate.[^epoch-fuzzy]
`;

const epochClaims: Claim[] = [
  claim({
    id: "clm_epoch_entry",
    label: "epoch-entry",
    kind: "sourced",
    text: "Epoch's one-pagers use a single dominant image and one clear point of entry for the eye.",
    status: "supported",
    sourceId: epochSource.id,
    snapshotHash: "snap_epoch_entry",
    exact: "Every spread opens on a single dominant image, one clear point of entry.",
    anchorStatus: "anchored",
  }),
  claim({
    id: "clm_epoch_colours",
    label: "epoch-three-colours",
    kind: "sourced",
    text: "Every one-pager Epoch has ever published uses exactly three colours.",
    status: "unsupported",
    rationale:
      "The cited snapshot describes the most recent issue's palette, not a universal rule across every issue Epoch has published. The absolute claim overreaches its evidence.",
    sourceId: epochSource.id,
    snapshotHash: "snap_epoch_colour",
    exact: "This issue restrains itself to three colours: ink, paper, and a single accent.",
    anchorStatus: "anchored",
  }),
  claim({
    id: "clm_epoch_grid",
    label: "epoch-grid",
    kind: "sourced",
    text: "The layout grid is derived from classical print proportions.",
    status: "unchecked",
    sourceId: epochSource.id,
    snapshotHash: "snap_epoch_grid_stale",
    exact: "The grid nods to classical print proportions without copying them outright.",
    anchorStatus: "orphaned",
  }),
  // anchored-fuzzy: the selector matched approximately (fuzzy), with refinedBy
  // offsets pointing into the snapshot text at the best-match position.
  {
    id: "clm_epoch_fuzzy",
    label: "epoch-fuzzy",
    kind: "sourced" as const,
    text: "The editorial voice is measured and deliberate.",
    decontextualized: "The editorial voice is measured and deliberate.",
    checkRequired: true,
    evidence: [
      {
        sourceId: epochSource.id,
        snapshotHash: "snap_epoch_fuzzy",
        selector: {
          type: "TextQuoteSelector" as const,
          exact: "The editorial tone is measured, deliberate.",
          refinedBy: { type: "TextPositionSelector" as const, start: 0, end: 42 },
        },
        relation: "supports" as const,
        anchorStatus: "anchored-fuzzy" as const,
      },
    ],
    supports: [],
    verification: { status: "supported" as const, inputHash: "sha256:clm_epoch_fuzzy-input" },
  },
];

const epochAudit: AuditRecord = {
  chapter: "epoch-one-pagers",
  auditedAt: now,
  verdict: {
    chapter: "epoch-one-pagers",
    passed: false,
    outcomes: [
      {
        checkId: "C3",
        tier: 2,
        blocking: true,
        passed: false,
        issues: [
          {
            code: "span-entailment",
            label: "epoch-three-colours",
            message:
              "Cited span describes only the current issue; the claim generalizes to 'every one-pager Epoch has ever published'.",
          },
        ],
      },
    ],
  },
};

function chapterIndexNode(
  chapter: Chapter,
  whenToUse: string | undefined,
): VolumeIndexDocument["volume"]["chapters"][number] {
  return {
    node_id: `node_${chapter.slug}`,
    kind: "chapter",
    title: chapter.title,
    slug: chapter.slug,
    path: ["Design Inspiration", chapter.title],
    file: `volumes/design-inspiration/chapters/${chapter.slug}.md`,
    when_to_use: whenToUse,
    tokens: 120,
    span: { start_byte: 0, end_byte: chapter.body.length },
    content_hash: `sha256:${chapter.slug}`,
    subtree_hash: `sha256:${chapter.slug}-subtree`,
    key_items: ["Density"],
  };
}

export function seedVolume(): SeedVolume {
  const volume: Volume = {
    slug: "design-inspiration",
    title: "Design Inspiration",
    description: "Beliefs about how Linear, Notion, and Epoch design their interfaces.",
    type: "Volume",
    status: "draft",
    staleAfter: null,
    generated: { by: "shadow/1.0", at: now },
    verified: [],
    frontmatter: {},
    createdAt: now,
    updatedAt: now,
  };

  const linearChapter: Chapter = {
    slug: "linear-and-notion-ui",
    title: "How Linear and Notion Design UI",
    body: linearChapterBody,
    type: "Design Guidance",
    status: "stable",
    staleAfter: null,
    generated: { by: "shadow/1.0", at: now },
    verified: [],
    frontmatter: {
      when_to_use: "Designing UI chrome for a tool the operator will use daily.",
    },
    createdAt: now,
    updatedAt: now,
  };

  const epochChapter: Chapter = {
    slug: "epoch-one-pagers",
    title: "How Epoch Magazine Designs One-Pagers",
    body: epochChapterBody,
    type: "Design Guidance",
    status: "stable",
    staleAfter: null,
    generated: { by: "shadow/1.0", at: now },
    verified: [],
    frontmatter: { when_to_use: "Designing a single-page, print-flavoured layout." },
    createdAt: now,
    updatedAt: now,
  };

  const index: VolumeIndexDocument = {
    schema_version: 1,
    generated_at: now,
    corpus_hash: "sha256:corpus-seed",
    volume: {
      volume_id: volume.slug,
      title: volume.title,
      chapter_count: 2,
      volume_hash: "sha256:volume-seed",
      chapters: [
        chapterIndexNode(
          linearChapter,
          "Designing UI chrome for a tool the operator will use daily.",
        ),
        chapterIndexNode(epochChapter, "Designing a single-page, print-flavoured layout."),
      ],
    },
  };

  return {
    volume,
    chapters: [
      {
        chapter: linearChapter,
        claims: {
          schemaVersion: "1.0",
          chapter: linearChapter.slug,
          chapterTextSha256: "sha256:linear-body",
          auditedAt: now,
          claims: linearClaims,
        },
        audit: linearAudit,
      },
      {
        chapter: epochChapter,
        claims: {
          schemaVersion: "1.0",
          chapter: epochChapter.slug,
          chapterTextSha256: "sha256:epoch-body",
          auditedAt: now,
          claims: epochClaims,
        },
        audit: epochAudit,
      },
    ],
    index,
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
      snap_epoch_fuzzy:
        "The editorial tone is measured, deliberate. Epoch favours restraint over ornamentation.",
    },
    ledger: [
      {
        ts: now,
        event: "source.retrieved",
        sourceId: linearSource.id,
        normalizedTextSha256: "sha256:linear-normalized",
      },
      {
        ts: now,
        event: "source.retrieved",
        sourceId: notionSource.id,
        normalizedTextSha256: "sha256:notion-normalized",
      },
      {
        ts: now,
        event: "audit.completed",
        chapter: "linear-and-notion-ui",
        result: "pass",
        completeness: 1,
        narrativeRatio: 0.15,
      },
      {
        ts: now,
        event: "source.retrieved",
        sourceId: epochSource.id,
        normalizedTextSha256: "sha256:epoch-normalized",
      },
      {
        ts: now,
        event: "claim.restated",
        claimId: "clm_epoch_colours",
        chapter: "epoch-one-pagers",
        from: "Epoch magazine always uses exactly three colours in every one-pager they have ever made.",
        to: "Every one-pager Epoch has ever published uses exactly three colours.",
        reason:
          "Original phrasing overstated the source, which describes only the current issue's palette.",
        levenshtein: 42,
        outcome: "applied",
      },
      {
        ts: now,
        event: "source.drifted",
        sourceId: epochSource.id,
        was: "sha256:epoch-before",
        now: "sha256:epoch-after",
        invalidatedClaims: 1,
      },
      {
        ts: now,
        event: "audit.completed",
        chapter: "epoch-one-pagers",
        result: "fail",
        completeness: 0.67,
        narrativeRatio: 0.1,
      },
    ],
  };
}

export function volumeSummaryOf(seed: SeedVolume): VolumeSummary {
  return seed.volume;
}

export function chapterSummariesOf(seed: SeedVolume): ChapterSummary[] {
  return seed.chapters.map((c) => ({
    slug: c.chapter.slug,
    title: c.chapter.title,
    type: c.chapter.type,
    status: c.chapter.status,
    staleAfter: c.chapter.staleAfter,
    generated: c.chapter.generated,
    verified: c.chapter.verified,
    frontmatter: c.chapter.frontmatter,
    updatedAt: c.chapter.updatedAt,
    createdAt: c.chapter.createdAt,
  }));
}

// ---- rule book seed (Rule Book Creator) ------------------------------------
//
// One rule book extracted from a loan agreement,
// narrated to show both states a run leaves behind: a group that fully
// passed its audit, and one with an overreaching rule caught the same way
// `epoch-one-pagers` catches `epoch-three-colours` above — same shape of
// bug, same shape of fix, in a rule-book group instead of a chapter.

const loanSource = source({
  id: "src_rnb_loan",
  url: "file:///rnb_loan.pdf",
  title: "Loan Agreement (rnb_loan.pdf)",
  author: null,
  publishedAt: null,
  transport: "file",
});

const interestFeesBody = `- Borrowers must pay interest at a fixed annual rate of 6.5%.[^int-rate]
- Late payments incur a flat fee of $50 per occurrence.[^late-fee]
`;

const interestFeesClaims: Claim[] = [
  claim({
    id: "clm_int_rate",
    label: "int-rate",
    kind: "sourced",
    text: "Borrowers must pay interest at a fixed annual rate of 6.5%.",
    status: "supported",
    sourceId: loanSource.id,
    snapshotHash: "snap_int_rate",
    exact:
      "the Borrower shall pay interest at a fixed rate of six and one-half percent (6.5%) per annum",
    anchorStatus: "anchored",
  }),
  claim({
    id: "clm_late_fee",
    label: "late-fee",
    kind: "sourced",
    text: "Late payments incur a flat fee of $50 per occurrence.",
    status: "supported",
    sourceId: loanSource.id,
    snapshotHash: "snap_late_fee",
    exact: "a late fee of $50.00 shall be assessed for each late payment",
    anchorStatus: "anchored",
  }),
];

const interestFeesAudit: AuditRecord = {
  chapter: "interest-and-fees",
  auditedAt: now,
  verdict: { chapter: "interest-and-fees", passed: true, outcomes: [] },
};

const defaultRemediesBody = `- The lender may declare a default if any payment is more than 30 days late.[^default-30]
- Every default under this agreement permanently forfeits the borrower's right to refinance.[^default-forfeit]
`;

const defaultRemediesClaims: Claim[] = [
  claim({
    id: "clm_default_30",
    label: "default-30",
    kind: "sourced",
    text: "The lender may declare a default if any payment is more than 30 days late.",
    status: "supported",
    sourceId: loanSource.id,
    snapshotHash: "snap_default_30",
    exact:
      "any payment outstanding for more than thirty (30) days shall constitute an event of default",
    anchorStatus: "anchored",
  }),
  claim({
    id: "clm_default_forfeit",
    label: "default-forfeit",
    kind: "sourced",
    text: "Every default under this agreement permanently forfeits the borrower's right to refinance.",
    status: "unsupported",
    rationale:
      "The cited clause describes the lender's remedy on the single default under discussion, not a universal forfeiture across every default this agreement could ever have. The absolute claim overreaches its evidence.",
    sourceId: loanSource.id,
    snapshotHash: "snap_default_forfeit",
    exact:
      "upon such an event of default, the Lender may suspend the Borrower's refinancing option",
    anchorStatus: "anchored",
  }),
];

const defaultRemediesAudit: AuditRecord = {
  chapter: "default-and-remedies",
  auditedAt: now,
  verdict: {
    chapter: "default-and-remedies",
    passed: false,
    outcomes: [
      {
        checkId: "C3",
        tier: 2,
        blocking: true,
        passed: false,
        issues: [
          {
            code: "span-entailment",
            label: "default-forfeit",
            message:
              "Cited clause describes suspending refinancing on this one event of default; the rule generalizes to permanent forfeiture on every default under the agreement.",
          },
        ],
      },
    ],
  },
};

/** Seeds one rule book — `bun run dev`'s fake client and this package's fixtures both start from this, the same convention `seedVolume()` follows above. */
export function seedRulebook(): SeedRulebook {
  const rulebook: Rulebook = {
    slug: "loan-agreement-rules",
    title: "Loan Agreement Rules",
    description: "Rules extracted from the loan agreement.",
    type: "Rule Book",
    status: "draft",
    generated: { by: "rulebook-extraction@0.1.0", at: now },
    verified: [],
    sourceDoc: {
      url: loanSource.url,
      payloadSha256: "sha256:rnb-loan-payload",
      snapshotSha256: "sha256:rnb-loan-normalized",
    },
    whenToUse: "Answering questions about this loan agreement's terms.",
    keywords: ["loan", "interest-rate", "default"],
    createdAt: now,
    updatedAt: now,
  };

  const interestFeesGroup: Chapter = {
    slug: "interest-and-fees",
    title: "Interest & Fees",
    body: interestFeesBody,
    type: "Rule Group",
    status: "stable",
    staleAfter: null,
    generated: { by: "rulebook-extraction@0.1.0", at: now },
    verified: [],
    frontmatter: {},
    createdAt: now,
    updatedAt: now,
  };

  const defaultRemediesGroup: Chapter = {
    slug: "default-and-remedies",
    title: "Default & Remedies",
    body: defaultRemediesBody,
    type: "Rule Group",
    status: "draft",
    staleAfter: null,
    generated: { by: "rulebook-extraction@0.1.0", at: now },
    verified: [],
    frontmatter: {},
    createdAt: now,
    updatedAt: now,
  };

  return {
    rulebook,
    groups: [
      {
        group: interestFeesGroup,
        claims: {
          schemaVersion: "1.0",
          chapter: interestFeesGroup.slug,
          chapterTextSha256: "sha256:interest-and-fees-body",
          auditedAt: now,
          claims: interestFeesClaims,
        },
        audit: interestFeesAudit,
      },
      {
        group: defaultRemediesGroup,
        claims: {
          schemaVersion: "1.0",
          chapter: defaultRemediesGroup.slug,
          chapterTextSha256: "sha256:default-and-remedies-body",
          auditedAt: now,
          claims: defaultRemediesClaims,
        },
        audit: defaultRemediesAudit,
      },
    ],
    sources: [loanSource],
    snapshots: {
      snap_int_rate:
        "Section 3.1 — the Borrower shall pay interest at a fixed rate of six and one-half percent (6.5%) per annum, calculated on the outstanding principal balance.",
      snap_late_fee:
        "Section 3.4 — a late fee of $50.00 shall be assessed for each late payment, due within five (5) business days of the missed due date.",
      snap_default_30:
        "Section 7.1 — any payment outstanding for more than thirty (30) days shall constitute an event of default under this Agreement.",
      snap_default_forfeit:
        "Section 7.3 — upon such an event of default, the Lender may suspend the Borrower's refinancing option under Section 9 until the default is cured.",
    },
  };
}

/** `ruleCount` mirrors `handlers/rulebooks.ts`'s `countRules` (a regex over `[^label]` footnote markers), duplicated here rather than imported — `@shadow/web` never depends on `@shadow/api`. */
function countRuleMarkers(body: string): number {
  const matches = body.match(/\[\^[^\]\s]+\]/g);
  return matches?.length ?? 0;
}

export function rulebookSummaryOf(seed: SeedRulebook): RulebookSummary {
  return {
    slug: seed.rulebook.slug,
    title: seed.rulebook.title,
    status: seed.rulebook.status,
    groupCount: seed.groups.length,
    updatedAt: seed.rulebook.updatedAt,
  };
}

export function rulebookGroupSummariesOf(seed: SeedRulebook): RulebookGroupSummary[] {
  return seed.groups.map((g) => ({
    slug: g.group.slug,
    title: g.group.title,
    status: g.group.status,
    ruleCount: countRuleMarkers(g.group.body),
  }));
}
