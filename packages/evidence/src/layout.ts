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
 *
 * **Every method below that joins an identifier onto a path re-validates
 * that identifier**, even though `ChapterSlug`/`SourceId`/`Sha256Digest` are
 * already branded types. The brand is a compile-time fiction erased at
 * runtime — `"../../../../tmp/pwn" as ChapterSlug` type-checks — and this
 * package's own domain objects (a claim sidecar, a source record) are
 * loaded from JSON on disk with a bare `as` cast (`store.ts`'s "trust
 * boundary" comments), so a corrupted or hand-edited file, or — the case
 * that matters most from Wave 2 onward — an **LLM-authored sidecar**, is a
 * completely realistic way for an unvalidated string to reach here. This is
 * exactly `@shadow/core`'s `VolumeLayout` pattern (see that file's module
 * doc and `filesystem-volume-store.test.ts`'s "security boundary" test):
 * this is the one place in the package that joins an id onto a filesystem
 * path, so this is where forged input must be caught, regardless of how
 * many layers upstream already believed it was validated.
 */

import { join } from "node:path";
import { type ChapterSlug, toChapterSlug } from "@shadow/core";
import { digestHex, type Sha256Digest } from "./digest.ts";
import { type SourceId, toSourceId } from "./ids.ts";

export class EvidenceLayout {
  constructor(private readonly evidenceDir: string) {}

  manifestPath(): string {
    return join(this.evidenceDir, "manifest.json");
  }

  sourcesDir(): string {
    return join(this.evidenceDir, "sources");
  }

  /** @throws {InvalidIdError} if `id` is not a well-formed `src_<ULID>`. */
  sourcePath(id: SourceId): string {
    return join(this.sourcesDir(), `${toSourceId(id)}.json`);
  }

  snapshotsDir(): string {
    return join(this.evidenceDir, "snapshots");
  }

  /** @throws {InvalidDigestError} if `normalizedTextSha256` is not a well-formed `sha256:<hex>` digest (via `digestHex`). */
  snapshotPath(normalizedTextSha256: Sha256Digest): string {
    return join(this.snapshotsDir(), `${digestHex(normalizedTextSha256)}.txt`);
  }

  claimsDir(): string {
    return join(this.evidenceDir, "claims");
  }

  /** @throws {InvalidSlugError} if `chapter` is not a well-formed chapter slug. */
  claimsPath(chapter: ChapterSlug): string {
    return join(this.claimsDir(), `${toChapterSlug(chapter)}.claims.json`);
  }

  auditsDir(): string {
    return join(this.evidenceDir, "audits");
  }

  /** @throws {InvalidSlugError} if `chapter` is not a well-formed chapter slug. */
  auditPath(chapter: ChapterSlug): string {
    return join(this.auditsDir(), `${toChapterSlug(chapter)}.audit.json`);
  }

  ledgerPath(): string {
    return join(this.evidenceDir, "ledger.ndjson");
  }
}
