/**
 * `GET /api/volumes/:slug/evidence/{sources/:id,snapshot/:hash,ledger}`
 * (`docs/API.md` §Evidence). Every handler is a direct `EvidenceStore`
 * call — this is what makes a citation *inspectable*: the operator (or
 * `@shadow/web`) can fetch the exact pinned bytes a claim was written
 * from, not just trust that it exists.
 *
 * `GET /api/rulebooks/:slug/{sources/:id,snapshot/:hash}` mirror
 * the volume pair one-for-one, just called against `deps.rulebookEvidenceStore`
 * instead of `deps.evidenceStore` — same response shapes (a bare
 * `SourceRecord`, a `text/plain` body), same 404 behavior (`getSource`/
 * `getSnapshotText` never check that the rule book itself exists, only
 * that the source/snapshot file is there — so an unknown rule book 404s
 * exactly like an unknown source does: `source_not_found`/
 * `snapshot_not_found`, not a rule-book-specific error). No `ledger` route
 * for rule books — there is no rule-book ledger endpoint yet
 * (`handlers/rulebooks.ts`'s module doc), so nothing to mirror there.
 */

import { toVolumeSlug } from "@shadow/core";
import { toDigest, toSourceId } from "@shadow/evidence";
import type { BunRequest } from "bun";
import type { ApiDeps } from "../deps.ts";
import { jsonResponse, textResponse } from "../http.ts";

export async function getSource(
  deps: ApiDeps,
  req: BunRequest<"/api/volumes/:slug/evidence/sources/:id">,
): Promise<Response> {
  const volume = toVolumeSlug(req.params.slug);
  const id = toSourceId(req.params.id);
  const source = await deps.evidenceStore.getSource(volume, id);
  return jsonResponse(source);
}

export async function getSnapshot(
  deps: ApiDeps,
  req: BunRequest<"/api/volumes/:slug/evidence/snapshot/:hash">,
): Promise<Response> {
  const volume = toVolumeSlug(req.params.slug);
  const hash = toDigest(req.params.hash);
  const text = await deps.evidenceStore.getSnapshotText(volume, hash);
  return textResponse(text);
}

export async function getLedger(
  deps: ApiDeps,
  req: BunRequest<"/api/volumes/:slug/evidence/ledger">,
): Promise<Response> {
  const volume = toVolumeSlug(req.params.slug);
  const events = await deps.evidenceStore.readLedger(volume);
  return jsonResponse({ events });
}

export async function getRulebookSource(
  deps: ApiDeps,
  req: BunRequest<"/api/rulebooks/:slug/sources/:id">,
): Promise<Response> {
  const rulebook = toVolumeSlug(req.params.slug);
  const id = toSourceId(req.params.id);
  const source = await deps.rulebookEvidenceStore.getSource(rulebook, id);
  return jsonResponse(source);
}

export async function getRulebookSnapshot(
  deps: ApiDeps,
  req: BunRequest<"/api/rulebooks/:slug/snapshot/:hash">,
): Promise<Response> {
  const rulebook = toVolumeSlug(req.params.slug);
  const hash = toDigest(req.params.hash);
  const text = await deps.rulebookEvidenceStore.getSnapshotText(rulebook, hash);
  return textResponse(text);
}
