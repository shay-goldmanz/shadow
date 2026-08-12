/**
 * Generate OKF-conformant `index.md` — the human-readable progressive-disclosure
 * directory listing (OKF v0.2 §8).
 *
 * Produced alongside `index.json` (machine-optimized) during reindex; both
 * coexist. The bundle-root index.md carries `okf_version: "0.2"` frontmatter
 * and one section per volume. Per-volume index.md files list that volume's
 * chapters with descriptions.
 *
 * Zero LLM calls, zero network calls — pure formatting of already-built
 * index data.
 */

import type { ChapterIndexNode, VolumeIndexNode } from "./types.ts";

/**
 * Generate the bundle-root `index.md` — one section per volume, each
 * listing its chapters with descriptions.
 */
export function generateRootIndexMd(volumes: readonly VolumeIndexNode[]): string {
  let md = "";
  md += "---\n";
  md += 'okf_version: "0.2"\n';
  md += "---\n\n";

  // Descriptive preamble (OKF §8 body is free-form, no frontmatter required
  // except for the root's okf_version).
  md += `# Volumes\n\n`;

  for (const volume of volumes) {
    md += `## ${volume.title}\n\n`;

    if (volume.when_to_use) {
      md += `${volume.when_to_use}\n\n`;
    }

    if (volume.chapters.length === 0) {
      md += "_No chapters yet._\n\n";
      continue;
    }

    for (const chapter of volume.chapters) {
      const desc = chapterDescription(chapter);
      md += `* [${chapter.title}](chapters/${chapter.slug}.md)${desc}\n`;
    }
    md += "\n";
  }

  return md;
}

/**
 * Generate a single volume's `index.md` — lists that volume's chapters
 * with descriptions. No frontmatter (per OKF §8, only the root index.md
 * carries okf_version).
 */
export function generateVolumeIndexMd(volume: VolumeIndexNode): string {
  let md = `# ${volume.title}\n\n`;

  if (volume.when_to_use) {
    md += `${volume.when_to_use}\n\n`;
  }

  if (volume.not_for) {
    md += `_Not for: ${volume.not_for}_\n\n`;
  }

  if (volume.chapters.length === 0) {
    md += "_No chapters yet._\n";
    return md;
  }

  for (const chapter of volume.chapters) {
    const desc = chapterDescription(chapter);
    md += `* [${chapter.title}](chapters/${chapter.slug}.md)${desc}\n`;
  }

  return md;
}

/** Derive a short description for an index.md entry from a chapter node. */
function chapterDescription(chapter: ChapterIndexNode): string {
  const parts: string[] = [];

  if (chapter.when_to_use) {
    // Take the first ~120 chars of when_to_use as the description snippet.
    const snippet =
      chapter.when_to_use.length > 120
        ? chapter.when_to_use.slice(0, 120).trimEnd() + "…"
        : chapter.when_to_use;
    parts.push(snippet);
  }

  if (chapter.confidence) {
    parts.push(`[${chapter.confidence}]`);
  }

  if (parts.length === 0) return "";
  return ` — ${parts.join(" ")}`;
}
