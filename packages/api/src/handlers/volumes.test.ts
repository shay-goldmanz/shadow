import { describe, expect, test } from "bun:test";
import { withApi } from "../test-helpers.ts";

describe("Volumes CRUD", () => {
  test("create -> list -> get -> patch -> delete round-trips through HTTP", async () => {
    await withApi(async ({ baseUrl }) => {
      const createRes = await fetch(`${baseUrl}/api/volumes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Design Craft", description: "Beliefs about UI design." }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as { volume: { slug: string; title: string } };
      expect(created.volume.slug).toBe("design-craft");
      expect(created.volume.title).toBe("Design Craft");

      const listRes = await fetch(`${baseUrl}/api/volumes`);
      expect(listRes.status).toBe(200);
      const listed = (await listRes.json()) as { volumes: { slug: string }[] };
      expect(listed.volumes.map((v) => v.slug)).toEqual(["design-craft"]);

      const getRes = await fetch(`${baseUrl}/api/volumes/design-craft`);
      expect(getRes.status).toBe(200);
      const got = (await getRes.json()) as { volume: { slug: string }; chapters: unknown[] };
      expect(got.volume.slug).toBe("design-craft");
      expect(got.chapters).toEqual([]);

      const patchRes = await fetch(`${baseUrl}/api/volumes/design-craft`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: "Updated description." }),
      });
      expect(patchRes.status).toBe(200);
      const patched = (await patchRes.json()) as { volume: { description: string; title: string } };
      expect(patched.volume.description).toBe("Updated description.");
      expect(patched.volume.title).toBe("Design Craft"); // unset fields left unchanged

      const deleteRes = await fetch(`${baseUrl}/api/volumes/design-craft`, { method: "DELETE" });
      expect(deleteRes.status).toBe(200);
      expect(await deleteRes.json()).toEqual({ deleted: true });

      const afterDeleteRes = await fetch(`${baseUrl}/api/volumes/design-craft`);
      expect(afterDeleteRes.status).toBe(404);
      const afterDeleteBody = (await afterDeleteRes.json()) as { error: { code: string } };
      expect(afterDeleteBody.error.code).toBe("volume_not_found");
    });
  });

  test("slug is derived from title when omitted", async () => {
    await withApi(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/volumes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "How Linear & Notion Design UI!" }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { volume: { slug: string } };
      expect(body.volume.slug).toBe("how-linear-notion-design-ui");
    });
  });

  test("an invalid slug is 400, not 500", async () => {
    await withApi(async ({ baseUrl }) => {
      const explicitBad = await fetch(`${baseUrl}/api/volumes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Fine title", slug: "Not A Valid Slug!" }),
      });
      expect(explicitBad.status).toBe(400);
      const explicitBody = (await explicitBad.json()) as { error: { code: string } };
      expect(explicitBody.error.code).toBe("invalid_slug");

      // A title with nothing slug-able (`slugify` returns "") also derives
      // an invalid slug — same 400, not a 500 from an unhandled exception.
      const derivedBad = await fetch(`${baseUrl}/api/volumes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "!!!" }),
      });
      expect(derivedBad.status).toBe(400);
      const derivedBody = (await derivedBad.json()) as { error: { code: string } };
      expect(derivedBody.error.code).toBe("invalid_slug");
    });
  });

  test("missing title is 400", async () => {
    await withApi(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/volumes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: "no title" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid_request");
    });
  });

  test("getting a nonexistent volume is 404 volume_not_found", async () => {
    await withApi(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/volumes/does-not-exist`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("volume_not_found");
    });
  });

  test("creating a volume that already exists is 409", async () => {
    await withApi(async ({ baseUrl }) => {
      const first = await fetch(`${baseUrl}/api/volumes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Design Craft" }),
      });
      expect(first.status).toBe(201);

      const second = await fetch(`${baseUrl}/api/volumes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Design Craft" }),
      });
      expect(second.status).toBe(409);
      const body = (await second.json()) as { error: { code: string } };
      expect(body.error.code).toBe("volume_already_exists");
    });
  });
});

describe("A genuine fault is 500, not swallowed", () => {
  test("an unmapped error thrown by a pillar surfaces as 500 internal_error", async () => {
    await withApi(async ({ baseUrl, deps }) => {
      // Simulate a genuine fault (e.g. a filesystem failure) — not one of
      // the typed pillar errors this package knows how to map to a 4xx.
      // biome-ignore lint/suspicious/noExplicitAny: deliberately breaking one method for this one test
      (deps.volumeStore as any).getVolume = async () => {
        throw new Error("disk caught fire");
      };

      const res = await fetch(`${baseUrl}/api/volumes/design-craft`);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("internal_error");
      expect(body.error.message).toBe("disk caught fire");
    });
  });
});

describe("Routing", () => {
  test("an unmatched route is 404 route_not_found", async () => {
    await withApi(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/nope`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("route_not_found");
    });
  });
});
