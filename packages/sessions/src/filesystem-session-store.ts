import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { appendFile, readdir, rename, rm, stat } from "node:fs/promises";
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
 * `putSnapshot` uses for content-addressed snapshots (Tier 0 fixes). Used
 * for `meta.json` on every `writeMeta` (as the plan requires), and for
 * `events.jsonl` exactly once per session per store instance — the
 * one-time torn-tail repair `ensureAppendReady` performs before the first
 * `append` for a given id starts using the O_APPEND fast path (F1 review
 * fix; see that method's doc). Every *subsequent* append no longer goes
 * through this function at all — see `append`'s doc for why a raw
 * `appendFile` is safe once that one-time repair has run.
 */
async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmpPath = `${path}.tmp.${randomUUID()}`;
  await Bun.write(tmpPath, content);
  await rename(tmpPath, path);
}

/** One session id's cached O_APPEND state — see `ensureAppendReady`. */
interface AppendState {
  /** The highest `seq` on disk for this session, as of the last append this store instance made (or observed via the one-time repair read). */
  lastSeq: number;
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

  /**
   * Per-session-id, per-store-instance cache of `append`'s O_APPEND state
   * (F1 review fix). A session id enters this map exactly once — the first
   * time `append` is called for it on *this* store instance — via
   * `ensureAppendReady`, which is also where the one-time torn-tail repair
   * happens. Every later `append` call for the same id, on the same
   * instance, skips the read-and-maybe-repair pass entirely and goes
   * straight to an O(1) `appendFile`. A fresh store instance (e.g. a
   * process restart pointed at the same `root`) starts with an empty map,
   * so its first `append` per id re-derives `lastSeq` from disk and
   * re-checks for a torn tail — seq numbering therefore continues correctly
   * across a restart, it never resets.
   */
  private readonly appendState = new Map<string, AppendState>();

  /** @param root Storage root. Defaults to `~/.shadow`, the same default `FileSystemVolumeStore` uses. */
  constructor(root: string = join(homedir(), ".shadow")) {
    this.layout = new SessionsLayout(root);
  }

