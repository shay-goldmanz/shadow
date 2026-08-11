/**
 * `GET /api/volumes/:slug/evidence/{sources/:id,snapshot/:hash,ledger}`
 * (`docs/API.md` §Evidence). Every handler is a direct `EvidenceStore`
 * call — this is what makes a citation *inspectable*: the operator (or
 * `@shadow/web`) can fetch the exact pinned bytes a claim was written
 * from, not just trust that it exists.
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
