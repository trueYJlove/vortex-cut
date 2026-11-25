import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AssetPresentation,
  Job,
  Project,
  TimelineCaption,
  TimelineClip,
  TimelineDocument,
  TimelineState,
} from "@aivideo/contracts";
import type { ExportRecordPresentation } from "../../../electron/preload/index.js";
import type { AssetDecodeBudget } from "../preview/preview-session.js";
import { clampMediaRate, mediaRateIsPlayable } from "../preview/media-rate.js";
import { PreviewSourceResolver } from "../preview/source-resolver.js";
import { createScrubTellGate } from "../preview/viewer-zoom.js";
import { createPlayheadStore, type PlayheadStore } from "../timeline/playhead-store.js";
import type { TimeRange } from "../timeline/time-range.js";
import { WaveformCache } from "../timeline/waveform-cache.js";
import { duration, formatSmpteTimecode, type NoticeTone } from "../appHelpers.js";

type VuGraph = {
  ctx: AudioContext;
  analyserL: AnalyserNode;
  analyserR: AnalyserNode;
  dataL: Uint8Array<ArrayBuffer>;
  dataR: Uint8Array<ArrayBuffer>;
  raf: number;
};

export interface UsePreviewPlaybackParams {
  project: Project | undefined;
  timeline: TimelineState | undefined;
  working: TimelineDocument | undefined;
  assets: AssetPresentation[];
  jobs: Job[];
  sortedClips: TimelineClip[];
  trackById: Map<string, TimelineDocument["tracks"][number]>;
  timelineEndUs: number;
  isClipAudible: (clip: TimelineClip) => boolean;
  selectedCaption: TimelineCaption | undefined;
  setExportPlayback: (value: ExportRecordPresentation | undefined) => void;
  loadProjectData: (selected: Project) => Promise<void>;
  showNotice: (text: string, tone?: NoticeTone) => void;
}

