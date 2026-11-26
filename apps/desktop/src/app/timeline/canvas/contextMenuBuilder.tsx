import { Link2, Link2Off } from "lucide-react";
import type {
  ActiveTimelineTransition,
  TimelineClip,
  TimelineClipId,
  TimelineDocument,
  TimelinePatchOperation,
  TimelineTrack,
} from "@aivideo/contracts";
import type { ContextMenuEntry } from "../../../ui/of/ContextMenu.js";
import { clearActiveTransitionOperations } from "../active-transition-edit.js";
import { closeGapAt } from "../close-gap.js";
import { TRACK_SIZES, type TrackRowLayout } from "../geometry.js";
import { planCompactMainTrack, planMagneticDelete, planMagneticMove, planRippleDelete } from "../magnetic-plan.js";
import { splitClipAt } from "../split-point.js";
import type { TimelineRuntimePrefs, TimelineSelection } from "../types.js";

export type CanvasContextMenuTarget =
  | { kind: "clip"; clipId: TimelineClipId }
  | { kind: "caption"; captionId: string }
  | { kind: "transition"; transitionId: string }
  | { kind: "active-transition"; transitionId: string }
  | { kind: "empty"; trackId: string | null };

export interface TimelineCanvasContextMenuState {
  x: number;
  y: number;
  target: CanvasContextMenuTarget;
  timeUs: number;
}

export interface TrackContextMenuState {
  trackId: string;
  x: number;
  y: number;
  trigger: HTMLElement;
}

const canChangeClipSpeed = (clip: TimelineClip): boolean =>
  (clip.asset_kind === "video" || clip.asset_kind === "audio")
  && clip.source_start_us != null
  && clip.source_end_us != null
  && clip.source_end_us > clip.source_start_us;

export function buildTrackContextMenuItems(opts: {
  trackId: string;
  tracks: readonly TimelineTrack[];
  trackRows: readonly TrackRowLayout[];
  clips: readonly TimelineClip[];
  prefs: TimelineRuntimePrefs;
  isClipLocked: (clipId: TimelineClipId, alone?: boolean) => boolean;
  resizeTrack: (trackId: string, height: number | null, done: boolean) => void;
  patchTrackFlags: (trackId: string, flags: { locked?: boolean; hidden?: boolean; muted?: boolean; solo?: boolean }) => void;
  onPatch: (operations: TimelinePatchOperation[], summary: string) => Promise<void> | void;
  close: () => void;
}): ContextMenuEntry[] {
  const { trackId, tracks, trackRows, clips, prefs, isClipLocked, resizeTrack, patchTrackFlags, onPatch, close } = opts;
  const track = tracks.find((item) => item.id === trackId);
  const members = clips.filter((clip) => clip.track_id === trackId);
  const fixed = trackId === "V1" || trackId === "A1" || trackId === "C1";
  const disabled = !track || track.locked || members.some((clip) => isClipLocked(clip.clip_id));
  const height = trackRows.find((row) => row.track.id === trackId)?.height;
  const sizeKind = track?.kind === "audio" ? "audio" : track?.kind === "video" ? "visual" : null;
  const presetItems: ContextMenuEntry[] = sizeKind
    ? (["small", "medium", "large"] as const).map((size) => ({
        id: `height-${size}`,
        label: `轨道高度：${size === "small" ? "小" : size === "medium" ? "中" : "大"}`,
        note: `${TRACK_SIZES[size][sizeKind]} px`,
        checked: height === TRACK_SIZES[size][sizeKind],
        onSelect: () => {
          resizeTrack(trackId, TRACK_SIZES[size][sizeKind], true);
          close();
        },
      }))
    : [];

  return [
    ...(track
      ? [
          {
            id: "toggle-lock",
            label: track.locked ? "解锁轨道" : "锁定轨道",
            checked: track.locked,
            onSelect: () => {
              patchTrackFlags(track.id, { locked: !track.locked });
              close();
            },
          },
          {
            id: "toggle-hidden",
            label: track.hidden ? "显示轨道" : "隐藏轨道",
            checked: track.hidden,
            onSelect: () => {
              patchTrackFlags(track.id, { hidden: !track.hidden });
              close();
            },
          },
          ...(track.kind !== "text"
            ? [
                {
                  id: "toggle-muted",
                  label: track.muted ? "开启声音" : "关闭声音",
                  checked: track.muted,
                  onSelect: () => {
                    patchTrackFlags(track.id, { muted: !track.muted });
                    close();
                  },
                },
                {
                  id: "toggle-solo",
                  label: track.solo ? "取消独奏" : "独奏",
                  checked: track.solo,
                  onSelect: () => {
                    patchTrackFlags(track.id, { solo: !track.solo });
                    close();
                  },
                },
              ]
            : []),
        ]
      : []),
    ...(track && (presetItems.length || height !== undefined) ? [{ id: "track-options-separator", separator: true as const }] : []),
    ...presetItems,
    ...(track && height !== undefined
      ? [
          {
            id: "height-default",
            label: "恢复默认高度",
            checked: !prefs.trackHeights[trackId],
            onSelect: () => {
              resizeTrack(trackId, null, true);
              close();
            },
          },
        ]
      : []),
    ...(members.length && !fixed ? [{ id: "delete-track-separator", separator: true as const }] : []),
    ...(members.length && !fixed
      ? [
          {
            id: "delete-track",
            label: "删除轨道",
            danger: true,
            disabled,
            hint: disabled ? "轨道或轨道中的片段已锁定" : undefined,
            onSelect: () => {
              void onPatch([{ op: "remove_track", track_id: trackId }], "删除轨道");
              close();
            },
          },
        ]
      : []),
  ];
}

