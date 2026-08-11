/**
 * The evidence store: sources, content-addressed snapshots, per-chapter
 * claim sidecars, per-chapter audit records, the manifest, and the
 * append-only NDJSON ledger — everything under
 * `docs/EVIDENCE.md`'s "On-disk layout".
 *
 * Depends on `@shadow/core`'s `VolumePathResolver` — **not** the full
 * `VolumeStore` — and calls only `evidenceDir`/`ensureEvidenceDir` on it.
 * That is the whole point of that narrower port (see its doc in
 * `@shadow/core`): this package cannot reach sideways into
 * `chapters/`/`volume.json`/`index.json` even by accident, because nothing
 * it depends on exposes a way to build those paths. Every path below the
 * evidence root is built exclusively through `EvidenceLayout`
 * (`layout.ts`) — never by joining strings inline here.
 */

import type { ChapterSlug, VolumePathResolver, VolumeSlug } from "@shadow/core";
import type { AuditRecord } from "./checks/audit.ts";
import type { EvidenceLookup } from "./checks/source-integrity.ts";
import { type Sha256Digest, sha256Of } from "./digest.ts";
import { LedgerCorruptError, SnapshotNotFoundError, SourceNotFoundError } from "./errors.ts";
import { type SourceId, toSourceId } from "./ids.ts";
import { EvidenceLayout } from "./layout.ts";
import type { ClaimSidecar, EvidenceManifest, LedgerEvent, SourceRecord } from "./types.ts";

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** Build a synchronous, in-memory `EvidenceLookup` (`checks/source-integrity.ts`) over already-loaded records — the bridge between this store's necessarily-async I/O and the Tier 0 checks' deliberately-sync, pure interface. */
export function buildEvidenceLookup(
  sources: readonly SourceRecord[],
  snapshots: ReadonlyMap<Sha256Digest, string>,
): EvidenceLookup {
  const byId = new Map(sources.map((s) => [s.id, s] as const));
  return {
    getSource: (id: SourceId) => byId.get(id),
    getSnapshotText: (hash: Sha256Digest) => snapshots.get(hash),
  };
}

export interface EvidenceStore {
  // ---- sources ------------------------------------------------------------

  putSource(volume: VolumeSlug, source: SourceRecord): Promise<void>;

  /** @throws {SourceNotFoundError} */
  getSource(volume: VolumeSlug, id: SourceId): Promise<SourceRecord>;

  /** Sources sorted by id. Empty array if none exist yet. */
  listSources(volume: VolumeSlug): Promise<SourceRecord[]>;

  // ---- snapshots (content-addressed) ---------------------------------------

  /** Idempotent: writing the same normalized text twice is a no-op the second time (same digest, same filename). Returns the digest. */
  putSnapshot(volume: VolumeSlug, normalizedText: string): Promise<Sha256Digest>;

  /** @throws {SnapshotNotFoundError} */
  getSnapshotText(volume: VolumeSlug, normalizedTextSha256: Sha256Digest): Promise<string>;

  hasSnapshot(volume: VolumeSlug, normalizedTextSha256: Sha256Digest): Promise<boolean>;

  // ---- claim sidecars -------------------------------------------------------

  /** `undefined` if this chapter has never been audited. */
  getClaims(volume: VolumeSlug, chapter: ChapterSlug): Promise<ClaimSidecar | undefined>;

  /**
   * Overwrite a chapter's claim sidecar. If a previous sidecar existed and
   * some label present there is absent from `sidecar.claims`, that label is
   * retired: appended to the ledger as `claim.label.retired` so
   * `getRetiredLabels` (and therefore C1a's never-reused rule) can see it
   * in every future audit of this chapter, even though the sidecar itself
   * only holds current state.
   */
  putClaims(volume: VolumeSlug, sidecar: ClaimSidecar): Promise<void>;

  /** Every label this chapter has used and since removed from its sidecar — see `putClaims`. Empty set if the chapter has no history yet. */
  getRetiredLabels(volume: VolumeSlug, chapter: ChapterSlug): Promise<ReadonlySet<string>>;

  // ---- audits -----------------------------------------------------------

  getAudit(volume: VolumeSlug, chapter: ChapterSlug): Promise<AuditRecord | undefined>;

  putAudit(volume: VolumeSlug, chapter: ChapterSlug, record: AuditRecord): Promise<void>;

  // ---- manifest ---------------------------------------------------------

  getManifest(volume: VolumeSlug): Promise<EvidenceManifest | undefined>;

  putManifest(volume: VolumeSlug, manifest: EvidenceManifest): Promise<void>;

  // ---- ledger (append-only NDJSON) ---------------------------------------

