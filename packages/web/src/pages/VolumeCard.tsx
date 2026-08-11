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
      <span className="volume-card__meta">
        {volume.chapterCount} chapter{volume.chapterCount === 1 ? "" : "s"} · updated{" "}
        {formatDate(volume.updatedAt)}
      </span>
    </button>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
