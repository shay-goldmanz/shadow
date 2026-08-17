import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  InvalidSessionIdError,
  SessionAlreadyExistsError,
  SessionNotFoundError,
} from "./errors.ts";
import { SessionsLayout } from "./layout.ts";
import { readEventLog } from "./read-event-log.ts";
import type {
  NewStoredEvent,
  SessionListFilter,
  SessionMeta,
  SessionMetaPatch,
  SessionStore,
  StoredEventRecord,
} from "./session-store.ts";

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** Swallow ENOENT (the directory doesn't exist yet); rethrow everything else. Matches `@shadow/core`'s `filesystem-volume-store.ts`. */
async function readdirOrEmpty(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * Write `content` to `path` via a per-call tmp file, then `rename` into
 * place. `rename` is atomic on the same filesystem, so a concurrent
 * reader (or a process killed mid-write) can never observe a partially
 * written file at `path` — the same pattern `@shadow/evidence`'s
 * `putSnapshot` uses for content-addressed snapshots (Tier 0 fixes), used
 * here for `meta.json` (as the plan requires) and, more importantly, for
 * `events.jsonl` (see `filesystem-session-store.ts`'s `append`): a raw
 * `appendFile` would concatenate new bytes directly onto a torn last line
 * left by a prior crash, permanently corrupting it instead of leaving it
 * as the cleanly-droppable tail `readEvents` tolerates.
 */
async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmpPath = `${path}.tmp.${randomUUID()}`;
  await Bun.write(tmpPath, content);
  await rename(tmpPath, path);
}

/**
 * Filesystem implementation of `SessionStore`. Owns the on-disk layout
 * defined in `layout.ts` — nothing outside this class ever sees `root` or
 * builds a path into it, mirroring `@shadow/core`'s `FileSystemVolumeStore`.
 *
 * Does **not** itself read `SHADOW_HOME` — same division of responsibility
 * as `FileSystemVolumeStore`: this class takes a resolved `root` and
 * defaults it to `~/.shadow` when omitted; resolving `SHADOW_HOME` (or a
 * `--root` flag) into that root is the caller's job (`@shadow/cli`'s
 * `context.ts`, `@shadow/api`'s `start.ts`), so both stores stay pointed
 * at the same corpus without this package needing to know the env var's
 * name.
 */
export class FileSystemSessionStore implements SessionStore {
  private readonly layout: SessionsLayout;

  /** @param root Storage root. Defaults to `~/.shadow`, the same default `FileSystemVolumeStore` uses. */
  constructor(root: string = join(homedir(), ".shadow")) {
    this.layout = new SessionsLayout(root);
  }

  async create(meta: SessionMeta): Promise<void> {
    const metaPath = this.layout.metaPath(meta.id);
    if (await Bun.file(metaPath).exists()) {
      throw new SessionAlreadyExistsError(meta.id);
    }
    await this.writeMeta(meta);
    // `Bun.write` above already created the session directory; give
    // `events.jsonl` a well-formed (empty) presence too, so `readEvents`
    // on a brand-new session reads an empty array rather than depending
    // on `readEventLog`'s not-yet-created-file branch to agree with it.
    const eventsPath = this.layout.eventsPath(meta.id);
    if (!(await Bun.file(eventsPath).exists())) {
      await Bun.write(eventsPath, "");
    }
  }

  async get(id: string): Promise<SessionMeta | undefined> {
    const file = Bun.file(this.layout.metaPath(id));
    if (!(await file.exists())) {
      return undefined;
    }
    return (await file.json()) as SessionMeta;
  }

  async list(filter?: SessionListFilter): Promise<SessionMeta[]> {
    const entries = await readdirOrEmpty(this.layout.sessionsDir());
    const metas: SessionMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      let meta: SessionMeta | undefined;
      try {
        meta = await this.get(entry.name);
      } catch (error) {
        // A directory name that fails the id path-safety check can't be
        // one this store ever created; skip it rather than fail the
        // whole listing, mirroring `listVolumes`'s skip-on-parse-failure.
        if (error instanceof InvalidSessionIdError) {
          continue;
        }
        throw error;
      }
      if (!meta) {
        // A directory without meta.json (e.g. a partially-cleaned-up
        // delete) is not a session — same non-error skip as
        // `listVolumes`'s analogous case.
        continue;
      }
      if (filter?.volume !== undefined && meta.volume !== filter.volume) {
        continue;
      }
      metas.push(meta);
    }
    metas.sort((a, b) => {
      if (a.lastActiveAt !== b.lastActiveAt) {
        return a.lastActiveAt < b.lastActiveAt ? 1 : -1;
      }
      if (a.createdAt !== b.createdAt) {
        return a.createdAt < b.createdAt ? 1 : -1;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return metas;
  }

  async update(id: string, patch: SessionMetaPatch): Promise<void> {
    const existing = await this.get(id);
    if (!existing) {
      throw new SessionNotFoundError(id);
    }
    const updated: SessionMeta = {
      ...existing,
      title: patch.title !== undefined ? patch.title : existing.title,
      lastActiveAt: patch.lastActiveAt ?? existing.lastActiveAt,
      sdkSessionId: patch.sdkSessionId ?? existing.sdkSessionId,
    };
    await this.writeMeta(updated);
  }

  async append(id: string, events: readonly NewStoredEvent[]): Promise<StoredEventRecord[]> {
    await this.requireSession(id);
    const path = this.layout.eventsPath(id);
    const { records: existing, cleanText } = await readEventLog(path, id);
    const lastRecord = existing.length > 0 ? existing[existing.length - 1] : undefined;
    const lastSeq = lastRecord?.seq ?? 0;
    const stamped: StoredEventRecord[] = events.map((event, index) => ({
      ...event,
      seq: lastSeq + index + 1,
    }));
    const appendedText = stamped.map((record) => `${JSON.stringify(record)}\n`).join("");
    // Rewriting the whole file (via the same atomic tmp+rename as
    // `writeMeta`) rather than a raw `appendFile` is deliberate: `cleanText`
    // already excludes any torn tail left by a prior crash, so writing
    // `cleanText + appendedText` self-heals it as a side effect. A raw
    // `appendFile` would instead concatenate straight onto the torn
    // line's bytes, gluing new valid JSON onto old partial JSON and
    // turning a tolerable "torn last line" into a corrupt *middle* line
    // the moment a third append followed — see `SessionEventsCorruptError`'s
    // doc. Cost: O(session size) I/O per `append` instead of O(1); judged
    // acceptable for a chat session's transcript (not an unbounded log).
    await writeFileAtomic(path, cleanText + appendedText);
    return stamped;
  }

  async readEvents(id: string, fromSeq?: number): Promise<StoredEventRecord[]> {
    await this.requireSession(id);
    const { records } = await readEventLog(this.layout.eventsPath(id), id);
    if (fromSeq === undefined) {
      return records;
    }
    return records.filter((record) => record.seq >= fromSeq);
  }

  async delete(id: string): Promise<void> {
    await this.requireSession(id);
    // SDK transcript deletion is deliberately not this method's job — see
    // the `SessionStore.delete` doc.
    await rm(this.layout.sessionDir(id), { recursive: true, force: true });
  }

  // ---- internals ----------------------------------------------------------

  private async requireSession(id: string): Promise<void> {
    if (!(await Bun.file(this.layout.metaPath(id)).exists())) {
      throw new SessionNotFoundError(id);
    }
  }

  private async writeMeta(meta: SessionMeta): Promise<void> {
    await writeFileAtomic(this.layout.metaPath(meta.id), `${JSON.stringify(meta, null, 2)}\n`);
  }
}
