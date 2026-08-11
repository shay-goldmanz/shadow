import type { Tone } from "./Badge.tsx";

/**
 * The clickable citation marker rendered inline in chapter prose. Tone is
 * the semantic colour rule in miniature: clay by default (this is sourced),
 * red when the claim failed its audit, amber when its citation has drifted
 * (orphaned, D22 — a warning, never a failure), sage when the claim cites
 * the operator's own words rather than an external source (D19's `operator`
 * kind — still a citation, but "this is yours").
 */
export function CitationMark({
  label,
  tone,
  onClick,
}: {
  readonly label: string;
  readonly tone: Tone;
  readonly onClick: () => void;
}) {
  return (
    <sup>
      <button
        type="button"
        className={`citation-mark citation-mark--${tone}`}
        data-tone={tone}
        aria-label={`Citation ${label}${describeTone(tone)}, opens evidence snapshot`}
        onClick={onClick}
      >
        {label}
      </button>
    </sup>
  );
}

function describeTone(tone: Tone): string {
  switch (tone) {
    case "red":
      return ", audit failed";
    case "amber":
      return ", source drifted";
    case "sage":
      return ", operator's own words";
    default:
      return "";
  }
}