  /**
   * **TOCTOU note**, same caveat `append`'s doc spells out for itself: the
   * exists-check and the write below are two separate operations, not one
   * atomic one. Two concurrent `create` calls for the same *not-yet-existing*
   * id can both observe "doesn't exist" and both proceed to write — this
   * store does not defend against that race itself, the same way `append`
   * does not defend against two concurrent appends for the same id. Safe in
   * practice for the same reason: `@shadow/api`'s per-session-id lock (T2.5)
   * is the caller that actually serializes access to a given id, `create`
   * included, not just `append`.
   */
  async create(meta: SessionMeta): Promise<void> {
    const metaPath = this.layout.metaPath(meta.id);
    if (await Bun.file(metaPath).exists()) {
      throw new SessionAlreadyExistsError(meta.id);
    }
    // A fresh (or reused-after-delete, see `delete`'s note) id must not
    // inherit a stale cached `lastSeq` from a previous life of this id on
    // this same store instance.
    this.appendState.delete(meta.id);
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

  /**
   * Appends via `appendFile(path, ..., { flag: "a" })` — one O(1) syscall,
   * not a rewrite of the whole file (F1 review fix). This is safe *only*
   * because `ensureAppendReady` has already run once for `id` on this store
   * instance: it heals any torn tail left by a prior crash-mid-append
   * before the very first raw `appendFile` for this id ever happens, so
   * every append after that point is landing on a file that is guaranteed
   * to end cleanly (a whole, newline-terminated JSON line) — appending onto
   * a clean tail can never glue new bytes onto old partial JSON, which was
   * the actual risk a raw `appendFile` posed before this fix, not appending
   * itself.
   *
   * The trade this makes, spelled out because it inverts the previous
   * design's: a SIGKILL mid-`append` can now tear the *new* last line again
   * (same as it always could before the previous fix existed) — exactly the
   * shape `read-event-log.ts`'s reader was built to tolerate, and the shape
   * the plan's failure table already promises ("a torn last line is
   * dropped, not fatal"). The previous rewrite-the-whole-file design's
   * trade was the opposite one — "never tears, sometimes bricks the whole
   * file on power loss" (a crash *during* the tmp+rename could, in the
   * worst case, leave neither the old nor the new file intact depending on
   * exactly when power was lost relative to the rename) — which is the
   * wrong trade for a file this store's own reader already knows how to
   * heal from a torn tail. `@shadow/evidence`'s `store.ts` (`appendLedgerEvent`)
   * already made the same O_APPEND call for its own append-only ledger;
   * this fix brings the two append-only logs in this repo back to the same
   * stance instead of leaving them silently opposite for no recorded
   * reason.
   *
   * Measured: the old rewrite-per-append design was ~38x slower than this
   * one and wrote ~235MB for 1.2MB of actual event data over 400 sequential
   * appends to a growing log (each append rewriting everything written so
   * far) — the O(session size) cost the old doc comment flagged as
   * "acceptable," measured, was not.
   */
  async append(id: string, events: readonly NewStoredEvent[]): Promise<StoredEventRecord[]> {
    await this.requireSession(id);
    const path = this.layout.eventsPath(id);
    const state = await this.ensureAppendReady(id, path);

    const stamped: StoredEventRecord[] = events.map((event, index) => ({
      ...event,
      seq: state.lastSeq + index + 1,
    }));
    const appendedText = stamped.map((record) => `${JSON.stringify(record)}\n`).join("");
    await appendFile(path, appendedText, { encoding: "utf8", flag: "a" });
    state.lastSeq += stamped.length;
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
    // Drop any cached append state for this id (F1 review fix) — without
    // this, a `create` that reuses this same id later (on this same store
    // instance) would find its cache pre-populated with the *deleted*
    // session's `lastSeq` and start numbering the new session's events from
    // there instead of from 1. `create` also clears this defensively, so
    // this line is belt-and-braces against anything that removes a session
    // directory some other way.
    this.appendState.delete(id);
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

  /**
   * Returns `id`'s cached `AppendState`, populating it first if this is the
   * first `append` for `id` on this store instance (F1 review fix). The
   * one-time population does three things, in order: (1) reads the log via
   * the shared torn-tail-tolerant reader to learn `lastSeq` and the clean
   * prefix; (2) if the raw on-disk file is longer than that clean prefix —
   * a torn tail, left by a process killed mid-`append` before this fix, or
   * mid-repair by this same method in a previous run — repairs it ONCE via
   * `writeFileAtomic`, so every append after this point can safely use raw
   * `appendFile`; (3) removes any crash-orphaned `events.jsonl.tmp.*` files
   * in this session's directory (left behind by an old-design `append` or
   * by `writeMeta`/this repair itself being killed between the tmp write
   * and the rename) — nothing in this package ever reads a `.tmp.*` file
   * back, so an orphan is pure disk waste, cleaned up the one time this
   * method already has to look at this session's directory anyway.
   */
  private async ensureAppendReady(id: string, path: string): Promise<AppendState> {
    const cached = this.appendState.get(id);
    if (cached) return cached;

    const { records, cleanText } = await readEventLog(path, id);
    const lastRecord = records.length > 0 ? records[records.length - 1] : undefined;
    const state: AppendState = { lastSeq: lastRecord?.seq ?? 0 };

    if (await this.hasTornTail(path, cleanText)) {
      await writeFileAtomic(path, cleanText);
    }
    await this.cleanupStaleEventsTmpFiles(id);

    this.appendState.set(id, state);
    return state;
  }

  /** Whether `path`'s on-disk size exceeds `cleanText`'s — i.e. there are bytes on disk `readEventLog` dropped as an unparseable torn tail. Compares byte lengths (`stat`'s `size`, `Buffer.byteLength`), not JS string `.length`, so multi-byte UTF-8 content compares correctly. */
  private async hasTornTail(path: string, cleanText: string): Promise<boolean> {
    let rawSize: number;
    try {
      rawSize = (await stat(path)).size;
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") return false;
      throw error;
    }
    return rawSize > Buffer.byteLength(cleanText, "utf8");
  }

  /** Removes any `events.jsonl.tmp.*` left in `id`'s session directory — orphaned by a process killed between `writeFileAtomic`'s tmp write and its rename. Best-effort: a file that vanishes between listing and removal (e.g. another repair pass beat this one to it) is not an error. */
  private async cleanupStaleEventsTmpFiles(id: string): Promise<void> {
    const dir = this.layout.sessionDir(id);
    const prefix = "events.jsonl.tmp.";
    const entries = await readdirOrEmpty(dir);
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
        .map((entry) => rm(join(dir, entry.name), { force: true })),
    );
  }
}