  appendLedgerEvent(volume: VolumeSlug, event: LedgerEvent): Promise<void>;

  /** The full ledger, in append order. Empty array if nothing has been appended yet. @throws {LedgerCorruptError} */
  readLedger(volume: VolumeSlug): Promise<LedgerEvent[]>;

  // ---- convenience: batch-load a sync lookup for the Tier 0 checks --------

  /**
   * Load exactly the sources and snapshots referenced by `sidecar`'s
   * claims, and build a synchronous `EvidenceLookup` over them
   * (`buildEvidenceLookup`). Missing sources/snapshots are simply absent
   * from the lookup (not thrown) — C2 is precisely the check that reports
   * that absence as a finding, so this must not fail fast.
   */
  loadLookupFor(volume: VolumeSlug, sidecar: ClaimSidecar): Promise<EvidenceLookup>;
}

/** Filesystem implementation of `EvidenceStore`, built on `@shadow/core`'s `VolumePathResolver`. */
export class FileSystemEvidenceStore implements EvidenceStore {
  constructor(private readonly resolver: VolumePathResolver) {}

  // ---- sources ------------------------------------------------------------

  async putSource(volume: VolumeSlug, source: SourceRecord): Promise<void> {
    const layout = await this.layoutFor(volume);
    await Bun.write(layout.sourcePath(source.id), `${JSON.stringify(source, null, 2)}\n`);
  }

  async getSource(volume: VolumeSlug, id: SourceId): Promise<SourceRecord> {
    const layout = this.layout(volume);
    const file = Bun.file(layout.sourcePath(id));
    if (!(await file.exists())) {
      throw new SourceNotFoundError(id);
    }
    // Trust boundary: written only by putSource above.
    return (await file.json()) as SourceRecord;
  }

