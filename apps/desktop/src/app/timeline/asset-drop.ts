import type { Asset, TimelineClip, TimelineClipId, TimelineDocument, TimelinePatchOperation, TimelineTrack } from "@aivideo/contracts";
import type { TimelineAssetDropIntent } from "./types.js";

export const ASSET_DRAG = "application/x-vortex-cut-asset";
export const ASSET_BATCH_DRAG = "application/x-vortex-cut-assets";
export const SYSTEM_FILE_DROP_ID = "__vortex_cut_system_file_drop__";
export const MAX_ASSET_DRAG_ITEMS = 100;

let activeDraggedIds: string[] = [];
let pendingSystemFiles: File[] = [];

export interface TimelineAssetDropIntentInput {
  hit: {
    trackId: string | null;
    band: "above" | "body" | "below";
    clipId: TimelineClipId | null;
    zone: "replace" | "above" | "below" | "before" | "after" | null;
  };
  clips: readonly TimelineClip[];
  tracks: readonly TimelineTrack[];
  lockedClipIds?: readonly string[];
  assetKinds: readonly Asset["kind"][] | null;
  itemCount: number;
  canReplace: boolean;
  pointerUs: number;
  fpsNum: number;
  fpsDen: number;
  hasCoordinates?: boolean;
  defaultSlot?: number;
  altKey?: boolean;
  mainTrackMagnet?: boolean;
  assetDurationsUs?: readonly (number | null)[];
}

const snapAssetDropUs = (us: number, fpsNum: number, fpsDen: number): number => {
  const safeNum = Number.isFinite(fpsNum) && fpsNum > 0 ? fpsNum : 30;
  const safeDen = Number.isFinite(fpsDen) && fpsDen > 0 ? fpsDen : 1;
  const frame = Math.round((us * safeNum) / (1_000_000 * safeDen));
  return Math.max(0, Math.round((frame * 1_000_000 * safeDen) / safeNum));
};

/** Resolve media family from dragover MIME or a captured native File name. */
export function assetDropKindFromFile(name: string, type: string, assumeUnknownIsVideo = false): Asset["kind"] | null {
  const mime = type.trim().toLowerCase().split(";", 1)[0] ?? "";
  const family = mime.startsWith("video/") ? "video" : mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : null;
  const extension = name.toLowerCase().match(/\.[a-z0-9]{1,8}$/)?.[0] ?? "";
  const byExtension: Record<string, Asset["kind"]> = {
    ".mp4": "video", ".mov": "video", ".mkv": "video", ".webm": "video", ".avi": "video",
    ".wav": "audio", ".mp3": "audio", ".m4a": "audio", ".aac": "audio", ".flac": "audio",
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image",
  };
  const extKind = byExtension[extension] ?? null;
  if (family && extKind && family !== extKind) return null;
  if (family) return family;
  if (["", "application/octet-stream", "binary/octet-stream", "application/x-matroska"].includes(mime)) {
    return extKind ?? (assumeUnknownIsVideo ? "video" : null);
  }
  return null;
}

