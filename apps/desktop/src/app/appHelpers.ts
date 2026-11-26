import type React from "react";
import type {
  Asset,
  AssetId,
  AssetKind,
  AssetPresentation,
  CaptionPresetId,
  CvSample,
  HorizontalAnchor,
  Job,
  LayoutPolicy,
  MediaInfo,
  ModelSummary,
  RenditionReframeAdjustment,
  TimelineDocument,
  TimelineLayout,
  TimelineState,
  TranscriptSummary,
  VerticalAnchor,
} from "@aivideo/contracts";
import { formatLocalStamp } from "./localTime.js";

export type SaveState = "已保存" | "保存中" | "保存失败" | "草稿冲突";
export type NoticeTone = "success" | "warning" | "error" | "info";
export type Notice = { text: string; tone: NoticeTone } | "";
export type Selection =
  | { kind: "clip"; id: string }
  | { kind: "clips"; ids: string[] }
  | { kind: "caption"; id: string }
  | { kind: "transition"; id: string }
  | { kind: "active-transition"; id: string }
  | null;

export function reconcileTimelineSelection(selection: Selection, state: TimelineState): Selection {
  if (!selection) return null;
  const document = state.current_revision.document;
  if (selection.kind === "clip") return document.clips.some(clip => clip.clip_id === selection.id) ? selection : null;
  if (selection.kind === "caption") return document.captions.some(caption => caption.caption_id === selection.id) ? selection : null;
  if (selection.kind === "transition") return document.transitions?.some(transition => transition.transition_id === selection.id) ? selection : null;
  if (selection.kind === "active-transition") return state.active_transitions.some(transition => transition.transition_id === selection.id) ? selection : null;
  const ids = selection.ids.filter(id => document.clips.some(clip => clip.clip_id === id));
  if (ids.length === selection.ids.length) return selection;
  return ids.length > 1 ? { kind: "clips", ids } : ids.length === 1 ? { kind: "clip", id: ids[0] } : null;
}

export const layouts: { value: TimelineLayout; label: string }[] = [
  { value: "blurred_background", label: "模糊背景" },
  { value: "crop_fill", label: "裁切填满" },
  { value: "fit", label: "完整适配" },
];

export const previewRatios: { value: string; label: string; ratio: number | null }[] = [
  { value: "fit", label: "原始", ratio: null },
  { value: "169", label: "16:9", ratio: 16 / 9 },
  { value: "916", label: "9:16", ratio: 9 / 16 },
  { value: "11", label: "1:1", ratio: 1 },
  { value: "43", label: "4:3", ratio: 4 / 3 },
  { value: "34", label: "3:4", ratio: 3 / 4 },
];

/** 新建项目画布预设（比例真源 = 项目画布）：PlayRes 基准 1080 短边，@30fps。 */
export const projectCanvasPresets: Record<string, { width: number; height: number; fps_num: number; fps_den: number }> = {
  "169": { width: 1920, height: 1080, fps_num: 30, fps_den: 1 },
  "916": { width: 1080, height: 1920, fps_num: 30, fps_den: 1 },
  "11": { width: 1080, height: 1080, fps_num: 30, fps_den: 1 },
  "43": { width: 1440, height: 1080, fps_num: 30, fps_den: 1 },
  "34": { width: 1080, height: 1440, fps_num: 30, fps_den: 1 },
};

export const presets: { value: CaptionPresetId; label: string }[] = [
  { value: "default-bottom", label: "默认底部" },
  { value: "game-safe-bottom", label: "游戏安全区" },
  { value: "high-contrast", label: "高对比" },
];

/** P195：时间线装载瞬时失败的退避序列（下标即第几次重试）——首次 + 2 次，之后如实报错。 */
export const timelineRetryDelaysMs = [1000, 4000];