export function buildCanvasContextMenuItems(opts: {
  menu: TimelineCanvasContextMenuState;
  document?: TimelineDocument;
  clips: readonly TimelineClip[];
  selectedClips: TimelineClip[];
  activeTransitions: readonly ActiveTimelineTransition[];
  playheadUs: number;
  prefs: TimelineRuntimePrefs;
  speedModeKey: string | null;
  setSpeedModeKey: (updater: (current: string | null) => string | null) => void;
  isClipLocked: (clipId: TimelineClipId, alone?: boolean) => boolean;
  canLinkMembers: boolean;
  linkMembers: readonly TimelineClip[];
  unlinkRepresentatives: readonly TimelineClip[];
  onPatch: (operations: TimelinePatchOperation[], summary: string) => Promise<void> | void;
  onSeek?: (timeUs: number) => void;
  onCommand?: (commandId: string) => void;
  setSelection: (selection: TimelineSelection) => void;
  addTrack: (kind: "video" | "text") => void;
  fitToContent: () => void;
  updateTimelinePrefs: (update: (current: TimelineRuntimePrefs) => TimelineRuntimePrefs) => void;
  closeMenu: () => void;
}): ContextMenuEntry[] {
  const {
    menu,
    document,
    clips,
    selectedClips,
    activeTransitions,
    playheadUs,
    prefs,
    speedModeKey,
    setSpeedModeKey,
    isClipLocked,
    canLinkMembers,
    linkMembers,
    unlinkRepresentatives,
    onPatch,
    onSeek,
    onCommand,
    setSelection,
    addTrack,
    fitToContent,
    updateTimelinePrefs,
    closeMenu,
  } = opts;
  const target = menu.target;
  const close = (fn: () => void) => () => {
    fn();
    closeMenu();
  };

  if (target.kind === "clip") {
    const clip = clips.find((c) => c.clip_id === target.clipId);
    if (!clip) return [];
    const locked = isClipLocked(clip.clip_id);
    const clipItselfLocked = Boolean(document?.locked_elements?.includes(clip.clip_id));
    const deleteTargets = selectedClips.some((item) => item.clip_id === clip.clip_id) ? selectedClips : [clip];
    const magneticDelete = document && prefs.mainTrackMagnet && clip.track_id === "V1"
      ? planMagneticDelete(document, deleteTargets, prefs.linkageEnabled)
      : undefined;
    const ripple = document ? planRippleDelete(document, deleteTargets, prefs.linkageEnabled) : { operations: [] };
    const magneticMove = document && clip.track_id === "V1" ? planMagneticMove(document, clip.clip_id, playheadUs, true) : { operations: [] };
    const split = splitClipAt(clip, playheadUs, document);
    const visualClip = clip.asset_kind === "video" || clip.asset_kind === "image";
    const visualFactItems: ContextMenuEntry[] = visualClip
      ? [
          {
            id: "picture-fade-in",
            label: clip.picture_fade_in_us ? "清除画面淡入" : "添加画面淡入（0.5 秒）",
            disabled: locked,
            onSelect: close(() =>
              void onPatch(
                [{ op: "set_clip_transition_facts", clip_id: clip.clip_id, picture_fade_in_us: clip.picture_fade_in_us ? null : 500_000 }],
                clip.picture_fade_in_us ? "清除画面淡入" : "添加画面淡入",
              ),
            ),
          },
          {
            id: "picture-fade-out",
            label: clip.picture_fade_out_us ? "清除画面淡出" : "添加画面淡出（0.5 秒）",
            disabled: locked,
            onSelect: close(() =>
              void onPatch(
                [{ op: "set_clip_transition_facts", clip_id: clip.clip_id, picture_fade_out_us: clip.picture_fade_out_us ? null : 500_000 }],
                clip.picture_fade_out_us ? "清除画面淡出" : "添加画面淡出",
              ),
            ),
          },
        ]
      : [];
    const moveFactItem: ContextMenuEntry | null = clip.asset_kind === "video"
      ? {
          id: "picture-move-in",
          label: clip.move_in ? "清除进入运动" : "添加推入进入（0.5 秒）",
          disabled: locked,
          onSelect: close(() =>
            void onPatch(
              [{ op: "set_clip_transition_facts", clip_id: clip.clip_id, move_in: clip.move_in ? null : { preset_id: "motions/move-push-left", duration_us: 500_000 } }],
              clip.move_in ? "清除进入运动" : "添加进入运动",
            ),
          ),
        }
      : null;
    const pickedIds = selectedClips.some((item) => item.clip_id === clip.clip_id)
      ? selectedClips.map((item) => item.clip_id)
      : clip.link_group_id
        ? clips.filter((item) => item.link_group_id === clip.link_group_id).map((item) => item.clip_id)
        : [clip.clip_id];
    const pickedKey = [...pickedIds].sort().join("|");
    const pickedSpeedClips = pickedIds.map((id) => clips.find((item) => item.clip_id === id)).filter((item): item is TimelineClip => Boolean(item));
    const speedable = pickedSpeedClips.some(canChangeClipSpeed);
    const speedLocked = pickedSpeedClips.some((item) => isClipLocked(item.clip_id, true));
    return [
      {
        id: "split",
        label: "在播放头处拆分",
        disabled: !split,
        hint: split ? undefined : locked ? "片段已锁定" : "播放头不在可拆分区间",
        onSelect: close(() => {
          if (split) void onPatch([split], "在播放头处拆分");
        }),
      },
      { id: "copy", label: "复制", disabled: locked, hint: locked ? "片段已锁定" : undefined, onSelect: close(() => onCommand?.("timeline.copy")) },
      ...(canLinkMembers
        ? [
            {
              id: "link",
              label: "链接片段",
              icon: <Link2 size={14} />,
              disabled: locked,
              hint: locked ? "片段已锁定" : undefined,
              onSelect: close(() => void onPatch([{ op: "set_clip_link", clip_ids: linkMembers.map((item) => item.clip_id) }], "链接片段")),
            },
          ]
        : []),
      ...(unlinkRepresentatives.length
        ? [
            {
              id: "unlink",
              label: "取消片段链接",
              icon: <Link2Off size={14} />,
              disabled: locked,
              hint: locked ? "片段已锁定" : undefined,
              onSelect: close(() =>
                void onPatch(
                  unlinkRepresentatives.map((item) => ({ op: "clear_clip_link" as const, clip_id: item.clip_id })),
                  "取消片段链接",
                ),
              ),
            },
          ]
        : []),
      {
        id: "lock",
        label: clipItselfLocked ? "解锁片段" : "锁定片段",
        onSelect: close(() => void onPatch([{ op: "set_clip_locked", clip_id: clip.clip_id, locked: !clipItselfLocked }], clipItselfLocked ? "解锁片段" : "锁定片段")),
      },
      {
        id: "speed",
        label: "速度",
        checked: speedModeKey === pickedKey,
        disabled: !speedable || speedLocked,
        hint: !speedable ? "只有具有确定源区间的视频/音频片段可以变速" : speedLocked ? "片段或所在轨道已锁定" : undefined,
        onSelect: close(() => setSpeedModeKey((current) => (current === pickedKey ? null : pickedKey))),
      },
      ...(visualFactItems.length || moveFactItem ? [{ id: "source-transition-separator", separator: true as const }, ...visualFactItems, ...(moveFactItem ? [moveFactItem] : [])] : []),
      { id: "sep1", separator: true as const },
      {
        id: "del",
        label: magneticDelete ? "删除并闭合主轨" : "删除片段",
        danger: true,
        disabled: locked || magneticDelete?.operations.length === 0,
        hint: locked ? "片段已锁定" : magneticDelete?.reason,
        onSelect: close(() =>
          void onPatch(magneticDelete?.operations ?? [{ op: "remove_clip", clip_id: clip.clip_id }], magneticDelete ? "主轨磁吸删除" : "删除片段"),
        ),
      },
      {
        id: "ripple-delete",
        label: "波纹删除",
        disabled: locked || !ripple.operations.length,
        hint: locked ? "片段已锁定" : "reason" in ripple ? ripple.reason : undefined,
        onSelect: close(() => void onPatch(ripple.operations, "波纹删除")),
      },
      {
        id: "magnetic-move",
        label: "主轨插入到播放头",
        disabled: !magneticMove.operations.length,
        hint: "reason" in magneticMove ? magneticMove.reason : undefined,
        onSelect: close(() => void onPatch(magneticMove.operations, "主轨插入到播放头")),
      },
      { id: "sep2", separator: true as const },
      { id: "seek", label: "定位播放头", onSelect: close(() => onSeek?.(menu.timeUs)) },
    ];
  }

  if (target.kind === "caption") {
    return [
      { id: "del", label: "删除字幕", danger: true, onSelect: close(() => void onPatch([{ op: "remove_caption", caption_id: target.captionId as never }], "删除字幕")) },
      { id: "sep", separator: true as const },
      { id: "seek", label: "定位播放头", onSelect: close(() => onSeek?.(menu.timeUs)) },
    ];
  }

  if (target.kind === "transition") {
    return [
      { id: "del", label: "删除转场", danger: true, onSelect: close(() => void onPatch([{ op: "remove_transition", transition_id: target.transitionId as never }], "删除转场")) },
    ];
  }

  if (target.kind === "active-transition") {
    const transition = activeTransitions.find((item) => item.transition_id === target.transitionId);
    if (!transition) return [];
    const operations = clearActiveTransitionOperations(transition);
    const blockedHint = transition.kind === "dip-white"
      ? "白闪依赖 Core 的页面帧系统角色，目前只显示、不编辑"
      : transition.kind === "crossfade"
        ? "音频交叉淡化目前只读"
        : undefined;
    return operations.length
      ? [{ id: "clear-active-transition", label: "清除片段转场事实", danger: true, onSelect: close(() => void onPatch(operations, "清除片段转场事实")) }]
      : [{ id: "active-transition-readonly", label: "此转场当前只读", disabled: true, hint: blockedHint }];
  }

  const closeGap = closeGapAt(document, target.trackId, menu.timeUs);
  const compact = document ? planCompactMainTrack(document, true) : { operations: [] };
  const waveformRatios = [
    { value: 1, label: "100%" },
    { value: 0.6, label: "60%" },
    { value: 0.4, label: "40%" },
    { value: 0.3, label: "30%" },
  ] as const;

  return [
    {
      id: "close-gap",
      label: "关闭空隙",
      disabled: !closeGap.length,
      hint: closeGap.length ? undefined : "此处没有可关闭的空隙，或后续片段无法安全移动",
      onSelect: close(() => void onPatch(closeGap, "关闭空隙")),
    },
    {
      id: "compact-main",
      label: "关闭主轨全部空隙",
      disabled: !compact.operations.length,
      hint: "reason" in compact ? compact.reason : undefined,
      onSelect: close(() => void onPatch(compact.operations, "关闭主轨全部空隙")),
    },
    { id: "paste", label: "粘贴到播放头", onSelect: close(() => onCommand?.("timeline.paste")) },
    { id: "sep1", separator: true as const },
    { id: "seek", label: "定位播放头", onSelect: close(() => onSeek?.(menu.timeUs)) },
    { id: "clear", label: "取消选择", onSelect: close(() => setSelection(null)) },
    { id: "sep-timeline-tools", separator: true as const },
    {
      id: "add-track",
      label: "添加轨道",
      submenu: [
        { id: "add-video-track", label: "视频轨道", onSelect: close(() => addTrack("video")) },
        { id: "add-text-track", label: "文本轨道", onSelect: close(() => addTrack("text")) },
      ],
    },
    { id: "fit-content", label: "缩放到全部素材", shortcut: "Shift+Z", onSelect: close(fitToContent) },
    {
      id: "timeline-display-settings",
      label: "显示设置",
      submenu: [
        { id: "track-height-label", label: `默认轨道高度 · ${prefs.trackHeight}px`, disabled: true },
        {
          id: "track-height-down",
          label: "降低 4px",
          disabled: prefs.trackHeight <= 40,
          onSelect: close(() => updateTimelinePrefs((current) => ({ ...current, trackHeight: Math.max(40, current.trackHeight - 4) }))),
        },
        {
          id: "track-height-up",
          label: "增加 4px",
          disabled: prefs.trackHeight >= 128,
          onSelect: close(() => updateTimelinePrefs((current) => ({ ...current, trackHeight: Math.min(128, current.trackHeight + 4) }))),
        },
        {
          id: "track-height-reset",
          label: "恢复默认高度 · 56px",
          checked: prefs.trackHeight === 56,
          onSelect: close(() => updateTimelinePrefs((current) => ({ ...current, trackHeight: 56 }))),
        },
        { id: "display-separator", separator: true as const },
        ...waveformRatios.map(({ value, label }) => ({
          id: `waveform-${label}`,
          label: `波形占比 ${label}`,
          checked: prefs.waveformRatio === value,
          onSelect: close(() => updateTimelinePrefs((current) => ({ ...current, waveformRatio: value }))),
        })),
      ],
    },
  ];
}
