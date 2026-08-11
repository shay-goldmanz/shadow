/**
 * Implementation-agnostic `VolumeStore` test suite.
 *
 * Not a `*.test.ts` file itself — `bun test` won't pick it up on its own.
 * A concrete test file (e.g. `filesystem-volume-store.test.ts`) imports
 * `runVolumeStoreContractTests` and calls it with a harness factory. A
 * future `VolumeStore` implementation (per D4, e.g. a derived SQLite cache)
 * can reuse this suite verbatim by supplying its own harness.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ChapterNotFoundError, VolumeAlreadyExistsError, VolumeNotFoundError } from "./errors.ts";
import { toChapterSlug, toVolumeSlug } from "./slug.ts";
import { expectRejection } from "./test-helpers.ts";
import type { VolumeStore } from "./volume-store.ts";

export interface VolumeStoreHarness {
  store: VolumeStore;
  cleanup(): Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function runVolumeStoreContractTests(
  implementationName: string,
  makeHarness: () => Promise<VolumeStoreHarness>,
): void {
  describe(`VolumeStore contract (${implementationName})`, () => {
    let harness: VolumeStoreHarness;

    beforeEach(async () => {
      harness = await makeHarness();
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    describe("volumes", () => {
      test("create/get round-trip", async () => {
        const { store } = harness;
        const slug = toVolumeSlug("linear-ui");
        const created = await store.createVolume({
          slug,
          title: "Linear UI",
          description: "How Linear designs UI",
        });
        expect(created.slug).toBe(slug);
        expect(created.title).toBe("Linear UI");
        expect(created.description).toBe("How Linear designs UI");
        expect(created.createdAt).toBeInstanceOf(Date);
        expect(created.updatedAt.getTime()).toBe(created.createdAt.getTime());

        expect(await store.getVolume(slug)).toEqual(created);
      });

      test("description defaults to empty string when omitted", async () => {
        const { store } = harness;
        const created = await store.createVolume({
          slug: toVolumeSlug("no-description"),
          title: "No Description",
        });
        expect(created.description).toBe("");
      });

      test("createVolume rejects a duplicate slug", async () => {
        const { store } = harness;
        const slug = toVolumeSlug("dup");
        await store.createVolume({ slug, title: "First" });
        await expectRejection(
          store.createVolume({ slug, title: "Second" }),
          VolumeAlreadyExistsError,
        );
      });

      test("getVolume rejects a missing slug", async () => {
        const { store } = harness;
        await expectRejection(store.getVolume(toVolumeSlug("missing")), VolumeNotFoundError);
      });

      test("listVolumes returns [] when empty, and sorted by slug otherwise", async () => {
        const { store } = harness;
        expect(await store.listVolumes()).toEqual([]);

        await store.createVolume({ slug: toVolumeSlug("zeta"), title: "Zeta" });
        await store.createVolume({ slug: toVolumeSlug("alpha"), title: "Alpha" });

        const listed = await store.listVolumes();
        expect(listed.map((v) => String(v.slug))).toEqual(["alpha", "zeta"]);
      });

      test("updateVolume patches only given fields and advances updatedAt", async () => {
        const { store } = harness;
        const slug = toVolumeSlug("updatable");
        const created = await store.createVolume({
          slug,
          title: "Before",
          description: "Before desc",
        });
        await delay(2);

        const updated = await store.updateVolume(slug, { title: "After" });
        expect(updated.title).toBe("After");
        expect(updated.description).toBe("Before desc");
        expect(updated.createdAt.getTime()).toBe(created.createdAt.getTime());
        expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
      });

      test("updateVolume rejects a missing slug", async () => {
        const { store } = harness;
        await expectRejection(
          store.updateVolume(toVolumeSlug("missing"), { title: "x" }),
          VolumeNotFoundError,
        );
      });

      test("deleteVolume removes the volume and its chapters", async () => {
        const { store } = harness;
        const slug = toVolumeSlug("deletable");
        await store.createVolume({ slug, title: "Deletable" });
        await store.putChapter(slug, { slug: toChapterSlug("c1"), title: "C1", body: "body" });

        await store.deleteVolume(slug);

        await expectRejection(store.getVolume(slug), VolumeNotFoundError);
      });

      test("deleteVolume rejects a missing slug", async () => {
        const { store } = harness;
        await expectRejection(store.deleteVolume(toVolumeSlug("missing")), VolumeNotFoundError);
      });
    });

    describe("chapters", () => {
      test("putChapter requires an existing volume", async () => {
        const { store } = harness;
        await expectRejection(
          store.putChapter(toVolumeSlug("missing"), {
            slug: toChapterSlug("c1"),
            title: "C1",
            body: "body",
          }),
          VolumeNotFoundError,
        );
      });

      test("put/get round-trip preserves title, body, and frontmatter exactly", async () => {
        const { store } = harness;
        const volume = toVolumeSlug("vol");
        await store.createVolume({ slug: volume, title: "Vol" });

        const body =
          '# Heading\n\nMulti-line body with *markdown*, unicode: 日本語 🎉, and a quote: "hi".\n';
        const chapter = await store.putChapter(volume, {
          slug: toChapterSlug("chapter-one"),
          title: "Chapter One",
          body,
          frontmatter: { when_to_use: ["a", "b"], nested: { n: 1, list: [1, 2, 3] } },
        });

        const fetched = await store.getChapter(volume, chapter.slug);
        expect(fetched).toEqual(chapter);
        expect(fetched.body).toBe(body);
        expect(fetched.frontmatter).toEqual({
          when_to_use: ["a", "b"],
          nested: { n: 1, list: [1, 2, 3] },
        });
      });

      test("frontmatter round-trips unknown keys, in order, across repeated writes", async () => {
        // Guards the contract @shadow/indexing depends on: this package
        // must never know about, validate, or drop fields it doesn't own
        // (e.g. `when_to_use`/`not_for`) — they must survive read -> write
        // -> read unchanged, including nesting and key order.
        const { store } = harness;
        const volume = toVolumeSlug("vol");
        await store.createVolume({ slug: volume, title: "Vol" });

        const frontmatter = {
          when_to_use: ["designing a one-pager", "single-page layout", "editorial density"],
          not_for: ["multi-page documents", "slide decks"],
          weight: 0.8,
          custom_z: "last",
          custom_a: "first-ish",
        };
        await store.putChapter(volume, {
          slug: toChapterSlug("routed"),
          title: "Routed Chapter",
          body: "body",
          frontmatter,
        });

        const read1 = await store.getChapter(volume, toChapterSlug("routed"));
        expect(read1.frontmatter).toEqual(frontmatter);
        expect(Object.keys(read1.frontmatter)).toEqual(Object.keys(frontmatter));

        // Write it again unchanged (as a later package would, e.g. after
        // touching only the body) and confirm the unknown keys are still intact.
        await store.putChapter(volume, {
          slug: toChapterSlug("routed"),
          title: read1.title,
          body: "body v2",
          frontmatter: read1.frontmatter,
        });

        const read2 = await store.getChapter(volume, toChapterSlug("routed"));
        expect(read2.frontmatter).toEqual(frontmatter);
        expect(Object.keys(read2.frontmatter)).toEqual(Object.keys(frontmatter));
      });

      test("putChapter is an upsert: overwrite preserves createdAt, advances updatedAt", async () => {
        const { store } = harness;
        const volume = toVolumeSlug("vol");
        await store.createVolume({ slug: volume, title: "Vol" });

        const first = await store.putChapter(volume, {
          slug: toChapterSlug("c1"),
          title: "V1",
          body: "body v1",
        });
        await delay(2);
        const second = await store.putChapter(volume, {
          slug: toChapterSlug("c1"),
          title: "V2",
          body: "body v2",
        });

        expect(second.title).toBe("V2");
        expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
        expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
      });

      test("getChapter rejects a missing chapter", async () => {
        const { store } = harness;
        const volume = toVolumeSlug("vol");
        await store.createVolume({ slug: volume, title: "Vol" });
        await expectRejection(
          store.getChapter(volume, toChapterSlug("missing")),
          ChapterNotFoundError,
        );
      });

      test("getChapter rejects a missing volume", async () => {
        const { store } = harness;
        await expectRejection(
          store.getChapter(toVolumeSlug("missing"), toChapterSlug("c1")),
          VolumeNotFoundError,
        );
      });

      test("listChapters returns [] for a volume with none, and sorted by slug otherwise", async () => {
        const { store } = harness;
        const volume = toVolumeSlug("vol");
        await store.createVolume({ slug: volume, title: "Vol" });
        expect(await store.listChapters(volume)).toEqual([]);

        await store.putChapter(volume, { slug: toChapterSlug("zeta"), title: "Zeta", body: "z" });
        await store.putChapter(volume, { slug: toChapterSlug("alpha"), title: "Alpha", body: "a" });

        const listed = await store.listChapters(volume);
        expect(listed.map((c) => String(c.slug))).toEqual(["alpha", "zeta"]);
      });

      test("listChapters rejects a missing volume", async () => {
        const { store } = harness;
        await expectRejection(store.listChapters(toVolumeSlug("missing")), VolumeNotFoundError);
      });

      test("deleteChapter removes it; deleting a missing chapter throws", async () => {
        const { store } = harness;
        const volume = toVolumeSlug("vol");
        await store.createVolume({ slug: volume, title: "Vol" });
        await store.putChapter(volume, { slug: toChapterSlug("c1"), title: "C1", body: "body" });

        await store.deleteChapter(volume, toChapterSlug("c1"));
        await expectRejection(store.getChapter(volume, toChapterSlug("c1")), ChapterNotFoundError);
        await expectRejection(
          store.deleteChapter(volume, toChapterSlug("c1")),
          ChapterNotFoundError,
        );
      });

      test("store isolation: chapters in one volume are invisible from another, even with the same slug", async () => {
        const { store } = harness;
        const a = toVolumeSlug("volume-a");
        const b = toVolumeSlug("volume-b");
        await store.createVolume({ slug: a, title: "A" });
        await store.createVolume({ slug: b, title: "B" });
        await store.putChapter(a, { slug: toChapterSlug("shared-slug"), title: "In A", body: "a" });

        expect(await store.listChapters(b)).toEqual([]);
        await expectRejection(
          store.getChapter(b, toChapterSlug("shared-slug")),
          ChapterNotFoundError,
        );

        const inA = await store.getChapter(a, toChapterSlug("shared-slug"));
        expect(inA.title).toBe("In A");
      });
    });

    describe("index document", () => {
      test("readIndex returns undefined before any write", async () => {
        const { store } = harness;
        const volume = toVolumeSlug("vol");
        await store.createVolume({ slug: volume, title: "Vol" });
        expect(await store.readIndex(volume)).toBeUndefined();
      });

      test("write/read round-trip of an opaque, caller-typed JSON value", async () => {
        const { store } = harness;
        const volume = toVolumeSlug("vol");
        await store.createVolume({ slug: volume, title: "Vol" });

        interface FakeIndex {
          version: number;
          nodes: { id: string; children: string[] }[];
        }
        const index: FakeIndex = { version: 1, nodes: [{ id: "root", children: ["a", "b"] }] };
        await store.writeIndex(volume, index);

        expect(await store.readIndex<FakeIndex>(volume)).toEqual(index);
      });

      test("readIndex/writeIndex reject a missing volume", async () => {
        const { store } = harness;
        await expectRejection(store.readIndex(toVolumeSlug("missing")), VolumeNotFoundError);
        await expectRejection(store.writeIndex(toVolumeSlug("missing"), {}), VolumeNotFoundError);
      });
    });
  });
}
