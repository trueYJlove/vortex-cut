/** 剪映式导出弹窗（2026-09-23 · v5 剪映式导出弹窗设计）。
 *  Hero 组（封面 + 项目信息 + 文件名）/ 设置组（分辨率 × 帧率 × 画质 × 编码 +
 *  保存位置）/ 右侧比例结果卡 / 底栏警示行。
 *
 *  分辨率与比例正交：比例管画面形状（基准尺寸表与 Core plan.py
 *  OUTPUT_RATIO_DIMENSIONS.final_export 同步），分辨率管短边像素；
 *  "original" 档由调用方解析素材最大短边传入（未知时结果卡显示"跟随素材"）。
 *  文件名联动：已有授权（grant）时输入防抖 400ms 走 rename 桥同步目标路径，
 *  点导出时强制 flush 待发的 rename（失败则中止导出）；无授权时文件名仅
 *  作为保存对话框 defaultPath。 */
import { useEffect, useState } from "react";
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
  const [submitting, setSubmitting] = useState(false);

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

  // 导出前 flush：防抖 400ms 内点导出时 rename 尚未发出（弹窗卸载即取消），
  // 这里强制补一次同步——文件名以输入框为准，同步失败则不导出。
  const submit = async () => {
    if (busy || submitting || !sanitize(fileName)) return;
    setSubmitting(true);
    try {
      let effective = grant;
      const safe = sanitize(fileName);
      if (grant && grant.display_name !== `${safe}.mp4`) {
        try {
          effective = await window.desktop.renameExportDestination({ grant_id: grant.destination_grant_id, file_name: safe });
          setGrant(effective);
        } catch (error) {
          setRenameError(safeErrorMessage(error, "文件名同步失败"));
          return;
        }
      }
      await onExport(effective, { fileName: safe, resolution, frameRate, quality });
    } finally {
      setSubmitting(false);
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
    <Dialog titleId="export-video-title" title="导出视频" subtitle={<>当前 Revision · {previewReady ? "画面内容与权威预览一致" : "画面内容以时间线为准"}</>} closeLabel="关闭导出弹窗" footer={<>
        <span className="footer-note">
          {previewReady
            ? "导出完成后可在「渲染与导出」面板查看进度与产物"
            : <span className="warn">权威预览尚未生成——画面以时间线为准，建议先预览确认效果</span>}
        </span>
        <button type="button" className="btn primary" disabled={busy || submitting || !sanitize(fileName)} onClick={() => void submit()}>
          {busy || submitting ? "提交中…" : "导出"}
        </button>
      </>} label="导出视频" onClose={onClose} className="export-modal">
        <div className="project-strip">
          <button type="button" className="project-cover" title="点击设置项目封面" onClick={onOpenCover}>
            {coverUrl ? <img src={coverUrl} alt="项目封面" /> : <svg viewBox="0 0 160 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect width="160" height="100" fill="#1c2827" /><path d="M0 76 40 25l28 36 28-45 64 66v18H0Z" fill="#53635a" /><path d="M0 86 49 54l35 19 34-26 42 30v23H0Z" fill="#75806d" /></svg>}
            <span>设置封面</span>
          </button>
          <div>
            <div className="project-name">项目：{projectName}</div>
            <div className="project-stats">
              <span>时长 <b>{hh}:{mm}:{ss}</b></span>
              <span>片段 <b>{clipCount}</b></span>
              <span>字幕 <b>{captionCount}</b></span>
            </div>
            <div className="filename">
              <input id="export-filename-input" aria-label="导出文件名" value={fileName} maxLength={120} onChange={event => setFileName(event.target.value)} />
              <span className="file-ext">.mp4</span>
            </div>
          </div>
        </div>

        <h3 className="section-label">输出设置 <span>H.264 / MP4</span></h3>
        <div className="export-grid">
          <div className="form-grid">
            <div className="field">
              <label>分辨率 <span className="field-hint">输出像素尺寸</span></label>
              <select aria-label="导出分辨率" value={resolution} onChange={event => onResolutionChange(event.target.value as ExportResolution)}>
                {RESOLUTION_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label} · {resolutionHint(option.value)}</option>)}
              </select>
            </div>
            <div className="field">
              <label>帧率 <span className="field-hint">恒定帧率</span></label>
              <select aria-label="导出帧率" value={frameRate} onChange={event => onFrameRateChange(Number(event.target.value) as ExportFrameRate)}>
                {[24, 25, 30, 60].map(rate => <option key={rate} value={rate}>{rate} fps</option>)}
              </select>
            </div>
            <div className="field">
              <label>画质 <span className="field-hint">码率分层</span></label>
              <select aria-label="导出画质" value={quality} onChange={event => onQualityChange(event.target.value as ExportQuality)}>
                {QUALITY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label} · ≈{Math.round(bitrate / QUALITY_MULTIPLIER[quality] * QUALITY_MULTIPLIER[option.value])} Mbps</option>)}
              </select>
            </div>
            <div className="field">
              <label>编码 <span className="field-hint">硬件失败自动回退</span></label>
              <select aria-label="导出编码" value={encoderMode} onChange={event => onEncoderModeChange(event.target.value as EncoderMode)}>
                <option value="auto">H.264 · 自动（硬件优先）</option>
                <option value="software">H.264 · 软件编码</option>
              </select>
            </div>
            <div className="field span-2">
              <label>保存位置 <span className="field-hint">完整路径预览</span></label>
              <div className="path-control">
                <div className="path-value">
                  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>
                  {grant ? <>{grant.directory_display ? `${grant.directory_display}\\` : ""}<span>{grant.display_name}</span></> : <span>尚未选择——导出时将弹出保存对话框</span>}
                </div>
                <button type="button" className="btn small secondary" disabled={choosing} onClick={() => void chooseDestination()}>{grant ? "更换" : "选择…"}</button>
              </div>
              {renameError && <p className="field-error" role="status">{renameError}</p>}
            </div>
          </div>
          <aside className="ratio-panel">
            <div className="ratio-frame">{ratioLabelText(ratio, dims).split(" ")[0]}</div>
            <div className="ratio-name">{ratioLabelText(ratio, dims)}</div>
            <div className="ratio-dim">{outW} × {outH}</div>
            <div className="ratio-sub">{frameRate}fps · H.264<br />≈{bitrate} Mbps</div>
          </aside>
        </div>
    </Dialog>
  );
}