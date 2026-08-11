/**
 * Owns the on-disk layout under one volume's evidence directory
 * (`docs/EVIDENCE.md`, "On-disk layout"):
 *
 * ```
 * <evidence-dir>/
 *   manifest.json
 *   sources/<source-id>.json
 *   snapshots/<normalizedTextSha256>.txt
 *   claims/<chapter-slug>.claims.json
 *   audits/<chapter-slug>.audit.json
 *   ledger.ndjson
 * ```
 *
 * `<evidence-dir>` itself is resolved by `@shadow/core`'s
 * `VolumePathResolver.evidenceDir` — this package never builds a path
 * outside it (see `store.ts`'s module doc). Everything *below* that root is
 * this package's own private structure, exactly as `VolumeLayout` in
 * `@shadow/core` owns the structure below the volumes root: the path
 * resolver deliberately stops at the evidence directory boundary and hands
 * the rest to us.
 *
 * `chapter` parameters are typed `ChapterSlug` (from `@shadow/core`) rather
 * than a bare `string`, so every chapter-scoped path here inherits that
 * type's validation instead of this package re-inventing slug safety.
 */

import { join } from "node:path";
import type { ChapterSlug } from "@shadow/core";
import { digestHex, type Sha256Digest } from "./digest.ts";
import type { SourceId } from "./ids.ts";

export class EvidenceLayout {
  constructor(private readonly evidenceDir: string) {}

  manifestPath(): string {
    return join(this.evidenceDir, "manifest.json");
  }

  sourcesDir(): string {
    return join(this.evidenceDir, "sources");
  }

  sourcePath(id: SourceId): string {
    return join(this.sourcesDir(), `${id}.json`);
  }

  snapshotsDir(): string {
    return join(this.evidenceDir, "snapshots");
  }

  snapshotPath(normalizedTextSha256: Sha256Digest): string {
    return join(this.snapshotsDir(), `${digestHex(normalizedTextSha256)}.txt`);
  }

  claimsDir(): string {
    return join(this.evidenceDir, "claims");
  }

  claimsPath(chapter: ChapterSlug): string {
    return join(this.claimsDir(), `${chapter}.claims.json`);
  }

  auditsDir(): string {
    return join(this.evidenceDir, "audits");
  }

  auditPath(chapter: ChapterSlug): string {
    return join(this.auditsDir(), `${chapter}.audit.json`);
  }

  ledgerPath(): string {
    return join(this.evidenceDir, "ledger.ndjson");
  }
}
