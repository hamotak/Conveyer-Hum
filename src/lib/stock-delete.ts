export interface StockDeleteClip {
  driveFileId: string;
  previewFileId?: string;
}

/**
 * A Drive clip can have a local preview/cache copy attached to it. Deleting
 * only the Drive id lets that local copy reappear as "local cache" on reload.
 */
export function stockDeleteIdsForSelection(
  clips: StockDeleteClip[],
  selected: Set<string>
): string[] {
  const ids = new Set<string>();
  for (const clip of clips) {
    if (!selected.has(clip.driveFileId)) continue;
    ids.add(clip.driveFileId);
    if (clip.previewFileId) ids.add(clip.previewFileId);
  }
  return [...ids];
}
