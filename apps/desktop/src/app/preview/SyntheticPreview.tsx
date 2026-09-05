/** 合成预览（M3-1）：消费 Core 投影的 preview-ir-v1 逐帧数值表，WebCodecs 解码 +
 * WebGL2 合成的权威级实时预览。子集外语义自动降级回交互预览（PREVIEW_IR_UNSUPPORTED）。 */
import { useEffect, useRef, useState } from "react";
import { parseIr, type Ir } from "./ir.js";
import { PreviewSession, type PreviewSessionMetrics } from "./preview-session.js";

export interface SyntheticPreviewProps {
  projectId: string;
  revisionId: string | null;
  /** asset_id → aivideo:// 票据 URL（App 既有素材通道）。 */
  mediaUrls: Map<string, string>;
  playing: boolean;
  playheadUs: number;
  onTimeUs: (us: number) => void;
  onFallback: (reason: string, code: string | null) => void;
}

interface LoadState {
  status: "loading" | "ready" | "error";
  message: string;
}

export function SyntheticPreview(props: SyntheticPreviewProps): React.ReactElement {
  const { projectId, revisionId, mediaUrls, playing, playheadUs, onTimeUs, onFallback } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sessionRef = useRef<PreviewSession | null>(null);
  const lastReportedUs = useRef<number>(playheadUs);
  const [load, setLoad] = useState<LoadState>({ status: "loading", message: "正在加载合成预览" });
  const [metrics, setMetrics] = useState<PreviewSessionMetrics | null>(null);

  // IR 加载 + 会话创建（revision 变更时重建）。
  useEffect(() => {
    let cancelled = false;
    const sessionRefLocal = sessionRef;
    setLoad({ status: "loading", message: "正在加载合成预览" });
    sessionRefLocal.current?.dispose();
    sessionRefLocal.current = null;
    (async () => {
      try {
        const payload = await window.desktop.getPreviewIr({
          project_id: projectId as never,
          timeline_revision_id: revisionId,
          output_ratio: "169",
        });
        const ir: Ir = parseIr(payload.ir as unknown as string);
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        canvas.width = ir.canvas.width;
        canvas.height = ir.canvas.height;
        const session = await PreviewSession.create(canvas, ir, mediaUrls);
        if (cancelled) { session.dispose(); return; }
        session.onTimeUs = (us: number) => {
          lastReportedUs.current = us;
          onTimeUs(us);
        };
        sessionRefLocal.current = session;
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
      sessionRefLocal.current?.dispose();
      sessionRefLocal.current = null;
    };
    // mediaUrls 以内容为准（票据变更即重建）；playhead 仅挂载时取初值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, revisionId]);

  // 播放/暂停。
  useEffect(() => {
    const session = sessionRef.current;
    if (!session || load.status !== "ready") return;
    if (playing) session.play();
    else session.pause();
  }, [playing, load.status]);

  // 外部播放头跳转（暂停态）：偏差 >0.5s 视为外部 seek；播放中自身上报的时间不回环。
  useEffect(() => {
    const session = sessionRef.current;
    if (!session || load.status !== "ready" || playing) return;
    if (Math.abs(playheadUs - lastReportedUs.current) > 500_000) {
      void session.seekToFrame(Math.max(0, Math.floor((playheadUs / 1e6) * session.ir.canvas.fps)));
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
    <div className="synthetic-preview" aria-label="合成预览">
      <canvas ref={canvasRef} className="synthetic-canvas" style={{ display: load.status === "ready" ? "block" : "none" }} />
      {load.status !== "ready" && <div className="synthetic-loading">{load.message || "…"}</div>}
      {load.status === "ready" && metrics && (
        <div className="synthetic-metrics">
          合成预览 · 任务 p95 {metrics.task_ms_p95}ms · 丢帧 {metrics.dropped_frames}
        </div>
      )}
    </div>
  );
}
