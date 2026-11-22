import type { Asset, TimelineDocument, TimelinePatchOperation } from "@aivideo/contracts";

export const ASSET_DRAG = "application/x-vortex-cut-asset";
export const ASSET_BATCH_DRAG = "application/x-vortex-cut-assets";

/** OpenFilm uses the current selection when a selected tile starts the drag. */
export function draggedAssetIds<T extends string>(id: T, order: readonly T[], selected: ReadonlySet<T>): T[] {
  return selected.has(id) && selected.size > 1 ? order.filter(item => selected.has(item)) : [id];
}

export function readAssetDrop(transfer: DataTransfer): string[] {
  const batch = transfer.getData(ASSET_BATCH_DRAG);
  if (batch) {
    try {
      const parsed: unknown = JSON.parse(batch);
      return Array.isArray(parsed) && parsed.length > 0 && parsed.every(id => typeof id === "string" && id.length > 0)
        ? [...new Set<string>(parsed)] : [];
    } catch { return []; }
  }
  const single = transfer.getData(ASSET_DRAG);
  return single ? [single] : [];
}

export function hasAssetDrag(transfer: DataTransfer): boolean {
  // Chromium protects drag data until drop; the MIME types remain visible.
  return transfer.types?.includes(ASSET_BATCH_DRAG) || transfer.types?.includes(ASSET_DRAG) || readAssetDrop(transfer).length > 0;
}

export function planAssetDrop(
  assets: readonly Asset[], tracks: TimelineDocument["tracks"], slot: number, target?: string
): TimelinePatchOperation[] {
  const row = tracks.find(track => track.id === target);
  const wantsNewTrack = target === "new" || row?.kind === "text" ||
    (row?.kind === "audio" && assets.some(asset => asset.kind === "image"));
  const operations: TimelinePatchOperation[] = [];
  let visualTrackId = row?.kind === "video" ? row.id : "V1";
  if (wantsNewTrack && assets.some(asset => asset.kind !== "audio")) {
    const used = new Set(tracks.map(track => track.id));
    let number = 2;
    while (used.has(`V${number}`)) number += 1;
    visualTrackId = `V${number}`;
    operations.push({ op: "add_track", kind: "video" });
  }
  let index = wantsNewTrack ? 0 : slot;
  for (const asset of assets) {
    const asAudio = asset.kind === "video" && row?.kind === "audio";
    const audio = asAudio || asset.kind === "audio";
    operations.push({
      op: "insert_asset_clip", asset_id: asset.asset_id, at_index: audio ? 0 : index++,
      ...(audio ? {} : { track_id: visualTrackId }),
      ...(asAudio ? { as_audio: true } : {}),
      ...(asset.kind === "image" ? { duration_us: 3_000_000 } : {})
    });
  }
  return operations;
}