/** 时间线面板默认高度：视口高的 34%（参照 OpenFilm 录屏 490/1440 ≈ 34%）。
 *  固定值在窗口缩放后就与参照脱节，所以由调用方在窗口 resize 时重算。
 *  下限 220 保证 1080 高以下的窗口里轨道区仍放得下两条轨 + 标尺。 */
export const defaultTimelineHeight = (): number =>
  typeof window === "undefined" ? 320 : Math.round(Math.max(220, window.innerHeight * 0.34));

export const formatTime = (us: number) => {
  const totalSeconds = us / 1_000_000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(Math.floor(seconds)).padStart(2, "0")}`;
  if (minutes > 0) return `${minutes}:${String(Math.floor(seconds)).padStart(2, "0")}`;
  return `${seconds.toFixed(2)}s`;
};

// 剪映式 SMPTE 时间码：HH:MM:SS:FF（FF 为帧号，按画布帧率取整）。
export const formatSmpteTimecode = (us: number, fps: number) => {
  const safeFps = fps > 0 ? fps : 30;
  const totalSeconds = Math.max(0, us) / 1_000_000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const frames = Math.min(Math.round(safeFps) - 1, Math.floor((totalSeconds - Math.floor(totalSeconds)) * safeFps));
  // 参照 timecode.ts:143-145：<1h 的影片省略小时位（00:05:12），≥1h 才补回并保持宽度稳定。
  const hh = `${String(hours).padStart(2, "0")}:`;
  const head = us >= 3_600_000_000 ? hh : "";
  return `${head}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
};

export const duration = (document?: TimelineDocument) =>
  document?.clips.reduce((max, clip) => Math.max(max, clip.timeline_end_us), 0) ?? 0;

