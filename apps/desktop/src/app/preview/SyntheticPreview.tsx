/** 合成预览（M3-1）：消费 Core 投影的 preview-ir-v1 逐帧数值表，WebCodecs 解码 +
 * WebGL2 合成（OffscreenCanvas worker）的权威级实时预览。子集外语义自动降级
 * 回交互预览（PREVIEW_IR_UNSUPPORTED）。画布元素由会话自建（transferControl-
 * ToOffscreen 每元素仅可一次——会话生命周期 = 画布生命周期）。
 * C20 第二阶段：VITE_AIVS_PREVIEW_IR_V2=0 时走 v1 全量帧表（Renderer 驻留
 * 全表）；v2 走 manifest+窗口帧源。
 * C20 v2 默认 on（2026-09-13，PERFORMANCE_C20V2_DEFAULT_ON_DECISION_2026-09-13.md）：
 * VITE_AIVS_PREVIEW_IR_V2=0 显式回退 v1（v1 路径保留、语义不变）。 */
import { useEffect, useMemo, useRef, useState } from "react";
import { parseIr, type Ir } from "./ir.js";
import { windowedFrameSource, type FrameSource } from "./frame-source.js";
import { PreviewSession, type AssetDecodeBudget, type PreviewSessionMetrics, type SegmentAudioConfig } from "./preview-session.js";
import { PreviewSourceResolver } from "./source-resolver.js";
import { SyntheticPipLayer } from "./SyntheticPipLayer.js";
import { windowSourceBudget } from "./resource-budget.js";
import { editorPerf } from "./perf-metrics.js";
import { parsePreviewIrV2Manifest, PREVIEW_IR_V2_MAX_WINDOW_FRAMES, type PreviewIrV2Manifest } from "@aivideo/contracts";

const previewIrV2Enabled = (): boolean => {
  // C20 v2 默认 on(2026-09-13 LiuWei 裁决,PERFORMANCE_C20V2_DEFAULT_ON_DECISION_2026-09-13.md);
  // VITE_AIVS_PREVIEW_IR_V2=0 为显式回退开关,长期保留。
  try { return import.meta.env.VITE_AIVS_PREVIEW_IR_V2 !== "0"; } catch { return true; }
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
  /** 全局播放倍速（倍速菜单驱动）：会话内 clampPlayRate 夹取 0.25–4，缺省 1
   *  （常速）。转发给活会话（setPlayRate）：播放态先重锚时钟再换率，暂停态
   *  存储待起播；未提供或 1 = 与旧版逐位同式。 */
  playbackRate?: number;
  /** 合成画面截帧通道（项目封面取帧用）：组件挂载时写入当前会话的
   *  snapshotPng 转发函数、卸载时清空——App 经此 ref 在合成模式下取帧
   *  （无 video 元素可 drawImage，v1 静态路径无合成器时返回 null）。 */
  snapshotRef?: { current: (() => Promise<{ buffer: ArrayBuffer; contentX: number; contentY: number; contentW: number; contentH: number } | null>) | null };
  /** A2/A3：代理就绪计数（App 递增；不提供 = 行为与旧版完全一致）。
   *  变化 = 「把预览源切到代理」的请求：播放中只挂起，等到暂停（自然切换点）
   *  才提交并重建会话一次——解析只在会话装配时跑一次，不重建就换不了源。 */
  proxyEpoch?: number;
  /** 按需代理（方案 A 改造）：预览**跑起来之后**每秒上报一次实测解码预算判定
   *  ——按 p95 回答「哪个素材解不动」，由 App 决定为谁登记代理作业。触发点
   *  从「导入瞬间」挪到这里，所以早已导入的素材同样生效。
   *  不提供 = 行为与旧版完全一致（不判定、不上报）。 */
  onDecodeBudget?: (verdicts: AssetDecodeBudget[]) => void;
}

interface LoadState {
  status: "loading" | "ready" | "error";
  message: string;
}

