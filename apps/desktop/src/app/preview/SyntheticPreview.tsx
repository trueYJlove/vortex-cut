/** 合成预览（M3-1）：消费 Core 投影的 preview-ir-v1 逐帧数值表，WebCodecs 解码 +
 * WebGL2 合成（OffscreenCanvas worker）的权威级实时预览。子集外语义自动降级
 * 回交互预览（PREVIEW_IR_UNSUPPORTED）。画布元素由会话自建（transferControl-
 * ToOffscreen 每元素仅可一次——会话生命周期 = 画布生命周期）。
 * C20 第二阶段：VITE_AIVS_PREVIEW_IR_V2=1 时走 v2 manifest+窗口帧源
 * （Renderer 不再驻留全量帧表）；默认 off = v1 路径逐字节不变。 */
import { useEffect, useMemo, useRef, useState } from "react";
import { parseIr, type Ir } from "./ir.js";
import { PreviewSession, type PreviewSessionMetrics, type SegmentAudioConfig } from "./preview-session.js";
import { PreviewSourceResolver } from "./source-resolver.js";
import { SyntheticPipLayer } from "./SyntheticPipLayer.js";
import { windowedFrameSource } from "./frame-source.js";
import { parsePreviewIrV2Manifest } from "@aivideo/contracts";

const previewIrV2Enabled = (): boolean => {
  try { return import.meta.env.VITE_AIVS_PREVIEW_IR_V2 === "1"; } catch { return false; }
};

/** 画中画片段编辑态（App 从时间线文档透传；transform 中心点语义）。 */
export interface SyntheticPipClip { clipId: string; transform: { x?: number; y?: number; scale?: number; rotate?: number; opacity?: number }; mask?: import("@aivideo/contracts").TimelineClipMask }

/** 手势提交的 transform 负载（opacity 等未涉及字段由调用方合并既有 transform）。 */
export interface PipTransformCommit { x: number; y: number; scale: number; rotate: number }

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
  onCommitPipTransform?: (clipId: string, transform: PipTransformCommit) => void;
  /** 蒙版手势（合成器不渲染蒙版：实时仅边界示意，提交走 set_clip_mask）。 */
  onDraftPipMask?: (clipId: string, mask: import("@aivideo/contracts").TimelineClipMask) => void;
  onCommitPipMask?: (clipId: string, mask: import("@aivideo/contracts").TimelineClipMask) => void;
  onGesturePause?: () => boolean;
  onGestureResume?: (wasPlaying: boolean) => void;
  playing: boolean;
  playheadUs: number;
  onTimeUs: (us: number) => void;
  /** 播放头存储（A06，可选）：提供时预览会话的逐帧时间上报直写 store，
   *  React 组件树的 10Hz 节流更新由 App 层的 onTimeUs 通道保留——
   *  时间线播放头覆盖层按帧率跟随而不再等待 App 提交。 */
  playheadStore?: import("../timeline/playhead-store.js").PlayheadStore;
  /** 自然播放到片尾（会话内部已 pause；UI 复位播放按钮）。 */
  onEnded?: () => void;
  onFallback: (reason: string, code: string | null) => void;
  /** B11：预览源解析（视频输入优先代理票据；不提供 = 原源行为不变）。 */
  sourceResolver?: PreviewSourceResolver | null;
  /** B13：资源预算档位（Main 离散注入；不提供 = 默认 balanced 行为）。 */
  resourceTier?: "conservative" | "balanced" | "high";
  /** B13-R 判别诊断开关：强制 copyTo 上传（perf 诊断构建经 runtime 注入）。 */
  forceCopyTo?: boolean;
}

interface LoadState {
  status: "loading" | "ready" | "error";
  message: string;
}

