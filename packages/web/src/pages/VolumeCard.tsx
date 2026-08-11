import type { VolumeSummary } from "../api/types.ts";

export function VolumeCard({
  volume,
  onOpen,
}: {
  readonly volume: VolumeSummary;
  readonly onOpen: () => void;
}) {
  return (
    <button type="button" className="volume-card" onClick={onOpen}>
      <span className="volume-card__title">{volume.title}</span>
      {volume.description && <span className="volume-card__description">{volume.description}</span>}
      {/* `GET /api/volumes` never sends a chapter count (`VolumeSummary` is a
          full `Volume`, nothing more) — showing "updated" alone here is
          honest about what's actually known at this list-view granularity. */}
      <span className="volume-card__meta">updated {formatDate(volume.updatedAt)}</span>
    </button>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
