/**
 * Document ingestion — the *only* file-I/O module in this package (see
 * `no-io.test.ts`'s whitelist). Reads a source document (Markdown/plain
 * text) off disk, and witnesses it into `@shadow/evidence` as the rule
 * book's one file-transport source, so every rule extracted downstream
 * grounds its quotes against a pinned, content-addressed snapshot rather
 * than the caller's own re-reads of the file (D23: sources are witnessed,
 * not minted).
 *
 * Markdown-only by design: any PDF the operator wants turned into a rule
 * book is converted to Markdown by a separate step *outside* this feature
 * before it ever reaches `ingestDocument` — this module never sees PDF
 * bytes.
 */

import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { VolumeSlug } from "@shadow/core";
import type { EvidenceStore, FileWitness, SourceMetadata } from "@shadow/evidence";
import {
  DocumentDecodeError,
  DocumentNotFoundError,
  DocumentTooLargeError,
  DocumentUnsupportedError,
} from "./errors.ts";

/** Ingestion size cap — a prototype-scale limit, not a product one. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

/** The result of ingesting one document: its witnessed source id plus the text and hashes the rest of the pipeline works from. */
export interface IngestedDocument {
  readonly sourceId: string;
  /** The document's text, unnormalized — what `chunkDocument` splits. */
  readonly rawText: string;
  /** `normalizeNfcWs(rawText)` — read back from the evidence store's snapshot, not recomputed here, so this always matches what quote-binding checks against later. */
  readonly normalizedText: string;
  readonly payloadSha256: string;
  readonly snapshotSha256: string;
}

function decodeUtf8OrThrow(path: string, bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new DocumentDecodeError(path, "not valid UTF-8 text", cause);
  }
}

/**
 * Read `docPath` (Markdown or plain text), and witness it into
 * `evidenceStore` as `rulebookSlug`'s source document.
 *
 * @throws {DocumentNotFoundError} `docPath` doesn't resolve to a readable file.
 * @throws {DocumentTooLargeError} the file exceeds {@link MAX_DOCUMENT_BYTES}.
 * @throws {DocumentUnsupportedError} the extension isn't `.md`/`.markdown`/`.txt`.
 * @throws {DocumentDecodeError} the bytes aren't valid UTF-8 text.
 */
export async function ingestDocument(
  evidenceStore: EvidenceStore,
  rulebookSlug: VolumeSlug,
  docPath: string,
  title: string,
): Promise<IngestedDocument> {
  const absolutePath = resolve(docPath);

  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(absolutePath);
  } catch (cause) {
    throw new DocumentNotFoundError(absolutePath, cause);
  }
  if (!fileStat.isFile()) {
    throw new DocumentNotFoundError(absolutePath);
  }
  if (fileStat.size > MAX_DOCUMENT_BYTES) {
    throw new DocumentTooLargeError(absolutePath, fileStat.size, MAX_DOCUMENT_BYTES);
  }

  const extension = extname(absolutePath).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension)) {
    throw new DocumentUnsupportedError(absolutePath, extension);
  }

  const bytes = await Bun.file(absolutePath).bytes();
  const rawText = decodeUtf8OrThrow(absolutePath, bytes);

  const witness: FileWitness = {
    path: absolutePath,
    bytes,
    text: rawText,
    readAt: new Date(),
  };

  const metadata: SourceMetadata = {
    title,
    agent: "rulebook-extractor",
    authority: {
      tier: "primary",
      rationale: "Operator-supplied source document, ingested directly for rule book extraction.",
    },
    volatility: "unknown",
  };

  const record = await evidenceStore.putSourceFromFile(rulebookSlug, witness, metadata);
  const normalizedText = await evidenceStore.getSnapshotText(
    rulebookSlug,
    record.snapshot.normalizedTextSha256,
  );

  return {
    sourceId: record.id,
    rawText,
    normalizedText,
    payloadSha256: record.snapshot.payloadSha256,
    snapshotSha256: record.snapshot.normalizedTextSha256,
  };
}