export function SyntheticPreview(props: SyntheticPreviewProps): React.ReactElement {
  const { projectId, revisionId, mediaUrls, audioByClip, pipClips, selectedClipId, onSelectClip, onCommitPipTransform, onDraftPipMask, onCommitPipMask, onGesturePause, onGestureResume, playing, playheadUs, onTimeUs, onEnded, onFallback, outputRatio, playheadStore, sourceResolver, resourceTier, forceCopyTo } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<PreviewSession | null>(null);
  const generationRef = useRef(0);
  const sessionProjectRef = useRef<string | null>(null);
  const lastReportedUs = useRef<number>(playheadUs);
  const lastReportWall = useRef<number>(0);
  // 预览框观察器：组件级单例（吸收路径早退不销毁，避免观察器泄漏）
  const boxObserverRef = useRef<ResizeObserver | null>(null);
  if (!boxObserverRef.current) {
    boxObserverRef.current = new ResizeObserver(entries => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      const session = sessionRef.current;
      const container = containerRef.current;
      if (!session || !container) return;
      const rect = container.getBoundingClientRect();
      const width = rect?.width ?? 0;
      const height = rect?.height ?? 0;
      if (width > 2 && height > 2) session.resize(width, height);
    });
  }
  const [load, setLoad] = useState<LoadState>({ status: "loading", message: "正在加载合成预览" });
  const [metrics, setMetrics] = useState<PreviewSessionMetrics | null>(null);

  // IR 加载 + 会话创建（revision 变更时重建；手势提交的变更被吸收、会话保活）。
  useEffect(() => {
    const generation = ++generationRef.current;
    const controller = new AbortController();
    const stale = () => controller.signal.aborted || generation !== generationRef.current;
    let creating: PreviewSession | null = null;
    let ready = false;
    const sessionRefLocal = sessionRef;
    boxObserverRef.current?.observe(containerRef.current ?? document.body);
    // 同输入 revision 变更（transform/关键帧/时间编辑）→ 会话就地换 IR：
    // worker/GL 全保留，零黑屏。输入变化或无会话 → 走完整重建。
    let existing = sessionRefLocal.current;
    if (sessionProjectRef.current !== projectId) {
      existing?.dispose(); existing = null; sessionRefLocal.current = null;
    }
    setLoad({ status: "loading", message: "正在加载合成预览" });
    (async () => {
      try {
        // C20 v2 数据面：manifest（无帧）→ 窗口帧源 → 会话（注入 frames）。
        // 就地换表路径在 v2 下不适用（manifest_id 变化 = 新帧源），revision
        // 变更走既有"输入变化 → 整会话重建"判定（sig 含输入集合）。
        if (previewIrV2Enabled()) {
          const manifest = parsePreviewIrV2Manifest(await window.desktop.getPreviewIrV2Manifest({
            project_id: projectId as never,
            timeline_revision_id: revisionId,
            output_ratio: outputRatio,
          }));
          const container = containerRef.current;
          if (!container || stale()) return;
          const frameSource = windowedFrameSource(manifest.manifest_id, manifest.total_frames, {
            fetchWindow: (startFrame, frameCount, signal) => {
              if (signal.aborted) return Promise.reject(new Error("aborted"));
              return window.desktop.getPreviewIrV2Window({
                project_id: projectId as never, start_frame: startFrame, frame_count: frameCount,
                timeline_revision_id: revisionId, output_ratio: outputRatio,
              }).then(payload => payload);
            },
          });
          // 首屏：只取首窗 + 预取窗（不等待全量——v2 的核心收益点）
          await frameSource.ensureRange?.(0, Math.min(manifest.total_frames, 600), controller.signal);
          if (stale()) { frameSource.dispose?.(); return; }
          const ir: Ir = {
            schema: "preview-ir-v1", // 会话消费 v1 形状的元数据 + v2 窗口帧源供帧
            projector_version: String(manifest.projector_version),
            canvas: manifest.canvas as unknown as Ir["canvas"],
            inputs: manifest.inputs as unknown as Ir["inputs"],
            segments: manifest.segments as unknown as Ir["segments"],
            captions: manifest.captions as unknown as Ir["captions"],
            caption_styles: manifest.caption_styles as unknown as Ir["caption_styles"],
            transition_windows: manifest.transition_windows as unknown as Ir["transition_windows"],
            known_approximations: manifest.known_approximations,
            frames: [],
          };
          const session = await PreviewSession.create(container, ir, mediaUrls, audioByClip, controller.signal, sourceResolver ?? null, resourceTier, typeof projectId === "string" ? projectId : null, frameSource, forceCopyTo);
          creating = session;
          if (stale()) { session.dispose(); return; }
          session.onTimeUs = (us: number) => {
            lastReportedUs.current = us;
            playheadStore?.set(us);
            const now = performance.now();
            if (now - lastReportWall.current >= 100 || !session.isPlaying) {
              lastReportWall.current = now;
              onTimeUs(us);
            }
          };
          session.onEnded = () => {
            onTimeUs(lastReportedUs.current);
            onEnded?.();
          };
          sessionRefLocal.current = session;
          sessionProjectRef.current = projectId;
          boxObserverRef.current?.observe(container);
          const fontUrl = await window.desktop.captionFontUrl();
          if (stale()) return;
          const fontResponse = await fetch(fontUrl, { signal: controller.signal });
          if (!fontResponse.ok) throw new Error("caption font fetch failed");
          const fontBuffer = await fontResponse.arrayBuffer();
          if (stale()) return;
          await session.loadCaptionFont(fontBuffer);
          if (stale()) return;
          await session.seekToFrame(Math.max(0, Math.floor((playheadUs / 1e6) * ir.canvas.fps)));
          if (stale()) return;
          ready = true;
          setLoad({ status: "ready", message: "" });
          if (playing) session.play();
          return;
        }
        const payload = await window.desktop.getPreviewIr({
          project_id: projectId as never,
          timeline_revision_id: revisionId,
          output_ratio: outputRatio,
        });
        const ir: Ir = parseIr(payload.ir as unknown as string);
        const container = containerRef.current;
        if (!container || stale()) return;
        if (existing && existing.replaceIr(ir)) {
          // 就地换表成功：无需触碰 worker/GL/音频，重呈现由 replaceIr 驱动
          setLoad({ status: "ready", message: "" });
          return;
        }
        existing?.dispose();
        sessionRefLocal.current = null;
        // 画布元素由会话自建（transferControlToOffscreen 每元素仅一次），
        // 后备缓冲随预览框（contain 居中，见 session.resize）；初始以 IR 画布尺寸起底
        const session = await PreviewSession.create(container, ir, mediaUrls, audioByClip, controller.signal, sourceResolver ?? null, resourceTier, typeof projectId === "string" ? projectId : null, undefined, forceCopyTo);
        creating = session;
        if (stale()) { session.dispose(); return; }
        session.onTimeUs = (us: number) => {
          lastReportedUs.current = us;
          // A06：预览会话每帧直写播放头 store——时间线覆盖层按帧率跟随；
          // App React 状态仍 10Hz 节流上报（App 组件树重渲是主线程大头，
          // 30-60Hz 上报会挤压合成管线——实测丢帧 292 + 音频卡顿）。
          playheadStore?.set(us);
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
        sessionProjectRef.current = projectId;
        boxObserverRef.current?.observe(container);
        const fontUrl = await window.desktop.captionFontUrl();
        if (stale()) return;
        const fontResponse = await fetch(fontUrl, { signal: controller.signal });
        if (!fontResponse.ok) throw new Error("caption font fetch failed");
        const fontBuffer = await fontResponse.arrayBuffer();
        if (stale()) return;
        await session.loadCaptionFont(fontBuffer);
        if (stale()) return;
        await session.seekToFrame(Math.max(0, Math.floor((playheadUs / 1e6) * ir.canvas.fps)));
        if (stale()) return;
        ready = true;
        setLoad({ status: "ready", message: "" });
        if (playing) session.play();
      } catch (error) {
        creating?.dispose();
        if (sessionRefLocal.current === creating) sessionRefLocal.current = null;
        if (stale()) return;
        const message = error instanceof Error ? error.message : String(error);
        const code = /PREVIEW_IR_UNSUPPORTED/.test(message) ? "PREVIEW_IR_UNSUPPORTED" : null;
        setLoad({ status: "error", message });
        onFallback(message, code);
      }
    })();
    return () => {
      // 仅标记失效：会话销毁由卸载 effect 或下一次非吸收重建的 body 负责
      //（React 在新 body 前必然先跑本 cleanup——在此 dispose 会使"吸收保活"
      // 失效，拖拽提交即黑屏）。
      controller.abort();
      if (!ready && creating) {
        creating.dispose();
        if (sessionRefLocal.current === creating) sessionRefLocal.current = null;
      }
    };
    // mediaUrls 以内容为准（票据变更即重建）；playhead 仅挂载时取初值。
    // playheadStore 稳定（App useRef 持有），不参与会话重建——只影响上报通道。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, revisionId, outputRatio]);

  // 卸载：销毁会话（含画布元素）+ 断开观察器（StrictMode 双挂载各自动一次，安全）。
  useEffect(() => () => {
    boxObserverRef.current?.disconnect();
    sessionRef.current?.dispose();
    sessionRef.current = null;
  }, []);

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
      <div ref={containerRef} style={{ display: load.status === "ready" ? "block" : "none", width: "100%", height: "100%" }} />
      {load.status === "ready" && sessionRef.current && pipClips && pipClips.length > 0 && (() => {
        const live = sessionRef.current;
        const cw = live.ir.canvas.width;
        const ch = live.ir.canvas.height;
        const transformOf = (clipId: string) => pipClips.find(item => item.clipId === clipId)?.transform;
        return (
          <SyntheticPipLayer
            boxes={live.pipBoxes().map(box => ({ ...box, canvasW: cw, canvasH: ch, scale: transformOf(box.clipId)?.scale ?? 1, rotate: transformOf(box.clipId)?.rotate ?? 0, mask: pipClips.find(item => item.clipId === box.clipId)?.mask }))}
            view={live.pipView()}
            selectedClipId={selectedClipId ?? null}
            locked={false}
            onSelect={clipId => onSelectClip?.(clipId)}
            onLiveGeometry={(clipId, geometry) => { live.setPipGeometry(clipId, { cx: geometry.cx, cy: geometry.cy, w: geometry.w, h: geometry.h, rotation: geometry.rotate }); }}
            onCommitTransform={(clipId, transform) => onCommitPipTransform?.(clipId, transform)}
            onDraftMask={(clipId, mask) => onDraftPipMask?.(clipId, mask)}
            onCommitMask={(clipId, mask) => onCommitPipMask?.(clipId, mask)}
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