/** Resolve a frame-snapped drop landing once so dragover feedback and drop commit share identical semantics. */
export function resolveTimelineAssetDropIntent(input: TimelineAssetDropIntentInput): TimelineAssetDropIntent {
  const targetClip = input.hit.clipId ? input.clips.find(clip => clip.clip_id === input.hit.clipId) ?? null : null;
  const row = input.hit.trackId ? input.tracks.find(track => track.id === input.hit.trackId) ?? null : null;
  let zone: TimelineAssetDropIntent["zone"] = input.hit.zone === "before" || input.hit.zone === "after"
    ? input.hit.zone
    : input.hit.zone === "replace" ? "center" : "lane";
  let boundary = zone === "before" || zone === "after" ? zone : null;
  const kinds = input.assetKinds;
  const recognized = Boolean(kinds?.length) && kinds!.every(kind => kind === "video" || kind === "image" || kind === "audio");
  const family: "video" | "audio" = kinds?.length && kinds.every(kind => kind === "audio") ? "audio" : "video";
  const rowCompatible = Boolean(row && (family === "audio" ? row.kind === "audio" : row.kind === "video"));
  const explicitTrackBand = input.hasCoordinates !== false && Boolean(row) && input.hit.band !== "body";
  if (boundary && !rowCompatible) {
    boundary = null;
    zone = "lane";
  }
  const mode: TimelineAssetDropIntent["mode"] = boundary
    ? "insert"
    : input.altKey ? "overwrite"
      : input.mainTrackMagnet && row?.id === "V1" && input.hit.band === "body" ? "insert" : "place";
  const lockedSet = new Set(input.lockedClipIds ?? []);
  const targetMembers = targetClip?.link_group_id
    ? input.clips.filter(clip => clip.link_group_id === targetClip.link_group_id)
    : targetClip ? [targetClip] : [];
  const locked = Boolean((row?.locked && rowCompatible && !explicitTrackBand) || targetMembers.some(clip => lockedSet.has(clip.clip_id) || input.tracks.find(track => track.id === clip.track_id)?.locked));
  const replaceCompatible = (kind: Asset["kind"], trackKind: TimelineTrack["kind"] | undefined) =>
    trackKind === "audio" ? kind === "audio" || kind === "video"
      : trackKind === "video" ? kind === "video" || kind === "image"
        : false;
  let accepts = recognized && !locked;
  if (accepts && zone === "center" && input.itemCount === 1) {
    accepts = Boolean(input.canReplace && targetClip && kinds?.every(kind => replaceCompatible(kind, row?.kind)));
  } else if (accepts && (zone === "before" || zone === "after")) {
    accepts = Boolean(targetClip && row && rowCompatible);
  }

  const pointerUs = snapAssetDropUs(Math.max(0, Number.isFinite(input.pointerUs) ? input.pointerUs : 0), input.fpsNum, input.fpsDen);
  const rowClips = row ? input.clips.filter(clip => clip.track_id === row.id).sort((a, b) => a.timeline_start_us - b.timeline_start_us) : [];
  const rawAtUs = boundary === "before" && targetClip ? targetClip.timeline_start_us
    : boundary === "after" && targetClip ? targetClip.timeline_end_us
      : pointerUs;
  let atUs = snapAssetDropUs(rawAtUs, input.fpsNum, input.fpsDen);
  if (mode === "insert" && row?.id === "V1" && input.hit.band === "body" && !boundary && rowClips.length) {
    const over = rowClips.find(clip => pointerUs >= clip.timeline_start_us && pointerUs < clip.timeline_end_us);
    if (over) {
      atUs = pointerUs < (over.timeline_start_us + over.timeline_end_us) / 2 ? over.timeline_start_us : over.timeline_end_us;
    } else {
      const lastEnd = Math.max(0, ...rowClips.map(clip => clip.timeline_end_us));
      if (pointerUs >= lastEnd) atUs = lastEnd;
      else {
        const gapStart = Math.max(0, ...rowClips.filter(clip => clip.timeline_end_us <= pointerUs).map(clip => clip.timeline_end_us));
        const gapEnd = Math.min(...rowClips.filter(clip => clip.timeline_start_us > pointerUs).map(clip => clip.timeline_start_us));
        atUs = Math.min(Math.max(pointerUs, gapStart), gapEnd);
      }
    }
    atUs = snapAssetDropUs(atUs, input.fpsNum, input.fpsDen);
  }
  const frameUs = Math.max(1, Math.round(1_000_000 * (Number.isFinite(input.fpsDen) && input.fpsDen > 0 ? input.fpsDen : 1) /
    (Number.isFinite(input.fpsNum) && input.fpsNum > 0 ? input.fpsNum : 30)));
  const itemDurations = kinds?.map((kind, index) => {
    const measured = input.assetDurationsUs?.[index];
    return measured != null && Number.isFinite(measured) && measured > 0 ? measured : kind === "image" ? 4_000_000 : 1_000_000;
  }) ?? [];
  const previewDurationUs = itemDurations.reduce((sum, duration) => sum + duration, 0) + Math.max(0, itemDurations.length - 1) * frameUs;
  const slot = rowClips.length
    ? rowClips.filter(clip => clip.timeline_start_us < atUs).length
    : Math.max(0, input.defaultSlot ?? 0);
  const conflicts = row && mode === "place" && previewDurationUs > 0 && input.clips.some(clip =>
    clip.track_id === row.id && atUs < clip.timeline_end_us && clip.timeline_start_us < atUs + previewDurationUs);
  const needsNewTrack = input.hasCoordinates === false ? false : zone !== "center" && (!row || !rowCompatible || (mode === "place" && (explicitTrackBand || Boolean(conflicts))));
  const newTrackKind = needsNewTrack ? family : null;
  const familyTracks = input.tracks.filter(track => track.kind === family);
  const familyAnchor = family === "audio"
    ? familyTracks.find(track => track.id === "A1") ?? familyTracks[0]
    : familyTracks.find(track => track.id === "V1") ?? familyTracks[familyTracks.length - 1];
  const newTrackAnchorId = needsNewTrack ? rowCompatible ? row!.id : familyAnchor?.id ?? null : null;
  const newTrackSide = needsNewTrack
    ? rowCompatible && explicitTrackBand ? input.hit.band === "above" ? "before" : "after"
      : family === "audio" ? "after" : "before"
    : null;
  const trackId = input.hasCoordinates === false ? null : needsNewTrack || !row ? "new" : row.id;

  return { targetClipId: targetClip?.clip_id ?? null, hitTrackId: row?.id ?? null, hasCoordinates: input.hasCoordinates !== false, band: input.hit.band, zone, boundary, trackId, newTrackKind, newTrackAnchorId, newTrackSide, mode, locked, accepts, atUs, pointerUs, previewDurationUs, slot: needsNewTrack ? 0 : slot };
}

