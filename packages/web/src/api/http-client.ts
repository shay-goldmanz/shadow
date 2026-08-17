/**
 * The real implementation of `ShadowApiClient`, over `fetch` against
 * `@shadow/api` (`docs/API.md`). This is the only file in the app that
 * knows a URL or an HTTP verb.
 */

import type { GetSessionEventsOptions, ShadowApiClient } from "./client.ts";
import { parseEventStream } from "./sse.ts";
import {
  ApiError,
  type ApiErrorBody,
  type AuditRecord,
  type Chapter,
  type ChapterSummary,
  type ChatInput,
  type ChatStreamEvent,
  type ClaimSidecar,
  type CreateVolumeInput,
  type IndexStats,
  type LedgerEvent,
  type LintReport,
  type PutChapterAudit,
  type PutChapterInput,
  type SessionEventEnvelope,
  type SourceRecord,
  type UpdateVolumeInput,
  type Volume,
  type VolumeIndexDocument,
  type VolumeSummary,
} from "./types.ts";

export class HttpApiClient implements ShadowApiClient {
  constructor(private readonly baseUrl: string = "/api") {}

  async listVolumes(): Promise<readonly VolumeSummary[]> {
    const { volumes } = await this.getJson<{ volumes: VolumeSummary[] }>("/volumes");
    return volumes;
  }

  async createVolume(input: CreateVolumeInput): Promise<Volume> {
    const { volume } = await this.postJson<{ volume: Volume }>("/volumes", input);
    return volume;
  }

  async getVolume(slug: string): Promise<{ volume: Volume; chapters: readonly ChapterSummary[] }> {
    return this.getJson(`/volumes/${encodeURIComponent(slug)}`);
  }

  async updateVolume(slug: string, input: UpdateVolumeInput): Promise<Volume> {
    const { volume } = await this.request<{ volume: Volume }>(
      `/volumes/${encodeURIComponent(slug)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
    return volume;
  }

  async deleteVolume(slug: string): Promise<void> {
    await this.request(`/volumes/${encodeURIComponent(slug)}`, { method: "DELETE" });
  }

  async getChapter(
    slug: string,
    chapter: string,
  ): Promise<{ chapter: Chapter; claims?: ClaimSidecar; audit?: AuditRecord }> {
    return this.getJson(
      `/volumes/${encodeURIComponent(slug)}/chapters/${encodeURIComponent(chapter)}`,
    );
  }

  async putChapter(
    slug: string,
    chapter: string,
    input: PutChapterInput,
  ): Promise<{ chapter: Chapter; audit: PutChapterAudit }> {
    return this.request(
      `/volumes/${encodeURIComponent(slug)}/chapters/${encodeURIComponent(chapter)}`,
      { method: "PUT", body: JSON.stringify(input) },
    );
  }

  async deleteChapter(slug: string, chapter: string): Promise<void> {
    await this.request(
      `/volumes/${encodeURIComponent(slug)}/chapters/${encodeURIComponent(chapter)}`,
      { method: "DELETE" },
    );
  }

  async getIndex(slug: string): Promise<VolumeIndexDocument> {
    return this.getJson(`/volumes/${encodeURIComponent(slug)}/index`);
  }

  async reindex(slug: string): Promise<{ index: VolumeIndexDocument; stats: IndexStats }> {
    return this.request(`/volumes/${encodeURIComponent(slug)}/reindex`, { method: "POST" });
  }

  async getLint(slug: string): Promise<LintReport> {
    return this.getJson(`/lint?volume=${encodeURIComponent(slug)}`);
  }

  async getSource(slug: string, id: string): Promise<SourceRecord> {
    return this.getJson(
      `/volumes/${encodeURIComponent(slug)}/evidence/sources/${encodeURIComponent(id)}`,
    );
  }

  async getSnapshot(slug: string, hash: string): Promise<string> {
    const response = await fetch(
      `${this.baseUrl}/volumes/${encodeURIComponent(slug)}/evidence/snapshot/${encodeURIComponent(hash)}`,
    );
    if (!response.ok) throw await toApiError(response);
    return response.text();
  }

  async getLedger(slug: string): Promise<{ events: readonly LedgerEvent[] }> {
    return this.getJson(`/volumes/${encodeURIComponent(slug)}/evidence/ledger`);
  }

  async *chat(input: ChatInput): AsyncIterable<ChatStreamEvent> {
    const response = await fetch(`${this.baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok || !response.body) throw await toApiError(response);

    for await (const raw of parseEventStream(response.body)) {
      yield { event: raw.event, data: JSON.parse(raw.data) } as ChatStreamEvent;
    }
  }

  async *getSessionEvents(
    sessionId: string,
    options: GetSessionEventsOptions = {},
  ): AsyncIterable<SessionEventEnvelope> {
    const params = new URLSearchParams();
    if (options.follow) params.set("follow", "true");
    if (options.fromSeq !== undefined) params.set("fromSeq", String(options.fromSeq));
    const query = params.toString();
    const response = await fetch(
      `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/events${query ? `?${query}` : ""}`,
    );
    if (!response.ok || !response.body) throw await toApiError(response);

    for await (const raw of parseEventStream(response.body)) {
      const data = JSON.parse(raw.data) as Record<string, unknown> & { readonly seq?: unknown };
      // `seq` rides in the same `data` object on the wire (`@shadow/api`'s
      // `withSeq`) but is lifted to the envelope here — see
      // `SessionEventEnvelope`'s doc for why. `text`/`done` never carry one.
      const seq = typeof data.seq === "number" ? data.seq : undefined;
      yield { event: raw.event as ChatStreamEvent["event"], data, seq };
    }
  }

  private async getJson<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "POST", body: JSON.stringify(body) });
  }

  private async request<T>(
    path: string,
    init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> },
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
    });
    if (!response.ok) throw await toApiError(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as ApiErrorBody;
    return new ApiError(body.error.code, body.error.message, body.error.details);
  } catch {
    return new ApiError("unknown_error", `Request failed with status ${response.status}`);
  }
}
