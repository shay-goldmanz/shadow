/**
 * Turns a validated `ChapterDirective` (`directives.ts`) into a persisted
 * `Chapter` (via `VolumeStore`) and its `ClaimSidecar` (via `EvidenceStore`)
 * — drafting, not yet publishing. `publish.ts` is the audit gate; this
 * module only ever produces claims whose evidence is already resolved
 * (`evidence-binding.ts`), so a chapter this function persists is always
 * at least *structurally* well-formed before the audit ever runs.
 *
 * Every claim's initial `verification.status` is `"unchecked"` — the one
 * value `@shadow/evidence`'s Tier 2 memoization treats as "never judged,
 * always re-judge" (`checks/entailment-relevance.ts`: memoized requires
 * `status !== "unchecked"`), so a freshly-drafted claim is guaranteed to go
 * through C3/C5 on its very first audit regardless of what its computed
 * `inputHash` happens to collide with.
 */

import type { Chapter, VolumeStore } from "@shadow/core";
import { toChapterSlug, type VolumeSlug } from "@shadow/core";
import {
  type Claim,
  type ClaimSidecar,
  computeInputHash,
  type EvidenceStore,
  newClaimId,
  sha256Of,
} from "@shadow/evidence";
import type { ChapterClaimDirective, ChapterDirective } from "./directives.ts";
import { ClaimMissingRequiredFieldError } from "./errors.ts";
import { buildEvidenceSpan } from "./evidence-binding.ts";

export interface ChapterDraftDeps {
  readonly volumeStore: VolumeStore;
  readonly evidenceStore: EvidenceStore;
}

async function buildClaim(
  deps: ChapterDraftDeps,
  volume: VolumeSlug,
  directive: ChapterClaimDirective,
): Promise<Claim> {
  const decontextualized = directive.decontextualized ?? directive.text;
  const isEvidenceKind = directive.kind === "sourced" || directive.kind === "operator";

  if (isEvidenceKind && (!directive.evidence || directive.evidence.length === 0)) {
    throw new ClaimMissingRequiredFieldError(directive.label, directive.kind, "evidence");
  }
  if (directive.kind === "derived" && (!directive.supports || directive.supports.length === 0)) {
    throw new ClaimMissingRequiredFieldError(directive.label, directive.kind, "supports");
  }

  const evidence = isEvidenceKind
    ? await Promise.all(
        (directive.evidence ?? []).map((ref) =>
          buildEvidenceSpan(deps.evidenceStore, volume, directive.label, ref),
        ),
      )
    : [];
  const supports = directive.kind === "derived" ? [...(directive.supports ?? [])] : [];

  const inputHash = computeInputHash({
    decontextualized,
    evidence: evidence.map((span) => ({
      exact: span.selector.exact,
      snapshotHash: span.snapshotHash,
    })),
    supports,
  });

  return {
    id: newClaimId(),
    label: directive.label,
    kind: directive.kind,
    text: directive.text,
    decontextualized,
    // Tier 0 sets this `true` for every marked claim (`docs/EVIDENCE.md`) —
    // marking is itself the writer's assertion that a chain is required.
    checkRequired: true,
    evidence,
    supports,
    verification: { status: "unchecked", inputHash },
  };
}

/** Build the chapter frontmatter object (`when_to_use`/`not_for`/`keywords`/`confidence`) from a directive, omitting fields the directive did not set. */
function buildFrontmatter(directive: ChapterDirective): Record<string, unknown> {
  const fm = directive.frontmatter;
  const frontmatter: Record<string, unknown> = {};
  if (fm?.when_to_use !== undefined) frontmatter.when_to_use = fm.when_to_use;
  if (fm?.not_for !== undefined) frontmatter.not_for = fm.not_for;
  if (fm?.keywords !== undefined) frontmatter.keywords = [...fm.keywords];
  if (fm?.confidence !== undefined) frontmatter.confidence = fm.confidence;
  return frontmatter;
}

/** Derive an OKF `type` from a chapter directive. Defaults to `"Design Guidance"`. */
function chapterType(directive: ChapterDirective): string {
  return directive.okf?.type ?? "Design Guidance";
}

/** Derive an OKF `status` from a chapter directive. Defaults to `"draft"`. */
function chapterStatus(directive: ChapterDirective): "draft" | "stable" | "deprecated" {
  return directive.okf?.status ?? "draft";
}

export interface ChapterDraft {
  readonly chapter: Chapter;
  readonly sidecar: ClaimSidecar;
}

/**
 * Bind every claim's evidence, then persist the chapter and its sidecar.
 * Evidence is resolved (`buildEvidenceSpan`) *before* either write, so a
 * quote that does not actually resolve throws before anything reaches
 * disk — no half-written chapter with a claim that can never be audited.
 */
export async function draftChapter(
  deps: ChapterDraftDeps,
  volume: VolumeSlug,
  directive: ChapterDirective,
): Promise<ChapterDraft> {
  const slug = toChapterSlug(directive.slug);

  const claims = await Promise.all(
    directive.claims.map((claimDirective) => buildClaim(deps, volume, claimDirective)),
  );

  const chapter = await deps.volumeStore.putChapter(volume, {
    slug,
    title: directive.title,
    body: directive.body,
    type: chapterType(directive),
    status: chapterStatus(directive),
    generated: { by: "shadow/1.0", at: new Date() },
    verified: [],
    frontmatter: buildFrontmatter(directive),
  });

  const sidecar: ClaimSidecar = {
    schemaVersion: "1.0",
    chapter: slug,
    chapterTextSha256: sha256Of(chapter.body),
    claims,
  };
  await deps.evidenceStore.putClaims(volume, sidecar);

  return { chapter, sidecar };
}
