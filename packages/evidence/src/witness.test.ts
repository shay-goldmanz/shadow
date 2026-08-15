import { describe, expect, test } from "bun:test";
import { sha256Of } from "./digest.ts";
import { newSourceId } from "./ids.ts";
import { makeFileWitness, makeSourceMetadata } from "./test-helpers.ts";
import { deriveSourceFromFile } from "./witness.ts";

describe("deriveSourceFromFile", () => {
  test("is pure: no I/O, deterministic given the same witness/metadata/id", () => {
    const id = newSourceId();
    const witness = makeFileWitness();
    const metadata = makeSourceMetadata();

    const a = deriveSourceFromFile(id, witness, metadata);
    const b = deriveSourceFromFile(id, witness, metadata);

    expect(a).toEqual(b);
  });

  test("sets transport 'file', synthesizes a file:// url, and nulls out http-only fields", () => {
    const { record } = deriveSourceFromFile(
      newSourceId(),
      makeFileWitness({ path: "/docs/rulebook-source.md" }),
      makeSourceMetadata(),
    );

    expect(record.retrieval.transport).toBe("file");
    expect(record.url).toBe("file:///docs/rulebook-source.md");
    expect(record.finalUrl).toBe(record.url);
    expect(record.retrieval.httpStatus).toBeNull();
    expect(record.retrieval.contentType).toBeNull();
  });

  test("snapshot is content-addressed: identical text yields the same normalizedTextSha256 regardless of path", () => {
    const first = deriveSourceFromFile(
      newSourceId(),
      makeFileWitness({ path: "/tmp/a.md", text: "Same rule text." }),
      makeSourceMetadata(),
    );
    const second = deriveSourceFromFile(
      newSourceId(),
      makeFileWitness({ path: "/tmp/b.md", text: "Same rule text." }),
      makeSourceMetadata(),
    );

    expect(first.record.snapshot.normalizedTextSha256).toBe(
      second.record.snapshot.normalizedTextSha256,
    );
    expect(first.normalizedText).toBe(second.normalizedText);
    expect(first.record.snapshot.normalizedTextSha256).toBe(sha256Of(first.normalizedText));
  });

  test("different text yields a different snapshot hash", () => {
    const first = deriveSourceFromFile(
      newSourceId(),
      makeFileWitness({ text: "Rule one." }),
      makeSourceMetadata(),
    );
    const second = deriveSourceFromFile(
      newSourceId(),
      makeFileWitness({ text: "Rule two." }),
      makeSourceMetadata(),
    );

    expect(first.record.snapshot.normalizedTextSha256).not.toBe(
      second.record.snapshot.normalizedTextSha256,
    );
  });
});