export const formatRulerTime = (us: number) => {
  const totalSeconds = us / 1_000_000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (hours > 0) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

export function buildClipFrames(url: string | null, assetKind: AssetKind, sourceStartUs: number, sourceEndUs: number, pps: number): { kind: "video" | "image"; src: string }[] {
  if (!url) return [];
  if (assetKind === "image") return [{ kind: "image", src: url }];
  if (assetKind !== "video") return [];
  const sourceDurationUs = sourceEndUs - sourceStartUs;
  if (sourceDurationUs <= 0) return [];
  const widthPx = (sourceDurationUs / 1_000_000) * pps;
  const count = Math.max(1, Math.min(16, Math.round(widthPx / 56)));
  const frames: { kind: "video"; src: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    const tUs = sourceStartUs + ((i + 0.5) * sourceDurationUs) / count;
    frames.push({ kind: "video", src: `${url}#t=${tUs / 1_000_000}` });
  }
  return frames;
}

export const assetKinds: AssetKind[] = ["video", "audio", "image", "text"];
export const assetKindLabels: Record<AssetKind, string> = { video: "视频", audio: "音频", image: "图片", text: "文本" };
export type AssetFilter = "all" | AssetKind;
export const availabilityLabels = { available: "可用", missing: "缺失", changed: "已变更", unsupported: "不支持" } as const;
export const modelStatusLabels: Record<ModelSummary["status"], string> = {
  unavailable: "未安装",
  queued: "排队中",
  downloading: "下载中",
  paused: "已暂停",
  verifying: "校验中",
  ready: "已就绪",
  cancelled: "已取消",
  failed: "下载失败",
  corrupt: "模型文件已损坏",
};
export const jobStatusLabels: Record<Job["status"], string> = {
  queued: "排队中",
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  cancelling: "取消中",
  cancelled: "已取消",
  interrupted: "已中断",
};
// C22 渲染/校验细分阶段标签；未知 phase 原样显示（旧 Core 无 phase 字段时退回 stage 文本）。
export const jobPhaseLabels: Record<string, string> = {
  preparing: "准备中",
  encoding: "编码中",
  validating_probe: "校验（探测）",
  validating_decode: "校验（完整解码）",
  hashing: "完整性哈希",
  publishing: "正在完成发布",
};
export const modelBadgeLabels: Record<ModelSummary["status"], string> = {
  unavailable: "未下载",
  queued: "排队中",
  downloading: "下载中",
  paused: "已暂停",
  verifying: "校验中",
  ready: "就绪",
  cancelled: "已取消",
  failed: "失败",
  corrupt: "已损坏",
};
export const jobKindLabels: Partial<Record<Job["kind"], string>> = {
  transcription: "本地转录",
  proxy: "代理素材",
  portrait_sample: "竖版样本",
  authoritative_preview: "权威预览",
  final_export: "最终导出",
  waveform: "音频波形",
};
export const transcriptStatusLabels: Record<TranscriptSummary["status"], string> = {
  pending: "排队中",
  ready: "就绪",
  stale: "已过期",
  failed: "失败",
};

/** 任务行副标题：同类任务（如多次转录）必须能区分是哪一条。 */
export const jobDetailText = (job: Job, assetName?: string): string => {
  const parts: string[] = [];
  if (assetName) parts.push(assetName);
  // Core 落库的是 UTC ISO 串；直接 slice 会显示 UTC 时间（用户实测
  // 本地 19:25 的事件显示成 11:25）。必须转本地时区后再格式化。
  if (job.created_at) parts.push(formatLocalStamp(job.created_at));
  return parts.join(" · ");
};

// 任务从最后一次可见进度平滑跑到 100% 的收尾窗口（问题1：短片在两次轮询
// 间隔内完成时 56%→成功跳变突兀）。进度条 CSS transition .4s + 完成停留。
export const FINALIZING_MS = 900;
export const formatBytes = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

// ISO 时间 → 相对时间（导出产物行锚点："3 分钟前"比绝对时间戳更易扫读）。
export const formatRelativeTime = (iso: string) => {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(then).toLocaleDateString();
};

// fallback_reason 是 Core 的 API 语义值（encoders.py 硬编码英文串），UI 层映射为
// 中文；未知值原样透出兜底。导出不受影响，仅是编码器选择的补充说明。
export const fallbackReasonLabel = (reason: string) =>
  reason === "hardware encoder smoke test failed; fell back to software" ? "硬件编码不可用，已用软件编码完成" : reason;

export const isTranscribable = (asset: Asset) => (asset.kind === "video" || asset.kind === "audio") && asset.availability === "available";

/** P199 资产集合签名（对账端点用）：只看组成，不看时间戳。素材导入不推进
 *  projects.updated_at（Core projects.py 只有改名/归档/重开 UPDATE projects），
 *  所以 P195 的时间线键在这里不可用——集合变了才是重新装载的唯一信号。
 *  用 sort 后拼串而不是逐位比较：Core 每次 list 返回的列表是服务端顺序。 */
export const assetCollectionSignature = (items: AssetPresentation[]) =>
  items.map(item => String(item.asset.asset_id)).sort().join("|");

/** 对账只取第一页，条数与 loadProjectData 的首屏一致（Core 默认 50、上限 100）。 */
export const assetReconcilePageLimit = 50;

export type RenditionTarget = { key: string; platform_preset_id: string; rendition_preset_id: string; layout_policy: LayoutPolicy };
export type ReframeAnchor = Pick<RenditionReframeAdjustment, "horizontal_anchor" | "vertical_anchor">;
export type ReframeSelections = Record<string, Record<string, ReframeAnchor>>;
export const horizontalAnchors: HorizontalAnchor[] = ["left", "center", "right"];
export const verticalAnchors: VerticalAnchor[] = ["top", "center", "bottom"];
export const anchorLabels: Record<string, string> = {
  "left:top": "左上",
  "center:top": "上",
  "right:top": "右上",
  "left:center": "左",
  "center:center": "中心",
  "right:center": "右",
  "left:bottom": "左下",
  "center:bottom": "下",
  "right:bottom": "右下",
};
export const layoutPolicies: { value: LayoutPolicy; label: string }[] = [
  { value: "preserve_timeline", label: "沿用时间线" },
  { value: "fit_all", label: "完整适配" },
  { value: "crop_fill_all", label: "裁切填满" },
  { value: "blurred_background_all", label: "模糊背景" },
];

export function storedAssetView(projectId: string): "grid" | "list" {
  try {
    return localStorage.getItem(`vortex.asset-view.${projectId}`) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

export function navigateAssetLibrary(event: React.KeyboardEvent<HTMLButtonElement>, view: "grid" | "list") {
  const { key, currentTarget } = event;
  if (!["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End"].includes(key)) return;
  const list = currentTarget.closest(".asset-list");
  if (!list) return;
  const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>(".asset-select"));
  const index = buttons.indexOf(currentTarget);
  const gridColumns = getComputedStyle(list).gridTemplateColumns.trim();
  const columns = view === "grid" && gridColumns ? gridColumns.split(/\s+/).length : 1;
  const steps: Record<string, number> = { ArrowLeft: -1, ArrowUp: -columns, ArrowRight: 1, ArrowDown: columns };
  const target = key === "Home" ? 0 : key === "End" ? buttons.length - 1 : index + steps[key];
  event.preventDefault();
  event.stopPropagation();
  const next = buttons[Math.max(0, Math.min(buttons.length - 1, target))];
  next?.focus();
  return next?.dataset.assetId as AssetId | undefined;
}

export const ASSET_FAVORITES_KEY = "vortexcut.asset-favorites";
export function readAssetFavorites(): AssetId[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(ASSET_FAVORITES_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((id): id is AssetId => typeof id === "string") : [];
  } catch {
    return [];
  }
}

// 素材元信息行：视频=高度p · 帧率fps · 体积；音频=编码 · 体积；图片=体积（时长单独展示在行尾）。
export const assetMediaInfo = (asset: Asset): MediaInfo | undefined =>
  asset.media_info && typeof asset.media_info === "object" && "video_streams" in asset.media_info
    ? (asset.media_info as MediaInfo)
    : undefined;

export const formatAssetSize = (bytes: number) =>
  bytes >= 1_073_741_824 ? `${(bytes / 1_073_741_824).toFixed(1)} GB` : bytes >= 1_048_576 ? `${Math.round(bytes / 1_048_576)} MB` : `${Math.max(1, Math.round(bytes / 1_024))} KB`;

export const assetMetaText = (asset: Asset) => {
  const info = assetMediaInfo(asset);
  const size = formatAssetSize(asset.size_bytes);
  if (asset.kind === "video") {
    const stream = info?.video_streams?.[0];
    const fps = stream?.avg_frame_rate_num && stream?.avg_frame_rate_den ? Math.round(stream.avg_frame_rate_num / stream.avg_frame_rate_den) : undefined;
    return [stream?.height ? `${stream.height}p` : null, fps ? `${fps}fps` : null, size].filter(Boolean).join(" · ") || size;
  }
  if (asset.kind === "audio") {
    const codec = info?.audio_streams?.[0]?.codec;
    return [codec ? codec.toUpperCase() : null, size].filter(Boolean).join(" · ") || size;
  }
  return size;
};

export const assetDurationLabel = (asset: Asset) => {
  const info = assetMediaInfo(asset);
  if (!info?.duration_us) return "—";
  const total = Math.round(info.duration_us / 1_000_000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

export const cvSparkPath = (samples: CvSample[], key: "motion_energy" | "audio_energy"): string => {
  if (samples.length < 2) return "";
  const maxT = samples[samples.length - 1].timestamp_us || 1;
  return samples.map((s, i) => `${i === 0 ? "M" : "L"}${(s.timestamp_us / maxT * 100).toFixed(2)},${(1 - Math.min(1, s[key])).toFixed(3)}`).join(" ");
};

export function toggle(items: string[], id: string) {
  return items.includes(id) ? items.filter(item => item !== id) : [...items, id];
}