export function setActiveDraggedAssetIds(ids: readonly string[]): void {
  activeDraggedIds = [...ids];
}

export function getActiveDraggedAssetIds(): readonly string[] {
  return activeDraggedIds;
}

/** The drop handler consumes the native File objects synchronously captured in the drop event. */
export function takeSystemFileDrop(): File[] {
  const files = pendingSystemFiles;
  pendingSystemFiles = [];
  return files;
}

/** Preview can inspect native File metadata after the drop event captured it. */
export function peekSystemFileDrop(): readonly File[] {
  return pendingSystemFiles;
}

/** Restore the File snapshot held by a pending Replace confirmation after global dragend cleanup. */
export function restoreSystemFileDrop(files: readonly File[]): void {
  pendingSystemFiles = [...files];
}

export function clearSystemFileDrop(): void {
  pendingSystemFiles = [];
}

/** OpenFilm uses the current selection when a selected tile starts the drag. */
export function draggedAssetIds<T extends string>(id: T, order: readonly T[], selected: ReadonlySet<T>): T[] {
  return selected.has(id) && selected.size > 1 ? order.filter(item => selected.has(item)) : [id];
}

export function readAssetDrop(transfer: DataTransfer): string[] {
  const types = Array.from(transfer.types ?? []);
  const hasAssetPayload = types.includes(ASSET_BATCH_DRAG) || types.includes(ASSET_DRAG);
  if (hasAssetPayload) {
    let batch = "";
    let single = "";
    try {
      if (types.includes(ASSET_BATCH_DRAG)) batch = transfer.getData(ASSET_BATCH_DRAG);
      if (!batch && types.includes(ASSET_DRAG)) single = transfer.getData(ASSET_DRAG);
    } catch {
      return activeDraggedIds.slice(0, MAX_ASSET_DRAG_ITEMS);
    }
    if (batch) {
      try {
        const parsed: unknown = JSON.parse(batch);
        if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_ASSET_DRAG_ITEMS ||
          !parsed.every(id => typeof id === "string" && id.length > 0 && id.length <= 128)) return [];
        return [...new Set<string>(parsed)].slice(0, MAX_ASSET_DRAG_ITEMS);
      } catch { return []; }
    }
    if (single && single.length <= 128) return [single];
    return activeDraggedIds.slice(0, MAX_ASSET_DRAG_ITEMS);
  }

  if (!types.includes("Files")) return [];
  let files = Array.from(transfer.files ?? []);
  if (!files.length) {
    files = Array.from(transfer.items ?? []).flatMap(item => {
      if (item.kind !== "file") return [];
      try { const file = item.getAsFile(); return file ? [file] : []; } catch { return []; }
    });
  }
  if (!files.length) return [];
  pendingSystemFiles = files;
  return [SYSTEM_FILE_DROP_ID];
}

