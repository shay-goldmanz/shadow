/**
 * `GET /api/rulebooks`, `GET /api/rulebooks/:slug`,
 * `GET /api/rulebooks/:slug/groups/:group` (`docs/API.md` §Rule books).
 * Read-only: rule books are only ever written by `RuleBookPort.create`
 * (driven through the `shadow:rulebook` chat directive, `@shadow/agent`),
 * never through this package. These three handlers exist purely so
 * `@shadow/web` has somewhere to fetch what a run already produced.
 *
 * The group-detail shape deliberately mirrors `handlers/chapters.ts`'s
 * `getChapter`: `{ group, claims?, audit? }`, same optionality, same
 * "`claims` is a whole `ClaimSidecar`, not a bare array" contract — a group
 * is a chapter-shaped document (`RulebookStore`'s module doc) with its own
 * claim sidecar and audit record, keyed by `(rulebookSlug, groupSlug)`
 * exactly like a volume's `(volume, chapter)`. Mirroring the shape means
 * the web pages can reuse the existing chapter rendering/evidence
 * components rather than building a parallel set for rule books.
 */

import { toChapterSlug, toVolumeSlug } from "@shadow/core";
import type { Chapter, Rulebook } from "@shadow/core";
import type { BunRequest } from "bun";
import type { ApiDeps } from "../deps.ts";
import { jsonResponse } from "../http.ts";

/** Rule book counts a group's rules by its footnote markers (`- <statement>[^<label>]`, `assembly.ts`) — cheap (a regex over the already-loaded body) rather than re-parsing the claim sidecar just to count entries. */
function countRules(body: string): number {
  const matches = body.match(/\[\^[^\]\s]+\]/g);
  return matches?.length ?? 0;
}

function toRulebookSummary(rulebook: Rulebook, groupCount: number) {
  return {
    slug: rulebook.slug,
    title: rulebook.title,
    status: rulebook.status,
    groupCount,
    updatedAt: rulebook.updatedAt,
  };
}

function toGroupSummary(group: Chapter) {
  return {
    slug: group.slug,
    title: group.title,
    status: group.status,
    ruleCount: countRules(group.body),
  };
}

export async function listRulebooks(deps: ApiDeps): Promise<Response> {
  const rulebooks = await deps.rulebookStore.listRulebooks();
  const summaries = await Promise.all(
    rulebooks.map(async (rulebook) => {
      const groups = await deps.rulebookStore.listGroups(rulebook.slug);
      return toRulebookSummary(rulebook, groups.length);
    }),
  );
  return jsonResponse({ rulebooks: summaries });
}

export async function getRulebook(
  deps: ApiDeps,
  req: BunRequest<"/api/rulebooks/:slug">,
): Promise<Response> {
  const slug = toVolumeSlug(req.params.slug);
  const [rulebook, groups] = await Promise.all([
    deps.rulebookStore.getRulebook(slug),
    deps.rulebookStore.listGroups(slug),
  ]);
  return jsonResponse({ rulebook, groups: groups.map(toGroupSummary) });
}

export async function getRulebookGroup(
  deps: ApiDeps,
  req: BunRequest<"/api/rulebooks/:slug/groups/:group">,
): Promise<Response> {
  const rulebookSlug = toVolumeSlug(req.params.slug);
  const groupSlug = toChapterSlug(req.params.group);
  const [group, claims, audit] = await Promise.all([
    deps.rulebookStore.getGroup(rulebookSlug, groupSlug),
    deps.rulebookEvidenceStore.getClaims(rulebookSlug, groupSlug),
    deps.rulebookEvidenceStore.getAudit(rulebookSlug, groupSlug),
  ]);
  // `claims`/`audit` are `undefined` when a group has never been published
  // through `publishGroup` — same optionality `getChapter` has, and for the
  // same reason: `JSON.stringify` drops the `undefined`-valued keys.
  return jsonResponse({ group, claims, audit });
}
