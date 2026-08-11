import { describe, expect, test } from "bun:test";
import { toChapterSlug, toVolumeSlug } from "@shadow/core";
import { seedVolume, withApi, withScriptedApi } from "../test-helpers.ts";

describe("Index", () => {
  test("GET index before any reindex is 404 index_not_built", async () => {
    await withApi(async ({ baseUrl, deps }) => {
      await seedVolume(deps, toVolumeSlug("design-craft"));
      const res = await fetch(`${baseUrl}/api/volumes/design-craft/index`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("index_not_built");
    });
  });

  test("POST reindex builds and persists the index, returning volume-scoped stats", async () => {
    await withScriptedApi({}, async ({ baseUrl, deps }) => {
      const volume = toVolumeSlug("design-craft");
      await seedVolume(deps, volume);
      await deps.volumeStore.putChapter(volume, {
        slug: toChapterSlug("spacing"),
        title: "Spacing",
        body: "Spacing is systemic.",
      });

      const res = await fetch(`${baseUrl}/api/volumes/design-craft/reindex`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        index: { volume: { chapters: { slug: string }[] } };
        stats: { volumes: number; chapters: number; tokens: number };
      };
      expect(body.index.volume.chapters.map((c) => c.slug)).toEqual(["spacing"]);
      expect(body.stats).toEqual({ volumes: 1, chapters: 1, tokens: expect.any(Number) });

      const getRes = await fetch(`${baseUrl}/api/volumes/design-craft/index`);
      expect(getRes.status).toBe(200);
      const getBody = (await getRes.json()) as { volume: { chapters: { slug: string }[] } };
      expect(getBody.volume.chapters.map((c) => c.slug)).toEqual(["spacing"]);
    });
  });

  test("reindexing a nonexistent volume is 404", async () => {
    await withApi(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/volumes/nope/reindex`, { method: "POST" });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("volume_not_found");
    });
  });
});

describe("Lint", () => {
  test("GET /api/lint?volume=:slug runs offline checks over the reindexed volume", async () => {
    await withApi(async ({ baseUrl, deps }) => {
      const volume = toVolumeSlug("design-craft");
      await seedVolume(deps, volume);
      await deps.volumeStore.putChapter(volume, {
        slug: toChapterSlug("spacing"),
        title: "Spacing",
        body: "Spacing is systemic.",
        frontmatter: { when_to_use: "Designing dense UI." },
      });
      await deps.indexer.reindex(deps.volumeStore);

      const res = await fetch(`${baseUrl}/api/lint?volume=design-craft&offline=true`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { offline: boolean; checks: unknown[] };
      expect(body.offline).toBe(true);
      expect(Array.isArray(body.checks)).toBe(true);
      expect(body.checks.length).toBeGreaterThan(0);
    });
  });

  test("missing ?volume is 400 invalid_request", async () => {
    await withApi(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/lint`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid_request");
    });
  });

  test("linting an unindexed volume is 404 index_not_built", async () => {
    await withApi(async ({ baseUrl, deps }) => {
      await seedVolume(deps, toVolumeSlug("design-craft"));
      const res = await fetch(`${baseUrl}/api/lint?volume=design-craft`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("index_not_built");
    });
  });
});