  async listSources(volume: VolumeSlug): Promise<SourceRecord[]> {
    const layout = this.layout(volume);
    const entries = await this.readdirOrEmpty(layout.sourcesDir());
    const sources: SourceRecord[] = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const candidate = name.slice(0, -".json".length);
      try {
        sources.push(await this.getSource(volume, toSourceId(candidate)));
      } catch {
        // Not a validly-named source file (or vanished mid-listing); skip
        // rather than fail the whole listing, matching FileSystemVolumeStore's
        // listVolumes behavior for the analogous case.
      }
    }
    sources.sort((a, b) => a.id.localeCompare(b.id));
    return sources;
  }

  // ---- snapshots ------------------------------------------------------------

  async putSnapshot(volume: VolumeSlug, normalizedText: string): Promise<Sha256Digest> {
    const layout = await this.layoutFor(volume);
    const hash = sha256Of(normalizedText);
    const path = layout.snapshotPath(hash);
    // Content-addressed: if it's already there, the content is by
    // definition identical (same hash), so writing again is a no-op.
    if (!(await Bun.file(path).exists())) {
      await Bun.write(path, normalizedText);
    }
    return hash;
  }

  async getSnapshotText(volume: VolumeSlug, normalizedTextSha256: Sha256Digest): Promise<string> {
    const layout = this.layout(volume);
    const file = Bun.file(layout.snapshotPath(normalizedTextSha256));
    if (!(await file.exists())) {
      throw new SnapshotNotFoundError(normalizedTextSha256);
    }
    return file.text();
  }

  async hasSnapshot(volume: VolumeSlug, normalizedTextSha256: Sha256Digest): Promise<boolean> {
    const layout = this.layout(volume);
    return Bun.file(layout.snapshotPath(normalizedTextSha256)).exists();
  }

  // ---- claim sidecars -------------------------------------------------------

  async getClaims(volume: VolumeSlug, chapter: ChapterSlug): Promise<ClaimSidecar | undefined> {
    const layout = this.layout(volume);
    const file = Bun.file(layout.claimsPath(chapter));
    if (!(await file.exists())) return undefined;
    return (await file.json()) as ClaimSidecar;
  }

  async putClaims(volume: VolumeSlug, sidecar: ClaimSidecar): Promise<void> {
    const chapter = sidecar.chapter as ChapterSlug;
    const previous = await this.getClaims(volume, chapter);
    if (previous) {
      const currentLabels = new Set(sidecar.claims.map((c) => c.label));
      for (const claim of previous.claims) {
        if (!currentLabels.has(claim.label)) {
          await this.appendLedgerEvent(volume, {
            ts: new Date().toISOString(),
            event: "claim.label.retired",
            chapter: sidecar.chapter,
            label: claim.label,
            claimId: claim.id,
          });
        }
      }
    }

    const layout = await this.layoutFor(volume);
    await Bun.write(layout.claimsPath(chapter), `${JSON.stringify(sidecar, null, 2)}\n`);
  }

  async getRetiredLabels(volume: VolumeSlug, chapter: ChapterSlug): Promise<ReadonlySet<string>> {
    const ledger = await this.readLedger(volume);
    const retired = new Set<string>();
    for (const event of ledger) {
      if (event.event === "claim.label.retired" && event.chapter === chapter) {
        retired.add(event.label);
      }
    }
    return retired;
  }

  // ---- audits -----------------------------------------------------------

  async getAudit(volume: VolumeSlug, chapter: ChapterSlug): Promise<AuditRecord | undefined> {
    const layout = this.layout(volume);
    const file = Bun.file(layout.auditPath(chapter));
    if (!(await file.exists())) return undefined;
    return (await file.json()) as AuditRecord;
  }

  async putAudit(volume: VolumeSlug, chapter: ChapterSlug, record: AuditRecord): Promise<void> {
    const layout = await this.layoutFor(volume);
    await Bun.write(layout.auditPath(chapter), `${JSON.stringify(record, null, 2)}\n`);
  }

  // ---- manifest ---------------------------------------------------------

  async getManifest(volume: VolumeSlug): Promise<EvidenceManifest | undefined> {
    const layout = this.layout(volume);
    const file = Bun.file(layout.manifestPath());
    if (!(await file.exists())) return undefined;
    return (await file.json()) as EvidenceManifest;
  }

  async putManifest(volume: VolumeSlug, manifest: EvidenceManifest): Promise<void> {
    const layout = await this.layoutFor(volume);
    await Bun.write(layout.manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  // ---- ledger -------------------------------------------------------------

  async appendLedgerEvent(volume: VolumeSlug, event: LedgerEvent): Promise<void> {
    const layout = await this.layoutFor(volume);
    const path = layout.ledgerPath();
    const line = `${JSON.stringify(event)}\n`;
    const existing = Bun.file(path);
    if (await existing.exists()) {
      // Bun.write always overwrites; append via the underlying Node fs API.
      const { appendFile } = await import("node:fs/promises");
      await appendFile(path, line, "utf8");
    } else {
      await Bun.write(path, line);
    }
  }

  async readLedger(volume: VolumeSlug): Promise<LedgerEvent[]> {
    const layout = this.layout(volume);
    const file = Bun.file(layout.ledgerPath());
    if (!(await file.exists())) return [];
    const text = await file.text();
    const events: LedgerEvent[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as LedgerEvent);
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new LedgerCorruptError(i + 1, reason);
      }
    }
    return events;
  }

  // ---- lookup convenience --------------------------------------------------

  async loadLookupFor(volume: VolumeSlug, sidecar: ClaimSidecar): Promise<EvidenceLookup> {
    const sourceIds = new Set<SourceId>();
    const snapshotHashes = new Set<Sha256Digest>();
    for (const claim of sidecar.claims) {
      for (const span of claim.evidence) {
        sourceIds.add(span.sourceId);
        snapshotHashes.add(span.snapshotHash);
      }
    }

    const sources: SourceRecord[] = [];
    for (const id of sourceIds) {
      try {
        sources.push(await this.getSource(volume, id));
      } catch (error) {
        if (!(error instanceof SourceNotFoundError)) throw error;
      }
    }

    const snapshots = new Map<Sha256Digest, string>();
    for (const hash of snapshotHashes) {
      try {
        snapshots.set(hash, await this.getSnapshotText(volume, hash));
      } catch (error) {
        if (!(error instanceof SnapshotNotFoundError)) throw error;
      }
    }

    return buildEvidenceLookup(sources, snapshots);
  }

  // ---- internals ----------------------------------------------------------

  private layout(volume: VolumeSlug): EvidenceLayout {
    return new EvidenceLayout(this.resolver.evidenceDir(volume));
  }

  /** Like `layout`, but ensures the evidence directory (and its subdirectories) exist first — for write paths. */
  private async layoutFor(volume: VolumeSlug): Promise<EvidenceLayout> {
    const dir = await this.resolver.ensureEvidenceDir(volume);
    const layout = new EvidenceLayout(dir);
    const { mkdir } = await import("node:fs/promises");
    await Promise.all([
      mkdir(layout.sourcesDir(), { recursive: true }),
      mkdir(layout.snapshotsDir(), { recursive: true }),
      mkdir(layout.claimsDir(), { recursive: true }),
      mkdir(layout.auditsDir(), { recursive: true }),
    ]);
    return layout;
  }

  private async readdirOrEmpty(dir: string): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    try {
      return await readdir(dir);
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") return [];
      throw error;
    }
  }
}
