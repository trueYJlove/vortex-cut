/** 剪映式导出弹窗（2026-09-23 · v5 设计稿 docs/ui-mockups/export-dialog.html）。
 *  Hero 组（封面 + 项目信息 + 文件名）/ 设置组（分辨率 × 帧率 × 画质 × 编码 +
 *  保存位置）/ 右侧比例结果卡 / 底栏警示行。
 *
 *  分辨率与比例正交：比例管画面形状（基准尺寸表与 Core plan.py
 *  OUTPUT_RATIO_DIMENSIONS.final_export 同步），分辨率管短边像素；
 *  "original" 档由调用方解析素材最大短边传入（未知时结果卡显示"跟随素材"）。
 *  文件名联动：已有授权（grant）时输入防抖 400ms 走 rename 桥同步目标路径；
 *  无授权时文件名仅作为保存对话框 defaultPath。 */
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Dialog } from "./Dialog.js";
import { safeErrorMessage } from "./safeErrors.js";
import type { DestinationGrant, EncoderMode, ExportFrameRate, ExportQuality, ExportResolution, OutputRatio, ProjectId } from "@aivideo/contracts";

/** 比例 → 导出基准尺寸（1080p 短边锚点；与 Core plan.py 表一致）。 */
const RATIO_BASE_EXPORT: Record<string, readonly [number, number]> = {
  "169": [1920, 1080], "916": [1080, 1920], "11": [1440, 1440], "43": [1664, 1248], "34": [1248, 1664],
};
const RESOLUTION_SHORT_EDGE: Record<Exclude<ExportResolution, "original">, number> = {
  "480p": 480, "720p": 720, "1080p": 1080, "2k": 1440, "4k": 2160,
};
const RESOLUTION_OPTIONS: Array<{ value: ExportResolution; label: string }> = [
  { value: "480p", label: "480P" }, { value: "720p", label: "720P" }, { value: "1080p", label: "1080P" },
  { value: "2k", label: "2K" }, { value: "4k", label: "4K" }, { value: "original", label: "原始" },
];
const QUALITY_OPTIONS: Array<{ value: ExportQuality; label: string }> = [
  { value: "standard", label: "标准" }, { value: "high", label: "高清" }, { value: "ultra", label: "超清" },
];
const QUALITY_MULTIPLIER: Record<ExportQuality, number> = { standard: 1, high: 1.5, ultra: 2.2 };

/** 短边口径缩放（偶数对齐，与 Core _resolution_dimensions 逐位一致）。 */
export function scaledDimensions(base: readonly [number, number], shortEdge: number): [number, number] {
  const [w, h] = base;
  const baseShort = Math.min(w, h);
  if (baseShort <= 0 || shortEdge <= 0) return [w, h];
  const scale = shortEdge / baseShort;
  const even = (value: number) => { const rounded = Math.max(2, Math.round(value)); return rounded - (rounded % 2); };
  return [even(w * scale), even(h * scale)];
}

function ratioBase(ratio: OutputRatio, canvas: { width: number; height: number }): [number, number] {
  if (ratio === "fit") return [canvas.width, canvas.height];
  return [...(RATIO_BASE_EXPORT[ratio] ?? [1920, 1080])] as [number, number];
}

function gcd(a: number, b: number): number { return b === 0 ? a : gcd(b, a % b); }

export function ratioLabelText(ratio: OutputRatio, dims: readonly [number, number]): string {
  const [w, h] = dims;
  const g = gcd(w, h) || 1;
  const shape = `${w / g}:${h / g}`;
  if (ratio === "fit") return `${shape} ${w >= h ? "横屏" : "竖屏"}`;
  const named: Record<string, string> = { "169": "16:9 横屏", "916": "9:16 竖屏", "11": "1:1 方形", "43": "4:3 传统", "34": "3:4 竖传统" };
  return named[ratio] ?? `${shape} ${w >= h ? "横屏" : "竖屏"}`;
}

/** 码率估算（与 Core ffmpeg.py 基线公式一致）：auto=硬件优先基线 12M@1080p。 */
export function estimateBitrateMbps(shortEdge: number, encoderMode: EncoderMode, quality: ExportQuality): number {
  const base = encoderMode === "auto" ? Math.max(4, Math.round(12 * (shortEdge / 1080) ** 2)) : Math.max(3, Math.round(10 * (shortEdge / 1080) ** 2));
  return Math.round(base * QUALITY_MULTIPLIER[quality] * 10) / 10;
}

