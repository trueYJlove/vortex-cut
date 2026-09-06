/** 合成预览（M3-1）：消费 Core 投影的 preview-ir-v1 逐帧数值表，WebCodecs 解码 +
 * WebGL2 合成的权威级实时预览。子集外语义自动降级回交互预览（PREVIEW_IR_UNSUPPORTED）。 */
import { useEffect, useRef, useState } from "react";
import { parseIr, type Ir } from "./ir.js";
import { PreviewSession, type PreviewSessionMetrics, type SegmentAudioConfig } from "./preview-session.js";
import { SyntheticPipLayer } from "./SyntheticPipLayer.js";

/** 画中画片段编辑态（App 从时间线文档透传；transform 中心点语义）。 */
export interface SyntheticPipClip { clipId: string; transform: { x?: number; y?: number; scale?: number; rotate?: number; opacity?: number } }

export interface SyntheticPreviewProps {
  projectId: string;
  revisionId: string | null;
  /** 画布比例（169/916/11/43/34），App 按项目画布解析。 */
  outputRatio: string;
  /** asset_id → aivideo:// 票据 URL（App 既有素材通道）。 */
  mediaUrls: Map<string, string>;
  /** clip_id → 片段音频配置（编辑态透传；未提供则合成预览静音）。 */
  audioByClip?: Map<string, SegmentAudioConfig>;
  /** 画中画片段（编辑态：合成画布手势层的数据源与提交负载）。 */
  pipClips?: SyntheticPipClip[];
  selectedClipId?: string | null;
  onSelectClip?: (clipId: string) => void;
  onDraftPipMove?: (clipId: string, x: number, y: number) => void;
  onCommitPipMove?: (clipId: string, x: number, y: number) => void;
  onGesturePause?: () => boolean;
  onGestureResume?: (wasPlaying: boolean) => void;
  playing: boolean;
  playheadUs: number;
  onTimeUs: (us: number) => void;
  /** 自然播放到片尾（会话内部已 pause；UI 复位播放按钮）。 */
  onEnded?: () => void;
  onFallback: (reason: string, code: string | null) => void;
}

interface LoadState {
  status: "loading" | "ready" | "error";
  message: string;
}

