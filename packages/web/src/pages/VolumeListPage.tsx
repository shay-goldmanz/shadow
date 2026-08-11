import { useEffect, useState } from "react";
import type { ShadowApiClient } from "../api/client.ts";
import type { VolumeSummary } from "../api/types.ts";
import { ApiError } from "../api/types.ts";
import type { Route } from "../routing/useHashRoute.ts";
import { CreateVolumeForm } from "./CreateVolumeForm.tsx";
import { VolumeCard } from "./VolumeCard.tsx";

/**
 * The landing view — acceptance's critical path opens with "operator opens
 * interface and creates a volume", so existing volumes and volume creation
 * share top billing here rather than creation being buried in a menu.
 */
export function VolumeListPage({
  client,
  navigate,
}: {
  readonly client: ShadowApiClient;
  readonly navigate: (route: Route) => void;
}) {
  const [volumes, setVolumes] = useState<readonly VolumeSummary[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    client
      .listVolumes()
      .then((result) => {
        if (!cancelled) setVolumes(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  async function handleCreate(input: { title: string; description: string }) {
    setCreating(true);
    setCreateError(undefined);
    try {
      const volume = await client.createVolume(input);
      setVolumes((prev) => [
        {
          slug: volume.slug,
          title: volume.title,
          description: volume.description,
          chapterCount: 0,
          updatedAt: volume.updatedAt,
        },
        ...(prev ?? []),
      ]);
      navigate({ name: "volume", slug: volume.slug });
    } catch (err) {
      setCreateError(
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err),
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="page volume-list-page">
      <header className="page__header">
        <h1>Volumes</h1>
        <p className="page__subtitle">Curated beliefs, distilled with Shadow.</p>
      </header>

      <CreateVolumeForm
        onCreate={(input) => void handleCreate(input)}
        pending={creating}
        error={createError}
      />

      {error && <p role="alert">Could not load volumes: {error}</p>}

      {volumes === undefined && !error && <p aria-live="polite">Loading volumes…</p>}

      {volumes && volumes.length === 0 && (
        <p className="volume-list__empty">No volumes yet — create the first one above.</p>
      )}

      {volumes && volumes.length > 0 && (
        <ul className="volume-list">
          {volumes.map((volume) => (
            <li key={volume.slug}>
              <VolumeCard
                volume={volume}
                onOpen={() => navigate({ name: "volume", slug: volume.slug })}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
