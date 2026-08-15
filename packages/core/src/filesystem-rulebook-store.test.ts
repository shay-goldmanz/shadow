import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemEvidenceStore } from "@shadow/evidence";
import { makeFileWitness, makeSourceMetadata } from "@shadow/evidence/test-helpers";
import {
  GroupNotFoundError,
  InvalidSlugError,
  RulebookAlreadyExistsError,
  RulebookNotFoundError,
} from "./errors.ts";
import { FileSystemRulebookStore } from "./filesystem-rulebook-store.ts";
import { toChapterSlug, toVolumeSlug } from "./slug.ts";
import { expectRejection } from "./test-helpers.ts";

async function makeTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "shadow-core-rulebook-test-"));
}

describe("FileSystemRulebookStore", () => {
  test("createRulebook/getRulebook/listRulebooks round-trip, including source_doc", async () => {
    const root = await makeTempRoot();
    try {
      const store = new FileSystemRulebookStore(root);
      const slug = toVolumeSlug("loan-agreement");

      const created = await store.createRulebook({
        slug,
        title: "Loan Agreement Rules",
        sourceDoc: {
          url: "file:///tmp/rnb_loan.pdf",
          payloadSha256: "sha256:aaaa",
          snapshotSha256: "sha256:bbbb",
        },
        whenToUse: "Answering questions about this loan agreement's terms.",
        keywords: ["loan", "interest-rate"],
      });

      expect(created.type).toBe("Rule Book");
      expect(created.status).toBe("draft");
      expect(created.sourceDoc).toEqual({
        url: "file:///tmp/rnb_loan.pdf",
        payloadSha256: "sha256:aaaa",
        snapshotSha256: "sha256:bbbb",
      });
      expect(created.whenToUse).toBe("Answering questions about this loan agreement's terms.");
      expect(created.keywords).toEqual(["loan", "interest-rate"]);

      const fetched = await store.getRulebook(slug);
      expect(fetched).toEqual(created);

      const listed = await store.listRulebooks();
      expect(listed).toEqual([created]);

      await expectRejection(store.getRulebook(toVolumeSlug("nope")), RulebookNotFoundError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("createRulebook throws on an existing slug", async () => {
    const root = await makeTempRoot();
    try {
      const store = new FileSystemRulebookStore(root);
      const slug = toVolumeSlug("dup");
      await store.createRulebook({ slug, title: "First" });
      await expectRejection(
        store.createRulebook({ slug, title: "Second" }),
        RulebookAlreadyExistsError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("updateRulebook upserts and preserves omitted OKF fields on an existing rule book", async () => {
    const root = await makeTempRoot();
    try {
      const store = new FileSystemRulebookStore(root);
      const slug = toVolumeSlug("preserve-check");

      // updateRulebook on a slug with nothing on disk yet: behaves like create.
      const created = await store.updateRulebook({
        slug,
        title: "Preserve Check",
        status: "stable",
        generated: { by: "extractor@0.1.0", at: new Date("2026-01-01T00:00:00.000Z") },
        verified: [{ by: "shay", at: new Date("2026-01-02T00:00:00.000Z") }],
        keywords: ["a", "b"],
      });
      expect(created.status).toBe("stable");

      // Re-upsert with only slug + title supplied: every omitted field must
      // survive, not reset to hardcoded defaults (the clobber bug this store
      // deliberately does not replicate).
      const updated = await store.updateRulebook({ slug, title: "Preserve Check" });
      expect(updated.status).toBe("stable");
      expect(updated.generated).toEqual(created.generated);
      expect(updated.verified).toEqual(created.verified);
      expect(updated.keywords).toEqual(["a", "b"]);
      expect(updated.createdAt).toEqual(created.createdAt);
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("putGroup/getGroup round-trip and preserve OKF fields on upsert", async () => {
    const root = await makeTempRoot();
    try {
      const store = new FileSystemRulebookStore(root);
      const rulebook = toVolumeSlug("rules");
      await store.createRulebook({ slug: rulebook, title: "Rules" });

      const group = toChapterSlug("fees");
      const created = await store.putGroup(rulebook, {
        slug: group,
        title: "Fees",
        body: "Late fees apply after 15 days.",
        status: "stable",
        generated: { by: "extractor@0.1.0", at: new Date("2026-01-01T00:00:00.000Z") },
        verified: [{ by: "shay", at: new Date("2026-01-02T00:00:00.000Z") }],
      });
      expect(created.status).toBe("stable");

      const fetched = await store.getGroup(rulebook, group);
      expect(fetched).toEqual(created);

      const listed = await store.listGroups(rulebook);
      expect(listed).toEqual([created]);

      // Re-put with only slug/title/body: omitted fields must be preserved,
      // not reset to putChapter's hardcoded defaults.
      const rewritten = await store.putGroup(rulebook, {
        slug: group,
        title: "Fees",
        body: "Late fees apply after 15 days, updated.",
      });
      expect(rewritten.status).toBe("stable");
      expect(rewritten.generated).toEqual(created.generated);
      expect(rewritten.verified).toEqual(created.verified);
      expect(rewritten.createdAt).toEqual(created.createdAt);
      expect(rewritten.body).toBe("Late fees apply after 15 days, updated.");

      await expectRejection(
        store.getGroup(rulebook, toChapterSlug("nonexistent")),
        GroupNotFoundError,
      );
      await expectRejection(
        store.putGroup(toVolumeSlug("no-such-rulebook"), { slug: group, title: "x", body: "y" }),
        RulebookNotFoundError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("extraction cache round-trips opaque JSON and rejects a path-escaping key", async () => {
    const root = await makeTempRoot();
    try {
      const store = new FileSystemRulebookStore(root);
      const rulebook = toVolumeSlug("cache-check");
      await store.createRulebook({ slug: rulebook, title: "Cache Check" });

      expect(await store.readExtractionCache(rulebook, "taxonomy")).toBeNull();

      const value = { chunks: 12, taxonomy: ["fees", "rates"] };
      await store.writeExtractionCache(rulebook, "taxonomy", value);
      expect(await store.readExtractionCache<typeof value>(rulebook, "taxonomy")).toEqual(value);

      await expectRejection(
        store.writeExtractionCache(rulebook, "../../escape", { evil: true }),
        InvalidSlugError,
      );
      await expectRejection(store.readExtractionCache(rulebook, "not/a/key"), InvalidSlugError);

      await expectRejection(
        store.readExtractionCache(toVolumeSlug("no-such-rulebook"), "taxonomy"),
        RulebookNotFoundError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("@shadow/evidence composes over FileSystemRulebookStore via VolumePathResolver unchanged", async () => {
    const root = await makeTempRoot();
    try {
      const rulebookStore = new FileSystemRulebookStore(root);
      const rulebook = toVolumeSlug("evidence-composition");
      await rulebookStore.createRulebook({ slug: rulebook, title: "Evidence Composition" });

      const evidenceStore = new FileSystemEvidenceStore(rulebookStore);
      const source = await evidenceStore.putSourceFromFile(
        rulebook,
        makeFileWitness({ path: "/tmp/fixture-rulebook.md" }),
        makeSourceMetadata({ agent: "@shadow/rulebook/ingest" }),
      );
      expect(source.retrieval.transport).toBe("file");

      const roundTripped = await evidenceStore.getSource(rulebook, source.id);
      expect(roundTripped).toEqual(source);
      expect(
        await evidenceStore.getSnapshotText(rulebook, source.snapshot.normalizedTextSha256),
      ).toBe("Every measurement in the sidebar is a multiple of four.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