export function hasAssetDrag(transfer: DataTransfer): boolean {
  // During dragover Chromium exposes transfer types but protects payload data. Do not call getData here.
  const types = Array.from(transfer.types ?? []);
  return types.includes(ASSET_BATCH_DRAG) || types.includes(ASSET_DRAG) || types.includes("Files");
}

export interface AssetDropPlanOptions {
  intent: TimelineAssetDropIntent;
  clips: readonly TimelineClip[];
  linkageEnabled: boolean;
  fpsNum: number;
  fpsDen: number;
}

export function planAssetDrop(
  assets: readonly Asset[], tracks: TimelineDocument["tracks"], slot: number, target?: string,
  overwrite?: { atUs: number }, options?: AssetDropPlanOptions,
): TimelinePatchOperation[] {
  const row = tracks.find(track => track.id === target);
  if (target !== undefined && target !== "new" && !row) throw new Error("目标轨道不存在。");
  if (row?.locked) throw new Error("目标轨道已锁定，无法放入素材。");
  if (!Number.isSafeInteger(slot) || slot < 0) throw new Error("素材落点无效。");
  if (overwrite && (!Number.isSafeInteger(overwrite.atUs) || overwrite.atUs < 0)) throw new Error("覆盖落点无效。");

  if (options) {
    const intent = options.intent;
    if (!intent.accepts || intent.locked) throw new Error("素材落点已变化或目标轨道已锁定。");
    const frameUs = Math.max(1, Math.round(1_000_000 * (options.fpsDen > 0 ? options.fpsDen : 1) / (options.fpsNum > 0 ? options.fpsNum : 30)));
    const durationUs = (asset: Asset) => {
      if (asset.kind === "image") return 4_000_000;
      const measured = asset.media_info?.duration_us;
      return typeof measured === "number" && Number.isSafeInteger(measured) && measured > 0 ? measured : 1_000_000;
    };
    const totalRunUs = assets.reduce((sum, asset, index) => sum + durationUs(asset) + (index + 1 < assets.length ? frameUs : 0), 0);
    const currentTracks = [...tracks];
    const usedIds = new Set(currentTracks.map(track => track.id));
    const operations: TimelinePatchOperation[] = [];
    const familyTrack = new Map<"video" | "audio", string>();
    const allocateTrack = (kind: "video" | "audio"): string => {
      const existing = familyTrack.get(kind);
      if (existing) return existing;
      const prefix = kind === "video" ? "V" : "A";
      let number = kind === "video" ? 2 : 2;
      while (usedIds.has(`${prefix}${number}`)) number += 1;
      const trackId = `${prefix}${number}`;
      usedIds.add(trackId);
      const hintedAnchor = intent.newTrackKind === kind ? intent.newTrackAnchorId : null;
      const hintedSide = intent.newTrackKind === kind ? intent.newTrackSide : null;
      const anchor = hintedAnchor && currentTracks.some(track => track.id === hintedAnchor && track.kind === kind)
        ? hintedAnchor
        : kind === "video" ? "V1" : "A1";
      const side = hintedAnchor === anchor && hintedSide ? hintedSide : kind === "video" ? "before" : "after";
      operations.push({
        op: "add_track", kind, track_id: trackId,
        ...(side === "before" ? { before_track_id: anchor } : { after_track_id: anchor }),
      });
      currentTracks.push({ id: trackId, kind, locked: false, hidden: false, muted: false, solo: false } as TimelineDocument["tracks"][number]);
      familyTrack.set(kind, trackId);
      return trackId;
    };

    const chooseTrack = (kind: "video" | "audio"): string => {
      const alreadyChosen = familyTrack.get(kind);
      if (alreadyChosen) return alreadyChosen;
      const hitRow = intent.hitTrackId ? tracks.find(track => track.id === intent.hitTrackId) : undefined;
      const hintedNew = intent.trackId === "new" && intent.newTrackKind === kind;
      const explicitBand = intent.band !== "body";
      const forcedNew = hintedNew || (!intent.hitTrackId && intent.hasCoordinates) || (explicitBand && intent.trackId === "new");
      const candidates = [
        ...(hitRow?.kind === kind ? [hitRow] : []),
        ...tracks.filter(track => track.kind === kind && track.id !== hitRow?.id),
      ];
      const compatible = candidates.find(track => {
        if (track.locked) return false;
        if (options.intent.mode !== "place") return true;
        const collides = options.clips.some(clip => clip.track_id === track.id && intent.atUs < clip.timeline_end_us && clip.timeline_start_us < intent.atUs + totalRunUs);
        return !collides;
      });
      const shouldCreate = forcedNew || !compatible || (intent.mode === "place" && compatible.id === hitRow?.id && intent.trackId === "new");
      const trackId = shouldCreate ? allocateTrack(kind) : compatible!.id;
      familyTrack.set(kind, trackId);
      return trackId;
    };

    // Pick a compatible row for each media family. Mixed batches keep their order on the ruler while each family
    // remains on a legal typed track; Place opens a typed row when the run would stack on existing clips.
    for (const asset of assets) chooseTrack(asset.kind === "audio" ? "audio" : "video");
    let cursorUs = intent.atUs;
    const atIndexByTrack = new Map<string, number>();
    for (const asset of assets) {
      const kind = asset.kind === "audio" ? "audio" : "video";
      const trackId = familyTrack.get(kind)!;
      const atIndex = atIndexByTrack.get(trackId) ?? (trackId === intent.hitTrackId ? slot : 0);
      atIndexByTrack.set(trackId, atIndex + 1);
      const duration = durationUs(asset);
      operations.push({
        op: "insert_asset_clip", asset_id: asset.asset_id, at_index: atIndex, track_id: trackId,
        ...(asset.kind === "image" ? { duration_us: 4_000_000 } : {}),
        timeline_start_us: cursorUs,
        edit_mode: intent.mode,
        linkage_enabled: options.linkageEnabled,
      });
      cursorUs = Math.ceil((cursorUs + duration) / frameUs - 1e-9) * frameUs;
    }
    return operations;
  }

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
  let overwriteCursorUs = overwrite?.atUs ?? 0;
  for (const asset of assets) {
    const asAudio = asset.kind === "video" && row?.kind === "audio";
    const audio = asAudio || asset.kind === "audio";
    const durationUs = asset.kind === "image" ? 4_000_000 :
      typeof asset.media_info?.duration_us === "number" ? asset.media_info.duration_us : null;
    if (overwrite && (!Number.isInteger(durationUs) || !durationUs || durationUs < 1)) {
      throw new Error(`无法读取素材“${asset.display_name}”的准确时长，覆盖模式已取消。`);
    }
    operations.push({
      op: "insert_asset_clip", asset_id: asset.asset_id, at_index: audio ? 0 : index++,
      ...(audio ? {} : { track_id: visualTrackId }),
      ...(asAudio ? { as_audio: true } : {}),
      ...(asset.kind === "image" ? { duration_us: 4_000_000 } : {}),
      ...(overwrite ? { timeline_start_us: overwriteCursorUs, edit_mode: "overwrite" as const } : {})
    });
    if (overwrite) overwriteCursorUs += durationUs!;
  }
  return operations;
}
