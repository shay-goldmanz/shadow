import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemRulebookStore, toVolumeSlug } from "@shadow/core";
import { expectRejection } from "@shadow/core/test-helpers";
import { FileSystemEvidenceStore, normalizeNfcWs, toSourceId } from "@shadow/evidence";
import {
  DocumentNotFoundError,
  DocumentTooLargeError,
  DocumentUnsupportedError,
} from "./errors.ts";
import { ingestDocument, MAX_DOCUMENT_BYTES } from "./ingest.ts";

async function makeTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "shadow-rulebook-ingest-test-"));
}

async function makeStores(root: string) {
  const rulebookStore = new FileSystemRulebookStore(root);
  const slug = toVolumeSlug("ingest-test");
  await rulebookStore.createRulebook({ slug, title: "Ingest Test" });
  const evidenceStore = new FileSystemEvidenceStore(rulebookStore);
  return { evidenceStore, slug };
}

describe("ingestDocument", () => {
  test("round-trips a Markdown document through the evidence store", async () => {
    const root = await makeTempRoot();
    try {
      const { evidenceStore, slug } = await makeStores(root);
      const docPath = join(root, "policy.md");
      const rawText = "# Policy\n\nBorrowers   must    repay on time.";
      await writeFile(docPath, rawText, "utf8");

      const ingested = await ingestDocument(evidenceStore, slug, docPath, "Policy Doc");

      expect(ingested.rawText).toBe(rawText);
      expect(ingested.normalizedText).toBe(normalizeNfcWs(rawText));

      const source = await evidenceStore.getSource(slug, toSourceId(ingested.sourceId));
      expect(source.retrieval.transport).toBe("file");
      expect(source.retrieval.agent).toBe("rulebook-extractor");
      expect(source.authority.tier).toBe("primary");
      expect(source.url).toBe(`file://${docPath}`);

      const snapshotText = await evidenceStore.getSnapshotText(
        slug,
        source.snapshot.normalizedTextSha256,
      );
      expect(snapshotText).toBe(ingested.normalizedText);
      expect(ingested.payloadSha256).toBe(source.snapshot.payloadSha256);
      expect(ingested.snapshotSha256).toBe(source.snapshot.normalizedTextSha256);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a document over the size cap", async () => {
    const root = await makeTempRoot();
    try {
      const { evidenceStore, slug } = await makeStores(root);
      const docPath = join(root, "huge.txt");
      // Sparse file — no need to actually allocate MAX_DOCUMENT_BYTES + 1 bytes.
      await writeFile(docPath, "");
      await truncate(docPath, MAX_DOCUMENT_BYTES + 1);

      await expectRejection(
        ingestDocument(evidenceStore, slug, docPath, "Huge Doc"),
        DocumentTooLargeError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects an unsupported extension", async () => {
    const root = await makeTempRoot();
    try {
      const { evidenceStore, slug } = await makeStores(root);
      const docPath = join(root, "policy.docx");
      await writeFile(docPath, "not actually a docx", "utf8");

      await expectRejection(
        ingestDocument(evidenceStore, slug, docPath, "Policy Doc"),
        DocumentUnsupportedError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a .pdf path — ingestion is Markdown/plain-text only, PDF conversion happens outside this feature", async () => {
    const root = await makeTempRoot();
    try {
      const { evidenceStore, slug } = await makeStores(root);
      const docPath = join(root, "policy.pdf");
      await writeFile(docPath, "%PDF-1.4 not real pdf bytes");

      await expectRejection(
        ingestDocument(evidenceStore, slug, docPath, "Policy Doc"),
        DocumentUnsupportedError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a missing file", async () => {
    const root = await makeTempRoot();
    try {
      const { evidenceStore, slug } = await makeStores(root);
      const docPath = join(root, "does-not-exist.md");

      await expectRejection(
        ingestDocument(evidenceStore, slug, docPath, "Missing Doc"),
        DocumentNotFoundError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