export function SyntheticPreview(props: SyntheticPreviewProps): React.ReactElement {
  const { projectId, revisionId, mediaUrls, audioByClip, pipClips, selectedClipId, onSelectClip, onDraftPipMove, onCommitPipMove, onGesturePause, onGestureResume, playing, playheadUs, onTimeUs, onEnded, onFallback, outputRatio } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sessionRef = useRef<PreviewSession | null>(null);
  const lastReportedUs = useRef<number>(playheadUs);
  const lastReportWall = useRef<number>(0);
  const [load, setLoad] = useState<LoadState>({ status: "loading", message: "正在加载合成预览" });
  const [metrics, setMetrics] = useState<PreviewSessionMetrics | null>(null);

  // IR 加载 + 会话创建（revision 变更时重建）。
  useEffect(() => {
    let cancelled = false;
    const sessionRefLocal = sessionRef;
    // 预览框尺寸跟踪：合成画布填满预览框、IR 画布 contain 居中（与交互预览同观感）
    const boxObserver = new ResizeObserver(entries => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      const session = sessionRefLocal.current;
      if (!session) return;
      const { width, height } = entry.contentRect;
      if (width > 2 && height > 2) session.resize(width, height);
    });
    setLoad({ status: "loading", message: "正在加载合成预览" });
    sessionRefLocal.current?.dispose();
    sessionRefLocal.current = null;
    (async () => {
      try {
        const payload = await window.desktop.getPreviewIr({
          project_id: projectId as never,
          timeline_revision_id: revisionId,
          output_ratio: outputRatio,
        });
        const ir: Ir = parseIr(payload.ir as unknown as string);
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        // 画布后备缓冲随预览框（contain 居中，见 session.resize）；初始以 IR 画布尺寸起底
        canvas.width = ir.canvas.width;
        canvas.height = ir.canvas.height;
        const session = await PreviewSession.create(canvas, ir, mediaUrls, audioByClip);
        if (cancelled) { session.dispose(); return; }
        session.onTimeUs = (us: number) => {
          lastReportedUs.current = us;
          // 播放头上报节流至 10Hz（与交互预览时钟同频）：App 组件树重渲是主线程
          // 大头，30-60Hz 上报会挤压合成管线（实测丢帧 292 + 音频卡顿）。
          const now = performance.now();
          if (now - lastReportWall.current >= 100 || !session.isPlaying) {
            lastReportWall.current = now;
            onTimeUs(us);
          }
        };
        session.onEnded = () => {
          onTimeUs(lastReportedUs.current); // 结束时冲齐最终播放头
          onEnded?.();
        };
        sessionRefLocal.current = session;
        boxObserver.observe(canvas.parentElement ?? canvas);
        const fontUrl = await window.desktop.captionFontUrl();
        const fontBuffer = await (await fetch(fontUrl)).arrayBuffer();
        await session.loadCaptionFont(fontBuffer);
        await session.seekToFrame(Math.max(0, Math.floor((playheadUs / 1e6) * ir.canvas.fps)));
        setLoad({ status: "ready", message: "" });
        if (playing) session.play();
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        const code = /PREVIEW_IR_UNSUPPORTED/.test(message) ? "PREVIEW_IR_UNSUPPORTED" : null;
        setLoad({ status: "error", message });
        onFallback(message, code);
      }
    })();
    return () => {
      cancelled = true;
      boxObserver.disconnect();
      sessionRefLocal.current?.dispose();
      sessionRefLocal.current = null;
    };
    // mediaUrls 以内容为准（票据变更即重建）；playhead 仅挂载时取初值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, revisionId, outputRatio]);

  // 播放/暂停。
  useEffect(() => {
    const session = sessionRef.current;
    if (!session || load.status !== "ready") return;
    if (playing) session.play();
    else session.pause();
  }, [playing, load.status]);

  // 片段音频配置（静音/增益编辑实时生效）。
  const audioByClipRef = useRef(audioByClip);
  useEffect(() => {
    audioByClipRef.current = audioByClip;
    sessionRef.current?.setAudioByClip(audioByClip ?? null);
  }, [audioByClip, load.status]);

  // 外部播放头跳转（暂停态）：偏差 >0.5s 视为外部 seek；播放中自身上报的时间不回环。
  // 连续快速跳转走拖拽快速档（主轨优先），停止 250ms 后全量精修（M3-2）。
  const settleTimer = useRef<number>(0);
  useEffect(() => {
    const session = sessionRef.current;
    if (!session || load.status !== "ready" || playing) return;
    if (Math.abs(playheadUs - lastReportedUs.current) > 500_000) {
      void session.seekToFrame(Math.max(0, Math.floor((playheadUs / 1e6) * session.ir.canvas.fps)));
      window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => void session.refineAfterDrag(), 250);
    }
  }, [playheadUs, playing, load.status]);

  // 指标轮询（1s，循环外）。
  useEffect(() => {
    if (load.status !== "ready") return;
    const timer = window.setInterval(() => {
      const session = sessionRef.current;
      if (session) setMetrics(session.metrics());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [load.status]);

  return (
    <div className="synthetic-preview" aria-label="合成预览" style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", width: "100%", height: "100%" }}>
      <canvas ref={canvasRef} className="synthetic-canvas" style={{ display: load.status === "ready" ? "block" : "none", width: "100%", height: "100%" }} />
      {load.status === "ready" && sessionRef.current && pipClips && pipClips.length > 0 && (() => {
        const live = sessionRef.current;
        const cw = live.ir.canvas.width;
        const ch = live.ir.canvas.height;
        return (
          <SyntheticPipLayer
            boxes={live.pipBoxes().map(box => ({ ...box, canvasW: cw, canvasH: ch }))}
            view={live.pipView()}
            selectedClipId={selectedClipId ?? null}
            locked={false}
            onSelect={clipId => onSelectClip?.(clipId)}
            onDraftMove={(clipId, x, y) => onDraftPipMove?.(clipId, x, y)}
            onCommitMove={(clipId, x, y) => {
              const base = pipClips.find(item => item.clipId === clipId)?.transform ?? {};
              onCommitPipMove?.(clipId, x, y);
              void base;
            }}
            onGestureStart={() => onGesturePause?.() ?? false}
            onGestureEnd={wasPlaying => onGestureResume?.(wasPlaying)}
          />
        );
      })()}
      {load.status !== "ready" && <div className="synthetic-loading">{load.message || "…"}</div>}
      {load.status === "ready" && metrics && (
        <div className={`synthetic-metrics${metrics.last_error ? " err" : ""}`}>
          {metrics.last_error
            ? `最近错误：${metrics.last_error}`
            : `合成预览 · 任务 p95 ${metrics.task_ms_p95}ms · 解码 p95 ${metrics.decode_ms_p95}ms · 上传 p95 ${metrics.upload_ms_p95}ms · 丢帧 ${metrics.dropped_frames}`}
        </div>
      )}
    </div>
  );
}