export interface ExportSettings {
  fileName: string;
  resolution: ExportResolution;
  frameRate: ExportFrameRate;
  quality: ExportQuality;
}

export function ExportDialog({ projectId, projectName, durationUs, clipCount, captionCount, canvas, ratio, coverUrl, previewReady, encoderMode, onEncoderModeChange, quality, onQualityChange, resolution, onResolutionChange, frameRate, onFrameRateChange, originalShortEdge, busy, onClose, onOpenCover, onExport }: {
  projectId: ProjectId;
  projectName: string;
  durationUs: number;
  clipCount: number;
  captionCount: number;
  canvas: { width: number; height: number };
  ratio: OutputRatio;
  coverUrl: string | null;
  previewReady: boolean;
  encoderMode: EncoderMode;
  onEncoderModeChange: (mode: EncoderMode) => void;
  quality: ExportQuality;
  onQualityChange: (quality: ExportQuality) => void;
  resolution: ExportResolution;
  onResolutionChange: (resolution: ExportResolution) => void;
  frameRate: ExportFrameRate;
  onFrameRateChange: (frameRate: ExportFrameRate) => void;
  originalShortEdge: number | null;
  busy: boolean;
  onClose: () => void;
  onOpenCover: () => void;
  onExport: (grant: DestinationGrant | null, settings: ExportSettings) => Promise<void>;
}) {
  const sanitize = (name: string) => name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "");
  const [fileName, setFileName] = useState(() => sanitize(projectName) || "video");
  const [grant, setGrant] = useState<DestinationGrant | null>(null);
  const [renameError, setRenameError] = useState("");
  const [choosing, setChoosing] = useState(false);

  // 文件名 → 授权目标路径联动（防抖 400ms；仅换文件名、目录不变）。
  const grantId = grant?.destination_grant_id;
  useEffect(() => {
    if (!grantId) return;
    const safe = sanitize(fileName);
    if (!safe) return;
    const timer = setTimeout(() => {
      if (grant && grant.display_name === `${safe}.mp4`) return;
      void window.desktop.renameExportDestination({ grant_id: grantId, file_name: safe }).then(updated => {
        setGrant(updated);
        setRenameError("");
      }).catch(error => setRenameError(safeErrorMessage(error, "文件名同步失败")));
    }, 400);
    return () => clearTimeout(timer);
  }, [fileName, grantId]);

  const chooseDestination = async () => {
    setChoosing(true);
    try {
      const selected = await window.desktop.chooseExportDestination(projectId, sanitize(fileName) || "video");
      if (selected) { setGrant(selected); setRenameError(""); }
    } catch (error) {
      setRenameError(safeErrorMessage(error, "选择保存位置失败"));
    } finally {
      setChoosing(false);
    }
  };

  const base = ratioBase(ratio, canvas);
  const effectiveShortEdge = resolution === "original" ? (originalShortEdge ?? Math.min(...base)) : RESOLUTION_SHORT_EDGE[resolution as Exclude<ExportResolution, "original">];
  const dims = resolution === "original" && originalShortEdge === null ? base : scaledDimensions(base, effectiveShortEdge);
  const [outW, outH] = dims;
  const bitrate = estimateBitrateMbps(Math.min(outW, outH), encoderMode, quality);
  const totalSeconds = Math.max(0, Math.round(durationUs / 1_000_000));
  const hh = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const mm = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const ss = String(totalSeconds % 60).padStart(2, "0");
  const resolutionHint = (option: ExportResolution): string => {
    if (option === "original") return originalShortEdge !== null ? `${scaledDimensions(base, originalShortEdge).join("×")}` : "跟随素材最大分辨率";
    return scaledDimensions(base, RESOLUTION_SHORT_EDGE[option]).join("×");
  };

  return (
    <Dialog titleId="export-video-title" label="导出视频" onClose={onClose} className="export-modal">
      <div className="modal-heading">
        <div>
          <h2 id="export-video-title">导出视频</h2>
          <p>当前 Revision · {previewReady ? "画面内容与权威预览一致" : "画面内容以时间线为准"}</p>
        </div>
        <button type="button" className="icon-btn" title="关闭导出弹窗" aria-label="关闭导出弹窗" onClick={onClose}><X size={15} /></button>
      </div>
      <div className="exd-body">
        <div className="exd-hero">
          <button type="button" className="exd-cover" title="点击设置项目封面" onClick={onOpenCover}>
            {coverUrl ? <img src={coverUrl} alt="项目封面" /> : <span className="exd-cover-ph">项目封面</span>}
            <span className="exd-cover-chip">✎ 设置封面</span>
          </button>
          <div className="exd-hero-right">
            <div className="exd-proj-name">项目：{projectName}</div>
            <div className="exd-proj-stats">
              <span>时长 <b>{hh}:{mm}:{ss}</b></span>
              <span>片段 <b>{clipCount}</b></span>
              <span>字幕 <b>{captionCount}</b></span>
            </div>
            <div className="exd-filename-block">
              <label htmlFor="exd-filename-input">导出文件名</label>
              <div className="exd-filename-line">
                <input id="exd-filename-input" className="exd-filename-input" value={fileName} maxLength={120}
                  onChange={event => setFileName(event.target.value)} />
                <span className="exd-ext-chip">.mp4</span>
              </div>
            </div>
          </div>
        </div>
        <hr className="exd-divider" />
        <div className="exd-settings">
          <div className="exd-settings-left">
            <div className="exd-field">
              <label>分辨率 <span className="exd-hint">输出像素尺寸</span></label>
              <select aria-label="导出分辨率" value={resolution} onChange={event => onResolutionChange(event.target.value as ExportResolution)}>
                {RESOLUTION_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label} · {resolutionHint(option.value)}</option>)}
              </select>
            </div>
            <div className="exd-field">
              <label>帧率 <span className="exd-hint">恒定帧率</span></label>
              <select aria-label="导出帧率" value={frameRate} onChange={event => onFrameRateChange(Number(event.target.value) as ExportFrameRate)}>
                {[24, 25, 30, 60].map(rate => <option key={rate} value={rate}>{rate} fps</option>)}
              </select>
            </div>
            <div className="exd-field">
              <label>画质 <span className="exd-hint">码率分层</span></label>
              <select aria-label="导出画质" value={quality} onChange={event => onQualityChange(event.target.value as ExportQuality)}>
                {QUALITY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label} · ≈{Math.round(bitrate / QUALITY_MULTIPLIER[quality] * QUALITY_MULTIPLIER[option.value])} Mbps</option>)}
              </select>
            </div>
            <div className="exd-field">
              <label>编码 <span className="exd-hint">硬件失败自动回退</span></label>
              <select aria-label="导出编码" value={encoderMode} onChange={event => onEncoderModeChange(event.target.value as EncoderMode)}>
                <option value="auto">H.264 · 自动（硬件优先）</option>
                <option value="software">H.264 · 软件编码</option>
              </select>
            </div>
            <div className="exd-field exd-wide">
              <label>保存位置 <span className="exd-hint">完整路径预览</span></label>
              <div className="exd-dest-row">
                <div className="exd-dest-path">
                  <span className="exd-dest-icon" aria-hidden>📁</span>
                  {grant ? <>{grant.directory_display ? `${grant.directory_display}\\` : ""}<span className="exd-dest-fname">{grant.display_name}</span></> : <span className="exd-dest-none">尚未选择——导出时将弹出保存对话框</span>}
                </div>
                <button type="button" className="exd-dest-change" disabled={choosing} onClick={() => void chooseDestination()}>{grant ? "更换" : "选择…"}</button>
              </div>
              {renameError && <p className="exd-dest-error" role="status">{renameError}</p>}
            </div>
          </div>
          <div className="exd-ratio-card">
            <div className={`exd-ratio-canvas${outW >= outH ? " landscape" : " portrait"}`}>{ratioLabelText(ratio, dims).split(" ")[0]}</div>
            <div className="exd-ratio-name">{ratioLabelText(ratio, dims)}</div>
            <div className="exd-ratio-dim">{outW} × {outH}</div>
            <div className="exd-ratio-sub">{frameRate}fps · H.264 · ≈{bitrate} Mbps</div>
          </div>
        </div>
      </div>
      <div className="modal-actions">
        <span className="exd-foot-info">
          {previewReady
            ? "导出完成后可在「渲染与导出」面板查看进度与产物"
            : <span className="exd-warn">权威预览尚未生成——画面以时间线为准，建议先预览确认效果</span>}
        </span>
        <button type="button" disabled={busy || !sanitize(fileName)} onClick={() => void onExport(grant, { fileName: sanitize(fileName), resolution, frameRate, quality })}>
          {busy ? "提交中…" : "导出"}
        </button>
      </div>
    </Dialog>
  );
}