export function usePreviewPlayback({
  project,
  timeline,
  working,
  assets,
  jobs,
  sortedClips,
  trackById,
  timelineEndUs,
  isClipAudible,
  selectedCaption,
  setExportPlayback,
  loadProjectData,
  showNotice,
}: UsePreviewPlaybackParams) {
  // 素材箱双击预览：仅播放素材，不加入时间线。任何时间线交互都会退出该模式。
  const [libraryPreviewId, setLibraryPreviewId] = useState<string | null>(null);
  /** 代理就绪 → 清该素材的预览源解析缓存（方案 A：下次解析走代理，不重建
   *  当前预览会话，因此不能走 state 触发重渲染）。 */
  const invalidateProxySourceRef = useRef<(assetId: string) => void>(() => undefined);
  /** **已请求过代理的素材集合**（本会话唯一台账）。 */
  const proxyJobAssetIdsRef = useRef<Set<string>>(new Set());
  /** 代理作业已到终态的素材（成功 = 已就绪，失败 = 不重试）。 */
  const proxyJobSettledAssetIdsRef = useRef<Set<string>>(new Set());
  /** 请求一个素材的代理（项目就绪前没有端点可调，故经 ref 由渲染期注入）。 */
  const requestProxyJobRef = useRef<(assetId: string) => void>(() => undefined);
  const requestProxyJob = useCallback((assetId: string) => {
    requestProxyJobRef.current(assetId);
  }, []);
  /** 播放类桌面设置（导入即生成代理 / 代理分辨率档位）。 */
  const [playbackSettings, setPlaybackSettings] = useState<{ auto: boolean; quality: "auto" | "540" | "720" | "1080" }>({ auto: true, quality: "auto" });
  useEffect(() => {
    let active = true;
    void window.desktop.getSettings().then(state => {
      if (!active) return;
      const auto = typeof state.saved.preview_proxy_auto === "boolean" ? state.saved.preview_proxy_auto : true;
      const quality = state.saved.preview_proxy_quality ?? "auto";
      setPlaybackSettings({ auto, quality });
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  /** A2：代理就绪计数（单调）。递增 = 请求预览把源切到代理；只在暂停时消费。 */
  const [proxyReadyEpoch, setProxyReadyEpoch] = useState(0);
  /** A2：播放中挂起的代理切换（就绪了但还没到自然切换点）。 */
  const proxySwitchPendingRef = useRef(false);

  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  // 播放头命令存储（A06）：预览每帧写入（高频、不驱动 React 全树重渲染）。
  const playheadStoreRef = useRef<PlayheadStore | null>(null);
  if (!playheadStoreRef.current) playheadStoreRef.current = createPlayheadStore();
  const playheadStore = playheadStoreRef.current;

  const [previewMode, setPreviewMode] = useState<"interactive" | "authoritative" | "synthetic">("synthetic");
  const [syntheticNotice, setSyntheticNotice] = useState<string | null>(null);
  const [volume, setVolume] = useState(80);
  const [loopPlayback, setLoopPlayback] = useState(false);
  const [playbackRange, setPlaybackRange] = useState<TimeRange | null>(null);
  const loopRestartTimer = useRef<number | null>(null);
  const loopSeekEpoch = useRef(0);
  const loopSeekPending = useRef(false);
  const cancelLoopRestart = () => {
    loopSeekEpoch.current += 1;
    loopSeekPending.current = false;
    if (loopRestartTimer.current !== null) window.clearTimeout(loopRestartTimer.current);
    loopRestartTimer.current = null;
  };
  useEffect(() => () => cancelLoopRestart(), [project?.project_id]);
  const [uiRate, setUiRate] = useState(1);

  const previewSessionRef = useRef<{
    seekToFrame(target: number): Promise<number>;
    play(): void;
    pause(): void;
    beginScrubStorm(): void;
    endScrubStorm(): void;
    getMeterSamples?(): readonly [Float32Array, Float32Array] | null;
  } | null>(null);
  const preparePreviewPlaybackRef = useRef<(() => void) | null>(null);
  const lastDirectSeekFrameRef = useRef(-1);
  const volumeRef = useRef(volume);
  const [progressDragging, setProgressDragging] = useState(false);
  const scrubTellGate = useRef(createScrubTellGate(15, () => performance.now()));
  const progressRef = useRef<HTMLDivElement | null>(null);
  const volRailRef = useRef<HTMLDivElement | null>(null);
  const [vuEpoch, setVuEpoch] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const seenAnyTicketRef = useRef(false);
  const noTicketRetryRef = useRef(0);
  const noTicketFinalRetryRef = useRef(false);

  // B16b：编辑器负载上报（playing/scrubbing/idle）——状态转换即时推送 + 1s 保活。
  useEffect(() => {
    const mode = progressDragging ? "scrubbing" : playing ? "playing" : "idle";
    const push = () => {
      window.desktop.updateEditorLoad(mode).catch(() => undefined);
    };
    push();
    const keepAlive = window.setInterval(push, 1_000);
    return () => {
      window.clearInterval(keepAlive);
    };
  }, [playing, progressDragging]);

  const resetPreviewOnProjectSwitch = useCallback(() => {
    setLibraryPreviewId(null);
    setPlaying(false);
    setSyntheticNotice(null);
    setPreviewMode("synthetic");
    seenAnyTicketRef.current = false;
    noTicketRetryRef.current = 0;
    noTicketFinalRetryRef.current = false;
  }, []);

  // 代理就绪检测
  useEffect(() => {
    for (const job of jobs) {
      const assetId = job.asset_id;
      if (job.kind !== "proxy" || !assetId || !proxyJobAssetIdsRef.current.has(assetId)) continue;
      if (job.status !== "succeeded" && job.status !== "failed") continue;
      proxyJobAssetIdsRef.current.delete(assetId);
      proxyJobSettledAssetIdsRef.current.add(assetId);
      if (job.status === "succeeded") {
        invalidateProxySourceRef.current(assetId);
        proxySwitchPendingRef.current = true;
        if (!playing) {
          proxySwitchPendingRef.current = false;
          setProxyReadyEpoch(epoch => epoch + 1);
        }
      }
    }
  });

  // A2：自然切换点提交——播放中挂起的代理切换，在暂停那一刻读成一次重建信号。
  useEffect(() => {
    if (playing || !proxySwitchPendingRef.current) return;
    proxySwitchPendingRef.current = false;
    setProxyReadyEpoch(epoch => epoch + 1);
  }, [playing]);

  // 代理登记的唯一入口（导入即转 + 实测解不动共用）：去重、不阻塞、失败静默。
  requestProxyJobRef.current = (assetId: string) => {
    if (!project) return;
    if (!playbackSettings.auto) return;
    if (proxyJobAssetIdsRef.current.has(assetId)) return;
    proxyJobAssetIdsRef.current.add(assetId);
    const profile = playbackSettings.quality === "auto"
      ? undefined
      : (`preview-${playbackSettings.quality}-v1` as "preview-540-v1" | "preview-720-v1" | "preview-1080-v1");
    void window.desktop.createPreviewSourceJob({
      project_id: project.project_id,
      asset_id: assetId,
      ...(profile ? { profile_id: profile } : {}),
    }).catch(() => undefined);
  };

  const onDecodeBudget = useCallback((verdicts: AssetDecodeBudget[]) => {
    for (const verdict of verdicts) {
      if (!verdict.over_budget) continue;
      if (proxyJobSettledAssetIdsRef.current.has(verdict.asset_id)) continue;
      requestProxyJobRef.current(verdict.asset_id);
    }
  }, []);

  const tracksAtPlayhead = working?.tracks ?? [];
  const visualTracksAtPlayhead = useMemo(
    () => tracksAtPlayhead.filter(t => t.kind === "video" && !t.hidden),
    [tracksAtPlayhead],
  );
  const clipAtPlayhead = useMemo(() => {
    for (const track of visualTracksAtPlayhead) {
      const clip = sortedClips.find(c => c.track_id === track.id && playhead >= c.timeline_start_us && playhead < c.timeline_end_us);
      if (clip) return clip;
    }
    return undefined;
  }, [visualTracksAtPlayhead, sortedClips, playhead]);
  const a1Clips = useMemo(() => sortedClips.filter(c => c.track_id === "A1"), [sortedClips]);
  const audioClipAtPlayhead = a1Clips.length > 0 ? a1Clips.find(c => playhead >= c.timeline_start_us && playhead < c.timeline_end_us) : undefined;
  const previewSpeedMilli = clipAtPlayhead?.speed_milli ?? (libraryPreviewId ? undefined : 1000);
  const previewReverse = Boolean(clipAtPlayhead?.reverse_playback);
  const interactiveMediaRate = previewReverse ? 1 : ((previewSpeedMilli ?? 1000) / 1000) * uiRate;
  const interactiveMediaRatePlayable = mediaRateIsPlayable(interactiveMediaRate);
  const previewAsset = (libraryPreviewId ? assets.find(item => item.asset.asset_id === libraryPreviewId) : undefined)
    ?? (clipAtPlayhead ? assets.find(item => item.asset.asset_id === clipAtPlayhead.asset_id) : undefined);
  const mainTransform = clipAtPlayhead?.transform;
  const mainTransformStyle = mainTransform
    ? {
        transform: `translate(${((mainTransform.x ?? 0.5) - 0.5) * 100}%, ${((mainTransform.y ?? 0.5) - 0.5) * 100}%) scale(${mainTransform.scale ?? 1}) rotate(${mainTransform.rotate ?? 0}deg)`,
        opacity: mainTransform.opacity ?? 1,
      }
    : undefined;
  const audioAsset = audioClipAtPlayhead ? assets.find(item => item.asset.asset_id === audioClipAtPlayhead.asset_id) : undefined;

  useEffect(() => {
    const media = videoRef.current;
    if (media) {
      if (pendingSeekRef.current !== null) { media.currentTime = pendingSeekRef.current; pendingSeekRef.current = null; }
      media.playbackRate = clampMediaRate(interactiveMediaRate);
      if (!libraryPreviewId && clipAtPlayhead) {
        const sourceStart = (clipAtPlayhead.source_start_us ?? 0) / 1_000_000;
        const speed = interactiveMediaRate;
        const expected = sourceStart + ((playhead - clipAtPlayhead.timeline_start_us) / 1_000_000) * speed;
        const threshold = interactiveMediaRatePlayable ? 0.18 : 1 / 30;
        if (media.readyState >= 1 && Math.abs(media.currentTime - expected) > threshold) media.currentTime = Math.max(0, expected);
      }
      if (playing && (libraryPreviewId || clipAtPlayhead) && interactiveMediaRatePlayable) {
        media.play().catch(() => {
          if (media.error) setPlaying(false);
        });
      } else {
        media.pause();
      }
    }
    const audio = audioRef.current;
    if (audio) {
      if (audioClipAtPlayhead && isClipAudible(audioClipAtPlayhead)) {
        const sourceStart = (audioClipAtPlayhead.source_start_us ?? 0) / 1_000_000;
        const elapsed = (playhead - audioClipAtPlayhead.timeline_start_us) / 1_000_000;
        audio.currentTime = sourceStart + elapsed * ((audioClipAtPlayhead.speed_milli ?? 1000) / 1000);
        const speed = ((audioClipAtPlayhead.speed_milli ?? 1000) / 1000) * uiRate;
        audio.playbackRate = clampMediaRate(speed);
        if (playing && mediaRateIsPlayable(speed)) void audio.play().catch(() => {}); else audio.pause();
      } else {
        audio.pause();
      }
    }
  }, [playing, previewMode, previewAsset?.media_url, audioAsset?.media_url, playhead, previewSpeedMilli, previewReverse, audioClipAtPlayhead, isClipAudible, uiRate]);

  // 音量：应用到当前播放的媒体元素（0-100 → 0-1）；同时同步给 VU 模拟电平使用。
  useEffect(() => {
    volumeRef.current = volume;
    const vol = Math.max(0, Math.min(1, volume / 100));
    if (videoRef.current) videoRef.current.volume = vol;
    if (audioRef.current) audioRef.current.volume = vol;
  }, [volume, previewAsset?.media_url, audioAsset?.media_url]);

  // 音量动画（电平表）：挂接预览视频或合成会话的实时输出电平。
  const meterTimeL = useRef<Float32Array | null>(null);
  const meterTimeR = useRef<Float32Array | null>(null);
  const vuGraphRef = useRef<{ el: HTMLMediaElement; graph: VuGraph } | null>(null);
  const meterLevels = useCallback((): readonly [Float32Array, Float32Array] | null => {
    const sessionSamples = previewSessionRef.current?.getMeterSamples?.() ?? null;
    if (sessionSamples) return sessionSamples;
    const entry = vuGraphRef.current;
    if (!entry) return null;
    if (!meterTimeL.current || meterTimeL.current.length !== entry.graph.analyserL.fftSize) {
      meterTimeL.current = new Float32Array(entry.graph.analyserL.fftSize);
      meterTimeR.current = new Float32Array(entry.graph.analyserR.fftSize);
    }
    entry.graph.analyserL.getFloatTimeDomainData(meterTimeL.current);
    entry.graph.analyserR.getFloatTimeDomainData(meterTimeR.current!);
    return [meterTimeL.current, meterTimeR.current!] as const;
  }, []);
  const stopVuPolling = useCallback(() => {
    const entry = vuGraphRef.current;
    if (entry) cancelAnimationFrame(entry.graph.raf);
  }, []);
  useEffect(() => {
    if (!playing) { stopVuPolling(); return; }
    const media = videoRef.current;
    if (!media || media.readyState === 0) {
      if (media) {
        const retry = () => setVuEpoch(epoch => epoch + 1);
        media.addEventListener("canplay", retry, { once: true });
        return () => media.removeEventListener("canplay", retry);
      }
      return;
    }
    const AudioCtx = window.AudioContext;
    if (!AudioCtx) return;
    const attach = (): VuGraph | null => {
      if (vuGraphRef.current?.el === media) return vuGraphRef.current.graph;
      const graph = vuGraphRef.current?.graph;
      if (graph) cancelAnimationFrame(graph.raf);
      try {
        const ctx = new AudioCtx();
        const source = ctx.createMediaElementSource(media);
        const splitter = ctx.createChannelSplitter(2);
        const analyserL = ctx.createAnalyser();
        const analyserR = ctx.createAnalyser();
        analyserL.fftSize = 256;
        analyserR.fftSize = 256;
        source.connect(splitter);
        splitter.connect(analyserL, 0);
        splitter.connect(analyserR, 1);
        source.connect(ctx.destination);
        const entry = {
          el: media,
          graph: {
            ctx,
            analyserL,
            analyserR,
            dataL: new Uint8Array(analyserL.frequencyBinCount),
            dataR: new Uint8Array(analyserR.frequencyBinCount),
            raf: 0,
          },
        };
        vuGraphRef.current = entry;
        return entry.graph;
      } catch {
        return null;
      }
    };
    const entryGraph = attach();
    if (!entryGraph) return;
    void entryGraph.ctx.resume().catch(() => undefined);
    entryGraph.raf = requestAnimationFrame(() => undefined);
  }, [playing, previewAsset?.media_url, previewMode, vuEpoch, stopVuPolling]);

  const visibleCaption = working?.captions.find(item => playhead >= item.start_us && playhead < item.end_us) ?? selectedCaption;
  const totalUs = duration(working);

  // 播放/暂停统一入口：播放头停在时间线末尾时，再次播放从头开始。
  const togglePlayback = () => {
    cancelLoopRestart();
    if (!playing && loopPlayback && playbackRange && !libraryPreviewId &&
        (playheadStore.get() < playbackRange.startUs || playheadStore.get() >= playbackRange.endUs)) {
      playheadStore.dispatch({ source: "user", timeUs: playbackRange.startUs });
      const session = previewMode === "synthetic" ? previewSessionRef.current : null;
      if (session) {
        const epoch = ++loopSeekEpoch.current;
        preparePreviewPlaybackRef.current?.();
        const fps = working?.canvas.fps_num && working.canvas.fps_den ? working.canvas.fps_num / working.canvas.fps_den : 30;
        void session.seekToFrame(Math.floor(playbackRange.startUs / 1_000_000 * fps)).then(frame => {
          if (frame >= 0 && epoch === loopSeekEpoch.current && previewSessionRef.current === session) {
            setPlayhead(playbackRange.startUs);
            setPlaying(true);
          }
        }).catch(() => setPlaying(false));
        return;
      }
      setPlayhead(playbackRange.startUs);
    } else if (!playing && timelineEndUs > 0 && playhead >= timelineEndUs) setPlayhead(0);
    setPlaying(value => !value);
  };

  // ── 播放头命令通道（A06）──────────────────────────────────────────────────
  const dispatchPlayhead = useCallback((source: "user" | "playback" | "external", timeUs: number, commitReact: boolean) => {
    playheadStore.dispatch({ source, timeUs });
    if (commitReact) setPlayhead(timeUs);
  }, [playheadStore]);

  const scrubToldAt = useRef(0);
  const SCRUB_PICTURE_MS = 15;
  const SCRUB_STATE_MS = 100;
  /** S7：15ms 门控只用于 interactive HTMLMediaElement 的 pendingSeek 写入；
   *  synthetic session.seekToFrame 保留自身目标帧去重，绝不再叠第二层节流。 */
  const tellMediaSeek = useCallback((timeUs: number, clip?: TimelineClip) => {
    void SCRUB_PICTURE_MS;
    if (!videoRef.current || !scrubTellGate.current.allow()) return;
    if (clip) {
      const sourceStart = (clip.source_start_us ?? 0) / 1_000_000;
      const elapsed = (timeUs - clip.timeline_start_us) / 1_000_000 * ((clip.speed_milli ?? 1000) / 1000);
      pendingSeekRef.current = sourceStart + elapsed;
    } else {
      pendingSeekRef.current = timeUs / 1_000_000;
    }
  }, []);

  /** 拖动/擦洗中的即时跳转：线条每帧走，画面与状态按上表节流。 */
  const seekWhileScrubbing = useCallback((timeUs: number) => {
    dispatchPlayhead("user", timeUs, false);
    const session = previewSessionRef.current;
    if (session && previewMode === "synthetic" && !libraryPreviewId) {
      scrubTellGate.current.reset();
      session.beginScrubStorm();
      const fps = working?.canvas.fps_num && working.canvas.fps_den ? working.canvas.fps_num / working.canvas.fps_den : 30;
      const targetFrame = Math.max(0, Math.floor((timeUs / 1e6) * fps));
      if (targetFrame !== lastDirectSeekFrameRef.current) {
        lastDirectSeekFrameRef.current = targetFrame;
        void session.seekToFrame(targetFrame);
      }
      if (performance.now() - scrubToldAt.current >= SCRUB_STATE_MS) {
        setPlayhead(timeUs);
        scrubToldAt.current = performance.now();
      }
      return;
    }
    const clip = sortedClips.find(c => timeUs >= c.timeline_start_us && timeUs < c.timeline_end_us);
    tellMediaSeek(timeUs, clip);
    setPlayhead(timeUs);
    scrubToldAt.current = performance.now();
  }, [dispatchPlayhead, previewMode, libraryPreviewId, working?.canvas.fps_num, working?.canvas.fps_den, tellMediaSeek, sortedClips]);

  /** 一次擦洗结束（松手/键盘跳转）：落到精确值并提交 React。 */
  const commitScrub = useCallback((timeUs: number) => {
    cancelLoopRestart();
    setPlaying(false);
    dispatchPlayhead("user", timeUs, true);
    scrubToldAt.current = 0;
    lastReactTimeReport.current = 0;
    lastDirectSeekFrameRef.current = -1;
    scrubTellGate.current.reset();
    previewSessionRef.current?.endScrubStorm();
  }, [dispatchPlayhead]);

  const seekFromUser = useCallback((timeUs: number) => {
    commitScrub(timeUs);
  }, [commitScrub]);

  const lastReactTimeReport = useRef(0);
  const PLAYBACK_COMMIT_INTERVAL_MS = import.meta.env.DEV ? 250 : 100;
  const playingRef = useRef(false);
  const playheadDomRef = useRef<(us: number) => void>(() => undefined);

  useEffect(() => {
    if (previewMode !== "synthetic" || libraryPreviewId) return;
    if (playing) {
      playheadStore.startLine({ tUs: playheadStore.get(), atMs: performance.now(), rate: Math.round(1000 * uiRate) });
    } else {
      playheadStore.stopLine();
    }
  }, [playing, previewMode, libraryPreviewId, playheadStore, uiRate]);

  const seekFromPlayback = useCallback((timeUs: number) => {
    const now = performance.now();
    if (playingRef.current) {
      if (loopPlayback && playbackRange && !libraryPreviewId && timeUs >= playbackRange.endUs) {
        const session = previewSessionRef.current;
        if (!session || loopSeekPending.current) return;
        loopSeekPending.current = true;
        const epoch = ++loopSeekEpoch.current;
        session.pause();
        playheadStore.stopLine();
        dispatchPlayhead("user", playbackRange.startUs, true);
        const fps = working?.canvas.fps_num && working.canvas.fps_den ? working.canvas.fps_num / working.canvas.fps_den : 30;
        void session.seekToFrame(Math.floor(playbackRange.startUs / 1_000_000 * fps)).then(frame => {
          if (epoch !== loopSeekEpoch.current || previewSessionRef.current !== session || !playingRef.current) return;
          loopSeekPending.current = false;
          if (frame < 0) { setPlaying(false); return; }
          playheadStore.startLine({ tUs: playbackRange.startUs, atMs: performance.now(), rate: Math.round(1000 * uiRate) });
          session.play();
        }).catch(() => { if (epoch === loopSeekEpoch.current) { loopSeekPending.current = false; setPlaying(false); } });
        return;
      }
      playheadDomRef.current(timeUs);
      lastReactTimeReport.current = now;
      return;
    }
    const commit = now - lastReactTimeReport.current >= PLAYBACK_COMMIT_INTERVAL_MS;
    dispatchPlayhead("playback", timeUs, commit);
    if (commit) lastReactTimeReport.current = now;
  }, [dispatchPlayhead, loopPlayback, playbackRange, libraryPreviewId, playheadStore, working, uiRate]);

  const handlePreviewEnded = useCallback(() => {
    if (loopSeekPending.current) return;
    if (!loopPlayback) { setPlaying(false); return; }
    dispatchPlayhead("user", playbackRange?.startUs ?? 0, true);
    setPlaying(false);
    cancelLoopRestart();
    loopRestartTimer.current = window.setTimeout(() => { loopRestartTimer.current = null; setPlaying(true); }, 60);
  }, [loopPlayback, playbackRange, dispatchPlayhead]);

  // 时间线驱动播放（interactive 100ms 时钟）
  useEffect(() => {
    if (!playing || previewMode !== "interactive" || libraryPreviewId) return;
    const timer = window.setInterval(() => {
      const ph = playheadStore.get();
      const next = ph + Math.round(100_000 * uiRate);
      const endUs = loopPlayback && playbackRange ? playbackRange.endUs : timelineEndUs;
      if (endUs > 0 && next >= endUs) {
        if (loopPlayback) { dispatchPlayhead("playback", playbackRange?.startUs ?? 0, true); return; }
        dispatchPlayhead("playback", timelineEndUs, true);
        setPlaying(false);
        return;
      }
      dispatchPlayhead("playback", next, true);
    }, 100);
    return () => window.clearInterval(timer);
  }, [playing, previewMode, libraryPreviewId, timelineEndUs, playheadStore, dispatchPlayhead, uiRate, loopPlayback, playbackRange]);

  const handleVideoEnded = () => {
    if (libraryPreviewId) setPlaying(false);
  };

  const timelineAssetMedia = useMemo(
    () => assets.map(item => ({
      asset_id: item.asset.asset_id,
      media_url: item.media_url,
      kind: item.asset.kind,
      display_name: item.asset.display_name,
      duration_us: typeof item.asset.media_info?.duration_us === "number" ? item.asset.media_info.duration_us : null,
      has_audio: Array.isArray(item.asset.media_info?.audio_streams) && item.asset.media_info.audio_streams.length > 0,
    })),
    [assets],
  );

  const ensureFilmstripForAsset = useCallback((assetId: string) => {
    if (!project) return;
    void window.desktop.ensureFilmstrip({
      project_id: project.project_id,
      asset_id: assetId,
      step_ms: 1000,
      generate: true,
    }).catch(() => undefined);
  }, [project]);

  const syntheticMediaUrls = useMemo(
    () => new Map(assets.flatMap(item => item.media_url ? [[item.asset.asset_id, item.media_url] as const] : [])),
    [assets],
  );
  const projectStateReady = Boolean(
    project &&
    timeline &&
    working &&
    timeline.project_id === project.project_id &&
    timeline.current_revision.project_id === project.project_id &&
    working.project_id === project.project_id,
  );
  const previewSourceResolver = useMemo(
    () => project ? new PreviewSourceResolver({
      getPreviewSource: input => window.desktop.getPreviewSource({ ...input, project_id: project.project_id }),
      previewSourceMediaUrl: input => window.desktop.previewSourceMediaUrl({ ...input, project_id: project.project_id }),
    }, project.project_id) : null,
    [project],
  );
  invalidateProxySourceRef.current = assetId => previewSourceResolver?.invalidate(assetId);

  const waveformCache = useMemo(
    () => project ? new WaveformCache({
      getWaveform: input => window.desktop.getWaveform({ ...input, project_id: project.project_id }),
      waveformMediaUrl: input => window.desktop.waveformMediaUrl({ ...input, project_id: project.project_id }),
    }, project.project_id) : null,
    [project?.project_id],
  );
  useEffect(() => () => { waveformCache?.dispose(); }, [waveformCache]);

  const syntheticAudioByClip = useMemo(
    () => new Map((working?.clips ?? []).flatMap(clip => clip.audio ? [[clip.clip_id, {
      enabled: isClipAudible(clip),
      gainDb: clip.audio.gain_db,
      fadeInUs: clip.audio.fade_in_us,
      fadeOutUs: clip.audio.fade_out_us,
    }] as const] : [])),
    [working, isClipAudible],
  );
  const syntheticPipClips = useMemo(
    () => (working?.clips ?? [])
      .filter(clip => clip.asset_kind !== "audio" && trackById.get(clip.track_id)?.kind === "video")
      .map(clip => ({
        clipId: clip.clip_id,
        transform: {
          x: clip.transform?.x,
          y: clip.transform?.y,
          scale: clip.transform?.scale,
          rotate: clip.transform?.rotate,
          opacity: clip.transform?.opacity,
        },
        mask: clip.mask ?? undefined,
      })),
    [working, trackById],
  );
  const syntheticTicketsReady = useMemo(
    () => Boolean(working) && working!.clips.every(clip => syntheticMediaUrls.has(clip.asset_id)),
    [working, syntheticMediaUrls],
  );
  if (syntheticMediaUrls.size > 0) seenAnyTicketRef.current = true;
  useEffect(() => {
    if (previewMode === "synthetic" && syntheticNotice === null && !seenAnyTicketRef.current) return;
    if (previewMode !== "interactive" || !syntheticNotice?.includes("no ticket")) return;
    if (syntheticTicketsReady) {
      setSyntheticNotice(null);
      setPreviewMode("synthetic");
      return;
    }
    if (!seenAnyTicketRef.current) {
      setSyntheticNotice(null);
      setPreviewMode("synthetic");
      return;
    }
    if (!project) return;
    if (noTicketRetryRef.current >= 3) {
      if (noTicketFinalRetryRef.current) return;
      noTicketFinalRetryRef.current = true;
      const timer = window.setTimeout(() => { void loadProjectData(project).catch(() => undefined); }, 5000);
      return () => window.clearTimeout(timer);
    }
    noTicketRetryRef.current += 1;
    void loadProjectData(project).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMode, syntheticNotice, syntheticTicketsReady, project?.project_id, syntheticMediaUrls]);

  // 画中画手势期间暂停预览播放
  const gestureHoldRef = useRef(false);
  const pausePreviewPlayback = () => {
    gestureHoldRef.current = true;
    const video = videoRef.current;
    if (video && !video.paused) { video.pause(); return true; }
    return false;
  };
  const resumePreviewPlayback = (wasPlaying: boolean) => {
    gestureHoldRef.current = false;
    if (wasPlaying) void videoRef.current?.play().catch(() => {});
  };

  const previewFromLibrary = (item: AssetPresentation) => {
    if (!item.media_url || item.asset.availability !== "available") return;
    setLibraryPreviewId(item.asset.asset_id);
    setPreviewMode("interactive");
    setExportPlayback(undefined);
    setPlaying(true);
  };
  const exitLibraryPreview = () => {
    if (!libraryPreviewId) return;
    setLibraryPreviewId(null);
    if (previewMode === "interactive" && !syntheticNotice) setPreviewMode("synthetic");
  };

  const previewFps = working?.canvas.fps_num && working.canvas.fps_den ? working.canvas.fps_num / working.canvas.fps_den : 30;
  const progressPct = Math.max(0, Math.min(100, (playhead / Math.max(totalUs, 1)) * 100));
  const pgBubbleRef = useRef<HTMLDivElement | null>(null);
  const pgFillRef = useRef<HTMLDivElement | null>(null);
  const tcTimeRef = useRef<HTMLElement | null>(null);
  playheadDomRef.current = (us: number): void => {
    const clamped = Math.max(0, Math.min(us, totalUs));
    const pct = totalUs > 0 ? (clamped / totalUs) * 100 : 0;
    const text = formatSmpteTimecode(clamped, previewFps);
    if (tcTimeRef.current && tcTimeRef.current.textContent !== text) tcTimeRef.current.textContent = text;
    if (pgBubbleRef.current) {
      pgBubbleRef.current.textContent = text;
      pgBubbleRef.current.style.left = `${pct}%`;
    }
    if (pgFillRef.current) pgFillRef.current.style.width = `${pct}%`;
    progressRef.current?.setAttribute("aria-valuenow", String(clamped));
  };
  playingRef.current = playing && !gestureHoldRef.current;

  /** 进度条拖动中：走分层节流（画面 15ms / 状态 100ms / 线条每帧）。 */
  const scrubFromProgress = (clientX: number) => {
    const element = progressRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    seekWhileScrubbing(Math.round(ratio * Math.max(totalUs, 1)));
  };
  const seekFromProgressRatio = (ratio: number) => {
    exitLibraryPreview();
    const value = Math.round(ratio * Math.max(totalUs, 1));
    seekFromUser(value);
    const clip = sortedClips.find(c => value >= c.timeline_start_us && c.timeline_end_us > value);
    scrubTellGate.current.reset();
    tellMediaSeek(value, clip);
  };
  const seekFromProgress = (clientX: number) => {
    const el = progressRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    seekFromProgressRatio((clientX - rect.left) / rect.width);
  };
  const seekVolumeFrom = (clientY: number) => {
    const rail = volRailRef.current;
    if (!rail) return;
    const rect = rail.getBoundingClientRect();
    if (rect.height <= 0) return;
    setVolume(Math.round(Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height)) * 100));
  };

  void showNotice;

  return {
    libraryPreviewId, setLibraryPreviewId,
    playbackSettings, setPlaybackSettings,
    proxyReadyEpoch,
    requestProxyJob, onDecodeBudget,
    playing, setPlaying,
    playhead, setPlayhead,
    playheadStore,
    previewMode, setPreviewMode,
    syntheticNotice, setSyntheticNotice,
    volume, setVolume, volumeRef,
    loopPlayback, setLoopPlayback,
    playbackRange, setPlaybackRange,
    uiRate, setUiRate,
    previewSessionRef, preparePreviewPlaybackRef,
    progressDragging, setProgressDragging,
    progressRef, volRailRef, pgBubbleRef, pgFillRef, tcTimeRef,
    videoRef, audioRef,
    resetPreviewOnProjectSwitch,
    clipAtPlayhead, audioClipAtPlayhead,
    previewAsset, mainTransformStyle, audioAsset,
    previewReverse, interactiveMediaRatePlayable,
    seenAnyTicketRef, loopSeekPending, cancelLoopRestart,
    meterLevels, visibleCaption, totalUs, previewFps, progressPct,
    togglePlayback, dispatchPlayhead, seekWhileScrubbing, commitScrub, seekFromUser, seekFromPlayback,
    handlePreviewEnded, handleVideoEnded,
    timelineAssetMedia, ensureFilmstripForAsset,
    syntheticMediaUrls, projectStateReady, previewSourceResolver,
    waveformCache, syntheticAudioByClip, syntheticPipClips,
    gestureHoldRef, pausePreviewPlayback, resumePreviewPlayback,
    previewFromLibrary, exitLibraryPreview,
    scrubFromProgress, seekFromProgressRatio, seekFromProgress, seekVolumeFrom,
  };
}