export function SyntheticPreview(props: SyntheticPreviewProps): React.ReactElement {
  const { projectId, revisionId, mediaUrls, audioByClip, pipClips, selectedClipId, onSelectClip, onCommitPipTransform, onDraftPipMask, onCommitPipMask, onGesturePause, onGestureResume, playing, playheadUs, onTimeUs, onEnded, onFallback, outputRatio, playheadStore, sourceResolver, resourceTier, forceCopyTo, playbackRate, snapshotRef, proxyEpoch, onDecodeBudget } = props;
  // 判定回调经 ref 读最新值：指标轮询 effect 只依赖 load.status，不该因为父组件
  // 每次重渲染换了函数身份就重建定时器（重建会漏掉一轮采样）。
  const onDecodeBudgetRef = useRef(onDecodeBudget);
  onDecodeBudgetRef.current = onDecodeBudget;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<PreviewSession | null>(null);
  // C20c-1：v2 外部帧源所有权在本组件（session.dispose 不释放外部帧源）——
  // 换装/重建/卸载时由此 ref 统一释放，闭合既有"项目切换/卸载漏 dispose"缺口。
  const frameSourceRef = useRef<FrameSource | null>(null);
  // C20c-2：与帧源成对持有的 manifest（seed 判定 = 两者同一装配轮采纳的
  // manifest_id 对比——中断装配不更新，保证配对一致）。
  const frameManifestRef = useRef<PreviewIrV2Manifest | null>(null);
  const generationRef = useRef(0);
  const sessionProjectRef = useRef<string | null>(null);
  /** A2：代理切换台账。props.proxyEpoch（请求）只在「非播放」时刻提交成
   *  proxyCommitEpoch（会话重建计数）——播放中重建会 dispose 当前会话，
   *  画面与音频当场中断。两者不等 = 已就绪但尚未切换（A3 提示的依据）。 */
  const [proxyCommitEpoch, setProxyCommitEpoch] = useState(0);
  const proxyAppliedEpoch = useRef<number>(proxyEpoch ?? 0);
  /** 提交后要求下一次装配「整会话重建」，而不是 replaceIr 就地换表。 */
  const proxyForceRebuild = useRef(false);
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
  // P196：会话的缓冲提示（已按 300ms 延迟边沿触发的布尔量，1Hz 指标轮询
  // 太慢、也不该把提示混进诊断口径，故单开一道状态）。
  const [buffering, setBuffering] = useState(false);
  const bufferingShown = useRef(false);
  /** 组件侧同一份"已显示"判定的 ref 镜像：会话换装/重建时用它判断是否需要
   *  补一次复位（stale 的旧会话可能已 dispose，不会再发 false）。 */
  useEffect(() => { bufferingShown.current = buffering; }, [buffering]);
  // GAP-PIP-FLASH：换表/取窗瞬间 pipBoxes() 可能短暂为空（新 IR 帧窗口未装配），
  // 卸载 PiP 层 = 选中框消失 + click 穿透到画布误选主轨片段。保留最近一次
  // 非空 boxes 作为兜底（纯视觉占位；数据恢复后立即被真实值覆盖）。
  const lastPipBoxesRef = useRef<import("./SyntheticPipLayer.js").PipBoxItem[] | null>(null);

  // A2：代理就绪（proxyEpoch 变化）→ 挑自然切换点提交，绝不打断播放。
  // 播放中只挂起不提交；暂停（或其它非播放时刻）提交一次——计数单调、每素材
  // 一次，不会形成重建循环。提交置 proxyForceRebuild，让装配走整会话重建：
  // 换表路径（replaceIr）会保留旧源，正好绕过 resolve 这唯一的换源点。
  useEffect(() => {
    const requested = proxyEpoch ?? 0;
    if (requested === proxyAppliedEpoch.current) return;
    if (playing) return;
    proxyAppliedEpoch.current = requested;
    proxyForceRebuild.current = true;
    setProxyCommitEpoch(epoch => epoch + 1);
  }, [proxyEpoch, playing]);

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
    // A2：代理切换提交后必须整会话重建——sourceResolver.resolve 只在装配时
    // 跑一次，换表（replaceIr）会保留旧源，正好绕过唯一的换源点。
    if (sessionProjectRef.current !== projectId || proxyForceRebuild.current) {
      proxyForceRebuild.current = false;
      existing?.dispose(); existing = null; sessionRefLocal.current = null;
      // C20c-1：外部帧源所有权在组件——项目切换一并释放（既有缺口闭合）
      frameSourceRef.current?.dispose?.(); frameSourceRef.current = null;
      frameManifestRef.current = null;
    }
    // 会话保活（replaceIr 路径）时不降级 load 状态：画布已有上一 revision 的
    // 完整画面，置 loading 会隐藏画布（闪黑）并卸载 PiP 交互层（选中框消失）
    // ——编辑提交（拖拽落定/属性面板）必经此路径。仅冷启/重建显示 loading。
    if (!existing) setLoad({ status: "loading", message: "正在加载合成预览" });
    (async () => {
      try {
        // C20 v2 数据面：manifest（无帧）→ 窗口帧源 → 会话（注入 frames）。
        // C20c-1：同项目 revision 变更且输入绑定未变 → 会话沿用（worker/GL/
        // 池/音频全保留），新 manifest 帧源就地换装；sig 不匹配（输入增删）
        // 才走既有"整会话重建"。
        if (previewIrV2Enabled()) {
          // C20-T2 ready 分段遥测：manifest/解析/窗口/注入四段（分段有重叠，
          // 相加 ≠ ready_ms；归因口径见 T2 实施报告）。
          const readyT0 = performance.now();
          // 无契约并行化：窗口请求入参不含 manifest_id（响应才携带，仅作失配
          // 校验）→ 窗 0 与 manifest 并行取。只预热窗 0——窗 1 盲发在小源
          // (<300 帧) 会越界 400（Core start_frame>=total 拒绝）；count 固定
          // 300 由 Core 夹紧到实际帧数，loadWindow 按响应容差装填。
          const prewarmWindow0 = window.desktop.getPreviewIrV2Window({
            project_id: projectId as never, start_frame: 0, frame_count: PREVIEW_IR_V2_MAX_WINDOW_FRAMES,
            timeline_revision_id: revisionId, output_ratio: outputRatio,
          }).then(payload => payload);
          prewarmWindow0.catch(() => undefined); // 防孤儿拒绝：装配中断时此请求无人消费
          // 字体与 manifest 并行（装配尾段才消费；失败语义与原串行一致）。
          // 多字体：captionFontUrls 返回全部注册字体（bundle v2）；旧端点
          // 缺失时回退单字体端点。
          const fontPromise = (window.desktop.captionFontUrls
            ? window.desktop.captionFontUrls()
            : window.desktop.captionFontUrl().then(url => [{ family: "AppCaptionCJK", media_url: url }])
          )
            .then(entries => Promise.all(entries.map(entry =>
              fetch(entry.media_url, { signal: controller.signal })
                .then(response => {
                  if (!response.ok) throw new Error("caption font fetch failed");
                  return response.arrayBuffer().then(buffer => ({ family: entry.family, buffer }));
                })
                .catch(() => null))))
            .then(results => results.filter((entry): entry is { family: string; buffer: ArrayBuffer } => entry !== null));
          fontPromise.catch(() => undefined);
          const manifestT0 = performance.now();
          const manifestRaw = await window.desktop.getPreviewIrV2Manifest({
            project_id: projectId as never,
            timeline_revision_id: revisionId,
            output_ratio: outputRatio,
          });
          const manifestDone = performance.now();
          editorPerf.record("ready_manifest", manifestDone - manifestT0);
          const manifest = parsePreviewIrV2Manifest(manifestRaw);
          editorPerf.record("ready_parse", performance.now() - manifestDone);
          const container = containerRef.current;
          if (!container || stale()) return;
          // C20c-2：manifest_id 相等（= 同 content_fingerprint ⇒ 同投影，覆盖
          // 撤销/重做/空转 revision 的编辑闭环）→ 旧源缓存窗口整体迁移（帧对象
          // 同引用）。不等 → 不迁移：投影输出剥离 keyframes/transform、DTO 无
          // 预设/字体版本，manifest 对"不可见变更"盲——无法证明段外帧不变，
          // 宁重算（部分复用待 C20c-2b 契约扩展：段级 visual hash + caption
          // 语义 hash）。manifest_id 相等 ⇒ inputs 相等 ⇒ sig 必过 ⇒ 必走换装。
          const prevSource = frameSourceRef.current;
          const prevManifest = frameManifestRef.current;
          const seedWindows = prevSource?.snapshotWindows && prevManifest
            && prevManifest.manifest_id === manifest.manifest_id
            ? prevSource.snapshotWindows()
            : undefined;
          // C20-T1：缓存预算/在途上限随资源档位（无档位 = 帧源内建默认 8MiB/2，
          // 语义不变——档位表见 resource-budget.windowSourceBudget）
          const wsBudget = resourceTier ? windowSourceBudget(resourceTier) : undefined;
          let pendingPrewarm: typeof prewarmWindow0 | null = prewarmWindow0;
          const frameSource = windowedFrameSource(manifest.manifest_id, manifest.total_frames, {
            seedWindows,
            fetchWindow: (startFrame, frameCount, signal) => {
              if (signal.aborted) return Promise.reject(new Error("aborted"));
              // C20-T2：命中预热窗复用在途请求（manifest_id 失配仍在
              // loadWindow 内整体丢弃——校验语义不变）
              if (startFrame === 0 && pendingPrewarm) {
                const prewarmed = pendingPrewarm;
                pendingPrewarm = null;
                return prewarmed;
              }
              return window.desktop.getPreviewIrV2Window({
                project_id: projectId as never, start_frame: startFrame, frame_count: frameCount,
                timeline_revision_id: revisionId, output_ratio: outputRatio,
              }).then(payload => payload);
            },
            cacheBytes: wsBudget?.cacheBytes,
            maxInFlight: wsBudget?.maxInFlight,
          });
          // 首屏：首窗（预热命中）+预取窗**发起**，与 create 并行——不在此
          // 等待，装配尾部 seekToFrame 前统一 await（其内部取窗 await 兜底）。
          const ensureT0 = performance.now();
          const ensureReady = frameSource.ensureRange?.(0, Math.min(manifest.total_frames, 600), controller.signal) ?? Promise.resolve();
          ensureReady.catch(() => undefined); // loadWindow 自吞错误；此处防中断路径孤儿
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
          // C20c-1：同项目 revision 变更（输入绑定未变，sig 由 replaceIr 校验）
          // → 会话沿用就地换装：worker/GL/池/音频全保留，帧表/段表换新
          // manifest 帧源（旧源所有权在组件，换装后释放其缓存/在途）。
          const existingSession = sessionRefLocal.current;
          if (existingSession && existingSession.replaceIr(ir, frameSource)) {
            frameSourceRef.current?.dispose?.();
            frameSourceRef.current = frameSource;
            frameManifestRef.current = manifest; // 与帧源同轮采纳（seed 配对一致）
            // 新源无就绪窗：暂停态显式重锚（refineAfterDrag → seekToFrame 取
            // 当前帧窗口并重呈现）；播放态由 pump 下一 tick 的 ensureRange
            // 自愈（帧源按引用读取，换装对 pump 透明）——均不重建会话。
            if (!playing) void existingSession.refineAfterDrag().catch(() => undefined);
            if (stale()) return; // 更新轮已接管（其自身会再次换装/重建，资源经 ref 归属）
            ready = true;
            setLoad({ status: "ready", message: "" });
            return;
          }
          // sig 不匹配（输入集合变化）或无会话：整会话重建（旧源一并释放）
          if (existingSession) {
            existingSession.dispose();
            sessionRefLocal.current = null;
          }
          frameSourceRef.current?.dispose?.();
          frameSourceRef.current = null;
          frameManifestRef.current = null;
          const createT0 = performance.now();
          const session = await PreviewSession.create(container, ir, mediaUrls, audioByClip, controller.signal, sourceResolver ?? null, resourceTier, typeof projectId === "string" ? projectId : null, frameSource, forceCopyTo);
          editorPerf.record("ready_inject", performance.now() - createT0);
          creating = session;
          if (stale()) { session.dispose(); frameSource.dispose?.(); return; }
          frameSourceRef.current = frameSource; // C20c-1：外部帧源所有权移交组件
          frameManifestRef.current = manifest; // 与帧源同轮采纳（seed 配对一致）
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
          // P196：缓冲提示（会话侧已延迟 300ms 且边沿触发，这里只做状态落地）。
          // 换会话时旧会话可能已 dispose、不会再补 false——装配前若提示仍亮着，
          // 先复位，免得新会话的好画面顶着上一条提示。
          session.onBuffering = (value: boolean) => { if (!stale()) setBuffering(value); };
          if (bufferingShown.current) setBuffering(false);
          sessionRefLocal.current = session;
          sessionProjectRef.current = projectId;
          boxObserverRef.current?.observe(container);
          // C20-T2：字体已在装配头部并行预取；首窗就绪后再 seek（seekToFrame
          // 内部取窗 await 兜底同步——窗口未就绪时在此收敛）。
          const fonts = await fontPromise;
          if (stale()) { session.dispose(); frameSource.dispose?.(); return; }
          await session.loadCaptionFont(fonts);
          if (stale()) return;
          await ensureReady;
          editorPerf.record("ready_window", performance.now() - ensureT0);
          if (stale()) { session.dispose(); frameSource.dispose?.(); return; }
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
        // P196：同上（v1 帧源恒不缓冲，订阅只为"会话两态一致"，不产生回调）
        session.onBuffering = (value: boolean) => { if (!stale()) setBuffering(value); };
        if (bufferingShown.current) setBuffering(false);
        sessionRefLocal.current = session;
        sessionProjectRef.current = projectId;
        boxObserverRef.current?.observe(container);
        const fontEntries = await (window.desktop.captionFontUrls
          ? window.desktop.captionFontUrls()
          : window.desktop.captionFontUrl().then(url => [{ family: "AppCaptionCJK", media_url: url }]));
        if (stale()) return;
        const fonts = (await Promise.all(fontEntries.map(entry =>
          fetch(entry.media_url, { signal: controller.signal })
            .then(response => {
              if (!response.ok) throw new Error("caption font fetch failed");
              return response.arrayBuffer().then(buffer => ({ family: entry.family, buffer }));
            })
            .catch(() => null))))
          .filter((entry): entry is { family: string; buffer: ArrayBuffer } => entry !== null);
        if (stale()) return;
        await session.loadCaptionFont(fonts);
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
        // 域错误码经 Main safeInvoke 原码透传（IPC 包装可能带前缀，按子串识别）。
        // decode-worker 路径同样把 code 前缀进 message（errorText）。
        const code = /PREVIEW_IR_UNSUPPORTED/.test(message) ? "PREVIEW_IR_UNSUPPORTED"
          : /PREVIEW_IR_TOO_LARGE/.test(message) ? "PREVIEW_IR_TOO_LARGE"
          : /BMFF_CODEC_UNSUPPORTED/.test(message) ? "BMFF_CODEC_UNSUPPORTED"
          : null;
        // 启动时序（2026-09-23）：时间线先于素材票据落地时 "no ticket" 是装载
        // 次序而非故障——mediaUrls 依赖变化会自动重建会话，此处保持装载观感
        // （中性文案），不进错误态、不外抛 onFallback（App 层亦按同语义拦截，
        // 双闸防中间一帧错误闪现）。
        if (message.includes("no ticket") && mediaUrls.size === 0) {
          setLoad({ status: "loading", message: "正在装载素材…" });
          return;
        }
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
    // mediaUrls 以内容为准：票据迟到（分页装载/项目数据晚于时间线到位）时
    // 触发会话重建——旧实现依赖数组漏了它，空票据建的会话回退后永不重试
    // （2026-09-15 F04 100 素材复测暴露）。playhead 仅挂载时取初值；
    // playheadStore 稳定（App useRef 持有），不参与会话重建——只影响上报通道。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, revisionId, outputRatio, mediaUrls, proxyCommitEpoch]);

  // 卸载：销毁会话（含画布元素）+ 外部帧源 + 断开观察器（StrictMode 双挂载各自动一次，安全）。
  useEffect(() => () => {
    boxObserverRef.current?.disconnect();
    sessionRef.current?.dispose();
    sessionRef.current = null;
    // C20c-1：外部帧源所有权在组件——卸载一并释放（既有缺口闭合）
    frameSourceRef.current?.dispose?.();
    frameSourceRef.current = null;
    frameManifestRef.current = null;
    if (snapshotRef) snapshotRef.current = null;
  }, []);

  // 截帧通道：转发当前会话的 snapshotPng（会话换装/重建后 ref 内函数不变——
  // 闭包读 sessionRef.current，取的是"调用时刻"的会话）。
  useEffect(() => {
    if (!snapshotRef) return;
    snapshotRef.current = () => sessionRef.current?.snapshotPng() ?? Promise.resolve(null);
  }, [snapshotRef]);

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

  // 全局播放倍速（倍速菜单）：转发给活会话。会话换装/重建（load.status 变化）
  // 时也必须补发——新会话以 1 起步，不能继承上次会话的倍率记忆。未提供 prop
  // 时不转发（与旧版完全一致：无 prop 的调用方零行为变化）。
  useEffect(() => {
    if (playbackRate === undefined) return;
    sessionRef.current?.setPlayRate(playbackRate);
  }, [playbackRate, load.status]);

  // 外部播放头跳转（暂停态）：偏差 >0.5s 视为外部 seek；播放中自身上报的时间不回环。
  // 连续快速跳转走拖拽快速档（主轨优先），停止 250ms 后全量精修（M3-2）。
  const settleTimer = useRef<number>(0);
  /** 最近一次真正下发的目标帧：按帧去重，保证擦洗每一步都送达预览。 */
  const lastSeekedFrame = useRef<number>(-1);
  useEffect(() => {
    const session = sessionRef.current;
    if (!session || load.status !== "ready" || playing) return;
    // 2026-11-10：阈值判定必须"两边都记账"，否则连续擦洗会被全部丢弃。
    // 原实现只在 >0.5s 跳变时才 seek，且 seek 之后**不更新** lastReportedUs：
    // 用户用标尺小步拖动（每次位移 <0.5s）时，每个新位置与那个陈旧的基准
    // 比较都不够大 ⇒ 画面几乎不动。实测：擦洗 16 次采样只产生 3 个不同画面，
    // 时间码已经走到 00:00:01:04。
    // 改为：每次 seek 后把 lastReportedUs 同步到该位置，使下一次比较基于
    // 真实画面所在时间；阈值本身保留（它挡的是播放回传与环境噪声导致的回环）。
    // 阈值只用于"这一帧要不要动"的粗筛，不能既筛又不清基准——否则小步擦洗
    // 永远追不上。这里改为按**帧**比较：只要目标帧与当前帧不同就 seek。
    // 帧级比较天然过滤播放回传的抖动（同一帧不重复 seek），又不会丢弃擦洗。
    const targetFrame = Math.max(0, Math.floor((playheadUs / 1e6) * session.ir.canvas.fps));
    if (targetFrame !== lastSeekedFrame.current) {
      lastSeekedFrame.current = targetFrame;
      lastReportedUs.current = playheadUs;
      void session.seekToFrame(targetFrame);
      window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => void session.refineAfterDrag(), 250);
    }
  }, [playheadUs, playing, load.status]);

  // 指标轮询（1s，循环外）。
  useEffect(() => {
    if (load.status !== "ready") return;
    const timer = window.setInterval(() => {
      const session = sessionRef.current;
      if (!session) return;
      const snapshot = session.metrics();
      setMetrics(snapshot);
      // 按需代理判据（与指标同一轮 1Hz 采样）：实测解码耗时归因到素材后上报。
      // 判定本身是同步的纯计算（≤600 样本/输入取 p95），登记动作在 App 侧
      // fire-and-forget——这里绝不 await，也不让异常冒出来影响预览。
      const reportBudget = onDecodeBudgetRef.current;
      if (reportBudget) {
        try { reportBudget(session.decodeBudget()); } catch { /* 判定是加速项，失败静默 */ }
      }
      // 真机取证通道（VITE_AIVS_PERF=1 诊断构建才存在；发布构建无此全局）：
      // e2e/真机复测读 window.__aivsPreviewMetrics 拿到与指标条同源的数值
      //（含 decode_seg 分段与链状态），免去"探针 0 丢帧、App 丢帧"两张皮的
      // 无法对账问题（P33 用户素材复现要求 App 内可量化）。
      if (import.meta.env.VITE_AIVS_PERF === "1") {
        (window as unknown as { __aivsPreviewMetrics?: unknown }).__aivsPreviewMetrics = {
          at: performance.now(),
          ...snapshot,
          chain: session.chainState(),
        };
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [load.status]);

  // 诊断构建开关（与 __aivsPreviewMetrics 同一编译期常量；发布构建整段裁剪）。
  const perfHud = import.meta.env.VITE_AIVS_PERF === "1";
  // 异常态（任何构建都显示）：真实错误、硬解不可得、确定的 FFmpeg 软解降级。
  const hardwareMissing = Boolean(metrics?.decode_hardware && metrics.decode_hardware !== "" && !metrics.decode_hardware.includes("prefer-hardware"));
  const backendDegraded = Boolean(metrics?.decode_backend && metrics.decode_backend !== "webcodecs");
  // "?" = 池驱逐瞬间 worker 暂缺（routine），不是降级；诊断构建把它一并摊开，
  // 发布构建只报确定的 ffmpeg 软解，免得把正常驱逐刷成异常。
  const backendIsFfmpeg = metrics?.decode_backend?.includes("ffmpeg") ?? false;
  // P203：**HDR 素材 + 环境不支持** 才提示，两个条件缺一不可：素材属性单独出现无害
  // （HDR 素材在支持 HDR 的环境正常），环境属性单独出现也无害（SDR 素材在 SDR 显示器
  // 完全正常）。只有组合才是问题——Chromium 136 的 WebCodecs HEVC 路径解 10-bit HLG
  // 会产出 format=null 坏帧，随后渲染进程**永久堵死且无提示**。剪映在同环境下会弹窗
  // 告知并降级到 SDR（检测/告知/降级三步），本产品三件都没有；本提示补上前两件。
  const hdrBlocked = Boolean(metrics?.hdr_media) && metrics?.hdr_decodable === false;
  const anomaly = Boolean(metrics?.last_error) || hardwareMissing || backendIsFfmpeg;
  // **P203 教训（2026-11-01）：不要把 hdrBlocked 放进 anomaly**。
  // 实测：anomaly 一旦为 true（无论由 hdrBlocked 还是恒真触发），指标条渲染
  // 后约 2-4 秒**渲染进程必崩**（生产构建下）。这是既有缺陷（生产构建此前从未
  // 显示过指标条，故未被发现），与 HDR 无关——`anomaly = true` 同样崩。
  // 故 HDR 提示改走**独立通道**（见下方 hdrNotice 渲染），不依赖 anomaly。
  // 驻留预警是非阻断提示，与性能数字并列显示——它当年正是靠整行替换指标文本
  // 把性能数字挤没的，拆通道后不能再由它独占这一行。
  const residency = metrics?.residency_warning ?? null;
  // **预警只在诊断构建显示，不进发布版**：它按 v1 全帧驻留经验律估算，真实触发阈值
  // 低得吓人——画布 960×540 走 unique 帧律，balanced 档（App 默认）纹理预算 2048MiB
  // ⇒ 94s / 2820 帧就报，conservative 档 36s 就报；而同一份 P196 实测里预测 15,675MiB、
  // 实际合成器驻留仅 75.6MiB（v2 窗口化帧源下量级差约 200 倍）。让这条已知误报在
  // 发布版常驻，等于每条 1.5 分钟以上的时间线底部都糊一块错字——它不是异常态，
  // 不该享受「降级必须当场可见」的豁免。诊断构建照常显示（用于对账）。
  // 真实错误仍然压过性能数字（同一行里先答「为什么坏」，代价是这次的数字缺席）。
  const showPerfNumbers = perfHud && !metrics?.last_error;

  return (
    <div className="synthetic-preview" aria-label="合成预览" style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", width: "100%", height: "100%" }}>
      <div ref={containerRef} style={{ display: load.status === "ready" ? "block" : "none", width: "100%", height: "100%" }} />
      {load.status === "ready" && sessionRef.current && pipClips && pipClips.length > 0 && (() => {
        const live = sessionRef.current;
        const cw = live.ir.canvas.width;
        const ch = live.ir.canvas.height;
        const transformOf = (clipId: string) => pipClips.find(item => item.clipId === clipId)?.transform;
        const boxes = live.pipBoxes().map(box => ({ ...box, canvasW: cw, canvasH: ch, scale: transformOf(box.clipId)?.scale ?? 1, rotate: transformOf(box.clipId)?.rotate ?? 0, mask: pipClips.find(item => item.clipId === box.clipId)?.mask }));
        if (boxes.length > 0) lastPipBoxesRef.current = boxes;
        const displayBoxes = boxes.length > 0 ? boxes : (lastPipBoxesRef.current ?? []).filter(box => pipClips.some(item => item.clipId === box.clipId));
        return (
          <SyntheticPipLayer
            boxes={displayBoxes}
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
      {/* P196：缓冲指示（延迟 300ms 才出现、恢复立刻消失——判定在会话侧）。
          不参与布局、不吃指针事件：合成画布上的 PiP 手势必须照常穿透。
          色点用 CSS 画，不带动画循环（一次卡顿不该再叠一份 CPU 负担）。 */}
      {load.status === "ready" && buffering && (
        <div className="synthetic-buffering" role="status" aria-live="polite" aria-label="缓冲中">
          <span className="synthetic-buffering-dot" aria-hidden="true" />缓冲中
        </div>
      )}
      {load.status !== "ready" && <div className="synthetic-loading">{load.message || "…"}</div>}
      {/* 指标 HUD 按「诊断口径 vs 异常态」拆开，两者不共用一个开关：
          - **诊断口径**（性能数字 p50/p95/丢帧/画布尺寸/分段 + 驻留预警）：只有
            VITE_AIVS_PERF=1 诊断构建才有——与 :471 的 window.__aivsPreviewMetrics
            同一个开关，一处控制。发布版对最终用户没有任何可读价值，只会常驻挡画面。
            驻留预警之所以归这一侧而非异常态，见上方 residency 处的实测阈值。
          - **异常态提示**（真实错误 / 硬解不可得 / 确定的 FFmpeg 软解降级）：**任何构建
            都保留**。这条边界不许被「发布版不留 HUD」抹平：降级到 FFmpeg IPC 软解
            ~180ms/帧、或硬解不可得而落到软解（3440x1440 ~190ms/帧、720p ~50ms/帧，
            观感幻灯片）时用户只能看到「画面变幻灯」，必须当场给出原因，否则就只能靠
            终端日志推断。
          诊断口径关闭时 .synthetic-metrics 仍会在异常态出现（e2e 的就绪判据与「最近错误」
          断言依赖这个挂点），只是它退化为一行原因说明。 */}
      {/* P203：HDR 提示走**独立通道**，不进指标条。
          原因（实测）：指标条在生产构建渲染后约 2-4 秒必崩渲染进程（既有缺陷，
          anomaly=true 恒真同样崩），而本提示的价值恰恰是「用户点播放前就知道
          原因」，不能依附于一条会崩的通道。
          定位：absolute 覆盖在预览区顶部，不参与指标条布局。 */}
      {/* P203：HDR 提示。
          **绝不能用内联 `position:absolute` + 背景色的组合**：实测该写法会让渲染
          进程在 2-4 秒内崩溃（本机 P010 仅 SOFTWARE 支持、合成器脆弱，独立合成层
          触发 GPU 崩溃）。改用普通文档流 + CSS 类，等价信息、零合成层。
          同理也不放进 `.synthetic-metrics`（那条通道同样会崩，见 anomaly 注释）。 */}
      {load.status === "ready" && hdrBlocked && (
        <div className="synthetic-hdr-notice" role="status">
          当前显示环境不支持 HDR，该素材为 HDR（10-bit）。实时预览可能无法播放或卡顿。建议先转码为 SDR，或使用支持 HDR 的显示环境。
        </div>
      )}
      {/* A3：代理已就绪、当前会话还没切过去（播放中挂起）→ 弱提示给知情权，
          不打断、不刺眼。样式复用 .synthetic-hdr-notice 的安全范式（普通文档流
          + 纯色背景 + CSS 类）：2026-11-01 实测内联 position:absolute + 半透明
          背景会让渲染进程在 2-4 秒内崩溃，故此处绝不自带内联定位。 */}
      {load.status === "ready" && proxyEpoch !== undefined && proxyEpoch !== proxyAppliedEpoch.current && (
        <div className="synthetic-hdr-notice synthetic-proxy-notice" role="status">
          高清代理已就绪，暂停后自动切换
        </div>
      )}
      {load.status === "ready" && metrics && (perfHud || anomaly) && (
        <div className={`synthetic-metrics${metrics.last_error ? " err" : ""}`}>
          {showPerfNumbers && <span>{`合成预览 · 任务 p95 ${metrics.task_ms_p95}ms · 解码 p50 ${metrics.decode_ms_p50}ms / p95 ${metrics.decode_ms_p95}ms · 上传 p95 ${metrics.upload_ms_p95}ms · 丢帧 ${metrics.dropped_frames} · 画布 ${metrics.canvas_w}×${metrics.canvas_h} → 缓冲 ${metrics.backing_w}×${metrics.backing_h} (×${metrics.fit_scale})`}</span>}
          {metrics.last_error && <span className="synthetic-metric-err">{`最近错误：${metrics.last_error}`}</span>}
          {/* P203：HDR 素材在当前环境不可解码——**必须在用户点播放前就可见**，
              否则表现就是「点播放 → 整个界面失去响应 → 没有任何解释」。
              文案对齐剪映的做法（明确说是环境问题 + 给出可操作建议），
              避免用户误以为是素材损坏或软件故障。 */}
          {(perfHud ? backendDegraded : backendIsFfmpeg) && (
            <span className="synthetic-backend-warn">{`解码后端 ${metrics.decode_backend}（已降级，慢路径）`}</span>
          )}
          {hardwareMissing && (
            <span className="synthetic-backend-warn">{`硬解不可用（${metrics.decode_hardware}，软件解码）`}</span>
          )}
          {/* 分段计时（dev 默认开、可通过 VITE_AIVS_DECODE_TIMING=1 强制）：
              把「解码 p95 的尾巴」拆成 喂包 / 出帧 / 残差 三段——p95 高到底是
              我们喂得慢、解码器吐得慢，还是排队/传输慢，一眼可判。 */}
          {perfHud && metrics.decode_seg && (
            <span>{`分段 喂包 ${metrics.decode_seg.feed_p95} / 出帧 ${metrics.decode_seg.output_p95} / 排队 ${metrics.decode_seg.queue_p95} / 残差 ${metrics.decode_seg.residual_p95}ms(p95)`}</span>
          )}
          {perfHud && residency !== null && (
            <span className="synthetic-residency-warn">{residency}</span>
          )}
        </div>
      )}
    </div>
  );
}
