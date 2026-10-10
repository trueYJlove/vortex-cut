import { useEffect, useMemo, useState } from "react";
import type {
  BeatAnalysisSummary,
  EditingGrammarPrepareResult,
  EditingGrammarProposal,
  EditingGrammarProposalListItem,
  ProjectId,
  TimelineClip,
  TimelineRevisionId,
  TimelineState
} from "@aivideo/contracts";
import { Dialog } from "../Dialog.js";
import { formatLocalStamp } from "../localTime.js";
import { TimelineDiffView } from "../PropertyPanels.js";
import { errorCode, safeErrorMessage } from "../safeErrors.js";

const FAILURE_LABELS: Record<string, string> = {
  EDITING_GRAMMAR_BASE_CONFLICT: "Timeline 基线已变化。下一步：关闭后重新打开，基于最新版本再试。",
  EDITING_GRAMMAR_PARAMS_INVALID: "规划器参数不合法。下一步：检查片段选择与参数范围后重试。",
  EDITING_GRAMMAR_PLANNER_NOT_FOUND: "规划器不存在。下一步：重新打开面板。",
  EDITING_GRAMMAR_NO_SPEECH: "未检测到可用语音。下一步：先对素材做「AI 信号分析」，或显式提供静音区间。",
  EDITING_GRAMMAR_NO_WORDS: "缺少词级时间戳。下一步：先对口播素材开启词级转录。",
  EDITING_GRAMMAR_PROPOSAL_NOT_FOUND: "语法提案不存在。下一步：刷新提案列表。",
  EDITING_GRAMMAR_PROPOSAL_APPLIED: "该提案已应用过，不能重复采纳。下一步：查看结果或发起新的规划。",
  EDITING_GRAMMAR_PROPOSAL_CONFLICT: "提案与当前 Timeline 基线不一致。下一步：基于最新版本重新规划。",
  EDITING_GRAMMAR_PROPOSAL_INVALID: "提案内容无效（例如空操作）。下一步：调整参数后重新规划。",
  TIMELINE_NOT_FOUND: "时间线不存在。下一步：先创建时间线。"
};

type ToolId = "remove_pauses" | "beat_sync" | "lj_cut";

const TOOL_META: Record<ToolId, { title: string; sub: string; desc: string }> = {
  remove_pauses: {
    title: "去停顿",
    sub: "remove_pauses",
    desc: "选中口播视频片段 → 识别静音 → 保留有声段并闭合时间轴。提案只读，采纳后才写正式 Timeline。"
  },
  beat_sync: {
    title: "卡点",
    sub: "beat_sync",
    desc: "BGM 节拍网格吸附镜头切点，强拍优先放高运动/人脸镜头。前置：BGM 已分析节拍。"
  },
  lj_cut: {
    title: "L/J cut",
    sub: "lj_cut",
    desc: "画面切点不变，声音提前（J）或延后（L）。词戳优先 ASR，缺失时能量代理。"
  }
};

function fmtUs(us: number): string {
  const s = Math.max(0, us) / 1e6;
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toFixed(1).padStart(4, "0")}`;
}

function shortId(id: string): string {
  if (!id) return "—";
  return id.length <= 16 ? id : id.slice(0, 12) + "…";
}

function clipSourceRange(clip: TimelineClip): { start: number; end: number } | null {
  const start = clip.source_start_us;
  const end = clip.source_end_us;
  if (typeof start !== "number" || typeof end !== "number") return null;
  return { start, end };
}

function errText(caught: unknown): string {
  const code = errorCode(caught);
  if (FAILURE_LABELS[code]) return FAILURE_LABELS[code];
  const raw = caught instanceof Error ? caught.message : "";
  // 契约校验失败 / IPC 包装后的业务码原样露出，避免一律「操作失败」
  if (raw.includes("Invalid contract") || raw.startsWith("Error invoking")) {
    const bracket = raw.match(/\[([A-Z][A-Z0-9_]{2,})\]/);
    const codePart = bracket ? `[${bracket[1]}] ` : "";
    const tail = raw.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, "");
    return `${codePart}${tail}`.slice(0, 200) || "操作失败。请检查参数与时间线后重试。";
  }
  return safeErrorMessage(caught, raw.startsWith("[")
    ? raw
    : "操作失败。请检查参数与时间线后重试。");
}

function PauseTimeline({ durationUs, minSilenceMs, padMs }: { durationUs: number; minSilenceMs: number; padMs: number }) {
  const dur = Math.max(durationUs, 1);
  const sil = Math.min(0.06, Math.max(0.012, (minSilenceMs / 1000) / (dur / 1e6) * 2));
  const pieces: Array<{ t: "keep" | "silence"; a: number; b: number }> = [
    { t: "keep", a: 0, b: 0.32 },
    { t: "silence", a: 0.32, b: 0.32 + sil },
    { t: "keep", a: 0.32 + sil, b: 0.65 },
    { t: "silence", a: 0.65, b: 0.65 + sil },
    { t: "keep", a: 0.65 + sil, b: 1 }
  ];
  return <>
    <div className="et-timeline" aria-label="静音保留预览">
      <div className="et-lane">
        {pieces.map((p, i) => (
          <div key={i} className={"et-seg-blk " + p.t}
            style={{ left: `${p.a * 100}%`, width: `${(p.b - p.a) * 100}%` }}
            title={p.t === "keep" ? "保留" : `静音 pad=${padMs}ms`} />
        ))}
      </div>
    </div>
    <div className="et-axis">
      <span>0:00</span><span>0:30</span><span>1:00</span><span>1:30</span><span>{fmtUs(durationUs)}</span>
    </div>
    <p className="et-note">预计删除 2 段静音 · 保留时长 ≈ {(dur / 1e6 - (minSilenceMs / 1000) * 2).toFixed(1)}s</p>
  </>;
}

function BeatTimeline({ targetSec, beatsPerShot, shotCount, bpm = 110 }: { targetSec: number; beatsPerShot: number; shotCount: number; bpm?: number }) {
  const beatStep = 60 / bpm;
  const shotDur = beatStep * beatsPerShot;
  const n = Math.max(1, Math.floor(targetSec / shotDur));
  const ticks: number[] = [];
  for (let t = 0; t < 30; t += beatStep) ticks.push(t);
  return <>
    <div className="et-timeline" aria-label="beat 与切点预览" style={{ height: 88 }}>
      <div className="et-lane" style={{ display: "flex", gap: 2, height: 28 }}>
        {Array.from({ length: Math.min(n, 24) }, (_, i) => (
          <div key={i} className="et-seg-blk shot" style={{ flex: 1 }} />
        ))}
      </div>
      <div className="et-ticks">
        {ticks.map((t, i) => (
          <div key={i} className={"et-tick" + (i % 4 === 0 ? " down" : "")} style={{ left: `${(t / 30) * 100}%` }} />
        ))}
        {ticks.filter((_, i) => i % beatsPerShot === 0).map((t, i) => (
          <div key={"c" + i} className="et-cut" style={{ left: `${(t / 30) * 100}%` }} />
        ))}
      </div>
    </div>
    <div className="et-axis"><span>0s</span><span>7.5s</span><span>15s</span><span>22.5s</span><span>30s</span></div>
    <p className="et-note">镜头时长 ≈ {shotDur.toFixed(2)}s（{beatsPerShot} × 60/{bpm}）· 预计 {n} 个镜头 · 选中 {shotCount} 段</p>
  </>;
}

function LjTimeline({ cutSec, offsetMs, mode }: { cutSec: number; offsetMs: number; mode: "auto" | "j" | "l" }) {
  const dir = mode === "auto" ? "j" : mode;
  const delta = dir === "j" ? -offsetMs : offsetMs;
  const cutPct = Math.min(92, Math.max(8, (cutSec / 122.4) * 100));
  const audioPct = Math.min(96, Math.max(2, cutPct + (delta / 1000 / 122.4) * 100 * 6));
  return <>
    <div className="et-av" aria-label="声画错位预览">
      <div className="et-av-row">
        <div className="et-av-lbl"><span>画面 Video</span><span>切于 {fmtUs(cutSec * 1e6)}</span></div>
        <div className="et-bar-track">
          <div className="et-bar-fill" />
          <div className="et-bar-cut" style={{ left: `${cutPct}%` }} />
        </div>
      </div>
      <div className="et-av-row">
        <div className="et-av-lbl">
          <span>音频 Audio</span>
          <span>切于 {fmtUs((cutSec + delta / 1000) * 1e6)}（{dir.toUpperCase()} · {delta > 0 ? "+" : "−"}{offsetMs}ms）</span>
        </div>
        <div className="et-bar-track">
          <div className="et-bar-fill gold" style={{ right: `${100 - audioPct}%` }} />
          <div className="et-bar-cut audio" style={{ left: `${audioPct}%` }} />
          {[12, 28, 41, 58, 72, 86].map(p => <div key={p} className="et-word" style={{ left: `${p}%` }} />)}
        </div>
      </div>
    </div>
    <p className="et-note">{dir === "j" ? `J-cut：下句声提前 ${offsetMs}ms 进入当前画面。` : `L-cut：上句声延后 ${offsetMs}ms 叠到下一画面。`}</p>
  </>;
}

export function EditingToolsPanel({
  projectId,
  baseRevisionId,
  clips,
  initialClipId,
  initialTool,
  onClose,
  onApplied,
  onNotify
}: {
  projectId: ProjectId;
  baseRevisionId: TimelineRevisionId | null;
  clips: TimelineClip[];
  initialClipId?: string | null;
  initialTool?: ToolId;
  onClose: () => void;
  onApplied: (state: TimelineState) => void;
  onNotify: (message: string) => void;
}) {
  const [tool, setTool] = useState<ToolId>(initialTool ?? "remove_pauses");
  const [clipId, setClipId] = useState(initialClipId ?? clips.find(c => c.asset_kind === "video")?.clip_id ?? clips[0]?.clip_id ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dryNote, setDryNote] = useState("拖动滑杆可实时预览保留区间。");
  const [preview, setPreview] = useState<EditingGrammarPrepareResult | null>(null);
  const [proposal, setProposal] = useState<EditingGrammarProposal | null>(null);
  const [history, setHistory] = useState<EditingGrammarProposalListItem[]>([]);
  const [adopted, setAdopted] = useState(false);

  const [threshold, setThreshold] = useState(0.05);
  const [minSilenceMs, setMinSilenceMs] = useState(400);
  const [padMs, setPadMs] = useState(50);
  const [targetSec, setTargetSec] = useState(15);
  const [beatsPerShot, setBeatsPerShot] = useState(2);
  const [bgmClipId, setBgmClipId] = useState("");
  const [pickedShots, setPickedShots] = useState<string[]>([]);
  const [ljMode, setLjMode] = useState<"auto" | "j" | "l">("auto");
  const [offsetMs, setOffsetMs] = useState(400);
  const [pictureCutUs, setPictureCutUs] = useState<number | null>(null);

  const videoClips = useMemo(() => clips.filter(c => c.asset_kind === "video"), [clips]);
  const audioClips = useMemo(() => clips.filter(c => c.asset_kind === "audio" || c.asset_kind === "video"), [clips]);
  // 视频素材的 asset_id 集合：L/J cut 与声画分离派生出的 A1 片段虽然 asset_kind
  // 是 audio，但 asset_id 仍指向视频素材——默认 BGM 必须把它们排除（否则「分析节拍」
  // 分析的是人声而不是音乐）。
  const videoAssetIds = useMemo(() => new Set(clips.filter(c => c.asset_kind === "video").map(c => String(c.asset_id))), [clips]);
  const currentClip = useMemo(() => clips.find(c => c.clip_id === clipId) ?? null, [clips, clipId]);
  const clipDurUs = useMemo(() => {
    const r = currentClip ? clipSourceRange(currentClip) : null;
    return r ? r.end - r.start : 122_400_000;
  }, [currentClip]);
  const bgmClip = useMemo(() => clips.find(c => c.clip_id === bgmClipId) ?? null, [clips, bgmClipId]);

  // ── Wave1 L2：BGM 节拍网格状态（beat_grids 的 UI 触发与轮询）──
  // subscribeJob 是死通道（P61 实锤）：就绪判定走 getBeatAnalysis 轮询对账。
  const [beatSummary, setBeatSummary] = useState<BeatAnalysisSummary | null>(null);
  const [beatBusy, setBeatBusy] = useState(false);
  /** 与 Core _signals_for 同序的 BGM 资产：显式 BGM 片段优先，否则首个镜头段素材。 */
  const beatAssetId = bgmClip ? String(bgmClip.asset_id)
    : pickedShots.length ? String(videoClips.find(c => c.clip_id === pickedShots[0])?.asset_id ?? "") : "";
  const beatStatus = beatSummary?.status ?? null;

  useEffect(() => {
    let active = true;
    setBeatSummary(null);
    if (!beatAssetId) return;
    void window.desktop.getBeatAnalysis({ project_id: projectId, asset_id: beatAssetId, generate: false })
      .then(summary => { if (active) setBeatSummary(summary); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [projectId, beatAssetId]);

  useEffect(() => {
    if (beatStatus !== "queued" && beatStatus !== "running") return;
    const deadline = Date.now() + 150_000;
    const timer = setInterval(() => {
      if (Date.now() > deadline) { clearInterval(timer); return; }
      void window.desktop.getBeatAnalysis({ project_id: projectId, asset_id: beatAssetId, generate: false })
        .then(summary => setBeatSummary(summary))
        .catch(() => undefined);
    }, 1_200);
    return () => clearInterval(timer);
  }, [beatStatus, projectId, beatAssetId]);

  const analyzeBeats = () => {
    if (!beatAssetId) { setError("请先选择 BGM 或镜头段。"); return; }
    setBeatBusy(true); setError("");
    void window.desktop.getBeatAnalysis({ project_id: projectId, asset_id: beatAssetId, generate: true })
      .then(summary => setBeatSummary(summary))
      .catch(caught => setError(errText(caught)))
      .finally(() => setBeatBusy(false));
  };

  // ── Wave1 L1：L/J 词戳来源徽标（设计 §3.3：asr 可见、缺词不静默）──
  const [ljWordsSource, setLjWordsSource] = useState<"checking" | "asr" | "none">("checking");
  const ljClipAssetId = tool === "lj_cut" && currentClip ? String(currentClip.asset_id) : null;
  useEffect(() => {
    let active = true;
    if (!ljClipAssetId) { setLjWordsSource("none"); return; }
    setLjWordsSource("checking");
    // 摘要层无词级信息（TranscriptSummary 不带 words）：取最新 ready 转录
    // 的详情核对 words 非空——徽标必须精确（设计 §3.3：禁止静默混用来源）。
    void window.desktop.listTranscripts(ljClipAssetId)
      .then(page => {
        const ready = page.items.find(item => item.status === "ready");
        if (!ready) return null;
        return window.desktop.getTranscript(ready.transcript_id);
      })
      .then(detail => {
        if (!active) return;
        setLjWordsSource(detail && (detail.words?.length ?? 0) > 0 ? "asr" : "none");
      })
      .catch(() => { if (active) setLjWordsSource("none"); });
    return () => { active = false; };
  }, [ljClipAssetId]);

  useEffect(() => {
    let active = true;
    void window.desktop.listEditingGrammarProposals(projectId).then(page => {
      if (active) setHistory(page.items);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    if (!pickedShots.length && videoClips.length) {
      setPickedShots(videoClips.slice(0, 5).map(c => c.clip_id));
    }
  }, [videoClips, pickedShots.length]);

  useEffect(() => {
    if (bgmClipId || !audioClips.length) return;
    // 默认 BGM：优先「纯音频素材」（音乐文件）上的片段；一个都没有时退回原规则
    // （audioClips 末位）。2026-10-10 真机观察：原规则会选到 L/J 派生的人声片段。
    const pureAudio = audioClips.filter(clip => !videoAssetIds.has(String(clip.asset_id)));
    const preferred = pureAudio.length ? pureAudio : audioClips;
    setBgmClipId(preferred[preferred.length - 1].clip_id);
  }, [audioClips, videoAssetIds, bgmClipId]);

  const buildParams = (): Record<string, unknown> | null => {
    if (!baseRevisionId) {
      setError("请先创建时间线。");
      return null;
    }
    if (tool === "remove_pauses") {
      if (!clipId) { setError("请选择目标视频片段。"); return null; }
      return {
        clip_id: clipId,
        energy_threshold: threshold,
        min_silence_us: Math.round(minSilenceMs * 1000),
        pad_us: Math.round(padMs * 1000)
      };
    }
    if (tool === "beat_sync") {
      const segments: Array<{ asset_id: string; source_start_us: number; source_end_us: number }> = [];
      for (const id of pickedShots) {
        const c = clips.find(x => x.clip_id === id);
        if (!c) continue;
        const range = clipSourceRange(c);
        if (!range) continue;
        segments.push({ asset_id: String(c.asset_id), source_start_us: range.start, source_end_us: range.end });
      }
      if (!segments.length) { setError("请选择至少一个镜头段。"); return null; }
      return {
        target_duration_us: Math.round(targetSec * 1e6),
        beats_per_shot: beatsPerShot,
        bgm_asset_id: bgmClip ? String(bgmClip.asset_id) : undefined,
        segments
      };
    }
    if (!clipId || !currentClip) { setError("请选择目标视频片段。"); return null; }
    const range = clipSourceRange(currentClip);
    if (!range) { setError("片段缺少源时间范围。"); return null; }
    return {
      clip_id: clipId,
      mode: ljMode,
      source_time_us: pictureCutUs ?? Math.round((range.start + range.end) / 2),
      offset_us: Math.round(offsetMs * 1000)
    };
  };

  const runPrepare = async () => {
    const params = buildParams();
    if (!params || !baseRevisionId) return;
    setBusy(true); setError(""); setPreview(null); setProposal(null); setAdopted(false);
    try {
      setPreview(await window.desktop.prepareEditingGrammar({
        project_id: projectId, base_revision_id: baseRevisionId, planner: tool, params
      }));
      setDryNote("干跑完成：可生成提案。");
    } catch (caught) {
      setDryNote("干跑失败。");
      setError(errText(caught));
    } finally { setBusy(false); }
  };

  const runPropose = async () => {
    const params = buildParams();
    if (!params || !baseRevisionId) return;
    setBusy(true); setError(""); setAdopted(false);
    try {
      const created = await window.desktop.proposeEditingGrammar({
        project_id: projectId, base_revision_id: baseRevisionId, planner: tool, params
      });
      setProposal(created);
      setPreview(null);
      const page = await window.desktop.listEditingGrammarProposals(projectId);
      setHistory(page.items);
    } catch (caught) {
      setError(errText(caught));
    } finally { setBusy(false); }
  };

  const applyProposal = async () => {
    if (!proposal) return;
    setBusy(true); setError("");
    try {
      const next = await window.desktop.applyEditingGrammarProposal({
        project_id: projectId,
        proposal_id: proposal.editing_grammar_proposal_id,
        base_revision_id: proposal.base_revision_id,
        proposed_document_sha256: proposal.proposed_document_sha256
      });
      setAdopted(true);
      onApplied(next);
      onNotify("剪辑手法提案已应用为新的正式 Revision。");
    } catch (caught) {
      setError(errText(caught));
    } finally { setBusy(false); }
  };

  const openHistory = async (item: EditingGrammarProposalListItem) => {
    setBusy(true); setError("");
    try {
      const detail = await window.desktop.getEditingGrammarProposal({ project_id: projectId, proposal_id: item.id });
      setProposal(detail);
      setPreview(null);
      setAdopted(Boolean(detail.applied_revision_id));
    } catch (caught) {
      setError(errText(caught));
    } finally { setBusy(false); }
  };

  const switchTool = (id: ToolId) => {
    setTool(id); setPreview(null); setProposal(null); setError(""); setAdopted(false);
    setDryNote(id === "remove_pauses" ? "拖动滑杆可实时预览保留区间。" : "调整参数后干跑预览。");
  };

  const meta = TOOL_META[tool];
  const range = currentClip ? clipSourceRange(currentClip) : null;
  const cutSecForLj = pictureCutUs !== null
    ? pictureCutUs / 1e6
    : range ? (range.start + range.end) / 2 / 1e6 : 39;

  return <Dialog titleId="editing-tools-title" label="剪辑手法" onClose={onClose} className="editing-tools">
    <div className="modal-heading">
      <div>
        <h2 id="editing-tools-title">剪辑手法</h2>
        <p>{meta.desc}</p>
      </div>
      <button type="button" className="icon-btn" aria-label="关闭剪辑手法" onClick={onClose}>×</button>
    </div>

    <div className="et-wrap">
      <div className="et-tabs" role="tablist" aria-label="手法页签">
        {(Object.keys(TOOL_META) as ToolId[]).map(id => (
          <button key={id} type="button" role="tab" aria-selected={tool === id} className={tool === id ? "on" : ""} onClick={() => switchTool(id)}>
            <strong>{TOOL_META[id].title}</strong>
            <span>{TOOL_META[id].sub}</span>
          </button>
        ))}
      </div>

      <div className="et-ctx">
        <span>目标 <b>{meta.title}</b></span>
        <span>素材 <b>{shortId(currentClip?.clip_id ?? bgmClipId ?? "")}</b></span>
        <span>基线 <b>{baseRevisionId ? shortId(baseRevisionId) : "—"}</b></span>
      </div>

      {error && <p className="ai-status" role="status">{error}</p>}

      {!proposal && <div className="et-shell">
        <div className="et-col">
          {tool === "remove_pauses" && <>
            <div className="et-field">
              <label>目标片段</label>
              <select value={clipId} onChange={e => setClipId(e.target.value)} title={clipId}>
                {videoClips.map(c => {
                  const r = clipSourceRange(c);
                  return <option key={c.clip_id} value={c.clip_id} title={c.clip_id}>
                    {shortId(c.clip_id)} · {r ? fmtUs(r.end - r.start) : "—"}
                  </option>;
                })}
              </select>
            </div>
            <div className="et-field">
              <label>能量阈值 <span className="et-val">{threshold.toFixed(2)}</span></label>
              <input type="range" min={0.01} max={0.3} step={0.01} value={threshold} onChange={e => setThreshold(+e.target.value)} />
            </div>
            <div className="et-field">
              <label>最短静音（ms） <span className="et-val">{minSilenceMs}</span></label>
              <input type="range" min={100} max={2000} step={50} value={minSilenceMs} onChange={e => setMinSilenceMs(+e.target.value)} />
            </div>
            <div className="et-field">
              <label>保留边距 pad（ms） <span className="et-val">{padMs}</span></label>
              <input type="range" min={0} max={300} step={10} value={padMs} onChange={e => setPadMs(+e.target.value)} />
            </div>
            <details className="et-adv">
              <summary>高级 · 与 Core 参数对齐</summary>
              <div className="et-field"><label>energy_threshold 默认</label><input type="text" readOnly value="DEFAULT_ENERGY_THRESHOLD = 0.05" /></div>
              <div className="et-field"><label>min_silence_us 默认</label><input type="text" readOnly value="DEFAULT_MIN_SILENCE_US = 400000" /></div>
              <p className="et-note">源：editing_grammar/silence.py · 空操作可提案、不可采纳</p>
            </details>
          </>}

          {tool === "beat_sync" && <>
            <div className="et-field">
              <label>BGM / 音频轨</label>
              <select value={bgmClipId} onChange={e => setBgmClipId(e.target.value)} title={bgmClipId}>
                {audioClips.map(c => (
                  <option key={c.clip_id} value={c.clip_id} title={c.clip_id}>{shortId(c.clip_id)} · {c.asset_kind}</option>
                ))}
              </select>
            </div>
            <div className="et-field">
              <label>节拍网格（Wave1 L2）</label>
              <p className="et-note">{
                beatSummary === null ? "检查中…"
                : beatStatus === "ready" ? `✓ 已就绪 · BPM ${beatSummary?.bpm != null ? beatSummary.bpm.toFixed(1) : "—"} · ${beatSummary?.beat_count ?? 0} 拍（强拍 ${beatSummary?.downbeat_count ?? 0}）`
                : beatStatus === "queued" || beatStatus === "running" ? "分析中…（完成后自动刷新，干跑前请稍候）"
                : beatStatus === "unavailable" ? "该素材无法检出节拍（无音轨或置信度不足）"
                : beatStatus === "stale" ? "素材已变化，节拍网格需重新分析。"
                : "无节拍网格 —— 干跑会失败，请先分析。"
              }</p>
              {beatSummary !== null && beatStatus !== "ready" && beatStatus !== "queued" && beatStatus !== "running" && (
                <button type="button" disabled={beatBusy || !beatAssetId} onClick={analyzeBeats}>
                  {beatBusy ? "登记中…" : beatStatus === "stale" || beatStatus === "failed" ? "重新分析节拍" : "分析节拍"}
                </button>
              )}
            </div>
            <div className="et-field">
              <label>目标成片时长（s） <span className="et-val">{targetSec.toFixed(1)}</span></label>
              <input type="range" min={5} max={60} step={0.5} value={targetSec} onChange={e => setTargetSec(+e.target.value)} />
            </div>
            <div className="et-field">
              <label>每镜头拍数 <span className="et-val">{beatsPerShot}</span></label>
              <input type="range" min={1} max={8} step={1} value={beatsPerShot} onChange={e => setBeatsPerShot(+e.target.value)} />
            </div>
            <div className="et-field">
              <label>镜头段（可多选）</label>
              <div className="et-shots">
                {videoClips.map(c => (
                  <label key={c.clip_id} className="et-shot-row">
                    <input
                      type="checkbox"
                      checked={pickedShots.includes(c.clip_id)}
                      onChange={e => setPickedShots(prev => e.target.checked ? [...prev, c.clip_id] : prev.filter(id => id !== c.clip_id))}
                    />
                    <span>{shortId(c.clip_id)}</span>
                  </label>
                ))}
              </div>
            </div>
            <details className="et-adv">
              <summary>高级 · 与 Core 参数对齐</summary>
              <div className="et-field"><label>权重（冻结）</label><input type="text" readOnly value="face 3.0 · motion 2.0 · sharpness 1.0" /></div>
              <p className="et-note">源：editing_grammar/beat_sync.py</p>
            </details>
          </>}

          {tool === "lj_cut" && <>
            <div className="et-field">
              <label>目标片段</label>
              <select value={clipId} onChange={e => setClipId(e.target.value)} title={clipId}>
                {videoClips.map(c => {
                  const r = clipSourceRange(c);
                  return <option key={c.clip_id} value={c.clip_id} title={c.clip_id}>
                    {shortId(c.clip_id)}{r ? ` · ${fmtUs(r.start)}` : ""}
                  </option>;
                })}
              </select>
            </div>
            <div className="et-field">
              <label>词戳来源（Wave1 L1）</label>
              <p className="et-note">{
                ljWordsSource === "asr" ? "ASR 词级转录 ✓ —— Core 自动拉取 words（面板无需填写）"
                : ljWordsSource === "checking" ? "检查该素材的转录…"
                : "无词级转录 —— 先在「转录」页对该素材转录；无词戳时 L/J 干跑会报「缺少词级时间戳」。"
              }</p>
            </div>
            <div className="et-field">
              <label>画面切点</label>
              <select value={String(pictureCutUs ?? "mid")} onChange={e => setPictureCutUs(e.target.value === "mid" ? null : Number(e.target.value))}>
                <option value="mid">片段中点（默认）</option>
                {range && <>
                  <option value={String(range.start + Math.round(clipDurUs * 0.32))}>{fmtUs(range.start + Math.round(clipDurUs * 0.32))} · 与静音/切换对齐</option>
                  <option value={String(range.start + Math.round(clipDurUs * 0.66))}>{fmtUs(range.start + Math.round(clipDurUs * 0.66))} · 第二处切换</option>
                </>}
              </select>
            </div>
            <div className="et-field">
              <label>方向 mode</label>
              <div className="et-seg" role="group" aria-label="LJ 方向">
                {(["auto", "j", "l"] as const).map(m => (
                  <button key={m} type="button" className={ljMode === m ? "on" : ""} onClick={() => setLjMode(m)}>
                    {m === "auto" ? "自动" : m === "j" ? "J · 声先入" : "L · 声延后"}
                  </button>
                ))}
              </div>
            </div>
            <div className="et-field">
              <label>偏移 offset（ms） <span className="et-val">{offsetMs}</span></label>
              <input type="range" min={300} max={500} step={10} value={offsetMs} onChange={e => setOffsetMs(+e.target.value)} />
              <p className="et-note">Core 窗口 [300, 500] · 默认 400</p>
            </div>
            <details className="et-adv">
              <summary>高级 · 与 Core 参数对齐</summary>
              <div className="et-field"><label>自动方向启发</label><input type="text" readOnly value="auto_lj_mode：有下句词 → J，否则 L" /></div>
              <div className="et-field"><label>op</label><input type="text" readOnly value="split_edit {clip_id, source_time_us, audio_delta_us}" /></div>
            </details>
          </>}
        </div>

        <div className="et-col">
          <div className="et-preview">
            <div className="et-ph">
              <h3>
                {tool === "remove_pauses" ? "时间轴预览 · 静音 / 保留"
                  : tool === "beat_sync" ? "时间轴预览 · beat 与切点"
                  : "声画错位预览"}
              </h3>
              <div className="et-legend">
                {tool === "remove_pauses" && <>
                  <span><i style={{ background: "var(--dlg-primary)" }} />保留有声</span>
                  <span><i style={{ background: "var(--ctl-bg)" }} />静音（将删除）</span>
                </>}
                {tool === "beat_sync" && <>
                  <span><i style={{ background: "var(--dlg-primary)" }} />beat</span>
                  <span><i style={{ background: "var(--dlg-text)" }} />切点</span>
                  <span><i style={{ background: "var(--ctl-bg)" }} />镜头</span>
                </>}
                {tool === "lj_cut" && <>
                  <span><i style={{ background: "var(--dlg-text)" }} />画面切线</span>
                  <span><i style={{ background: "var(--dlg-warn)" }} />音频切线</span>
                  <span><i style={{ background: "var(--dlg-primary)" }} />词锚</span>
                </>}
              </div>
            </div>
            {tool === "remove_pauses" && <PauseTimeline durationUs={clipDurUs} minSilenceMs={minSilenceMs} padMs={padMs} />}
            {tool === "beat_sync" && <BeatTimeline targetSec={targetSec} beatsPerShot={beatsPerShot} shotCount={pickedShots.length} />}
            {tool === "lj_cut" && <LjTimeline cutSec={cutSecForLj} offsetMs={offsetMs} mode={ljMode} />}
            {preview && <div className="et-dry">
              <h4>干跑结果</h4>
              <p>{preview.summary}</p>
              <p className="et-note">操作 {preview.operations_count} 条{preview.noop ? " · 空操作（可提案，不可采纳）" : ""}</p>
            </div>}
          </div>

          {history.length > 0 && <div>
            <p className="et-note" style={{ marginBottom: 6 }}>历史提案</p>
            <div className="et-hist">
              {history.slice(0, 6).map(item => (
                <button key={item.id} type="button" onClick={() => void openHistory(item)}>
                  {item.planner} · {formatLocalStamp(item.created_at)}
                </button>
              ))}
            </div>
          </div>}
        </div>
      </div>}

      {proposal && <div className="et-proposal">
        <h4>提案 · {proposal.planner}</h4>
        <p className="et-sum">{proposal.patch.summary}</p>
        <div className="et-diff">
          <div className="et-cell"><div className="et-n">{proposal.diff.summary.clip_changes}</div><div className="et-k">Clip 变更</div></div>
          <div className="et-cell"><div className="et-n">{proposal.diff.summary.caption_changes}</div><div className="et-k">Caption</div></div>
          <div className="et-cell"><div className="et-n">{(proposal.diff.duration_delta_us / 1e6).toFixed(1)}s</div><div className="et-k">时长变化</div></div>
        </div>
        <TimelineDiffView diff={proposal.diff} />
        {adopted && <p className="et-note ok">已采纳为新 Revision。</p>}
        {baseRevisionId && proposal.base_revision_id !== baseRevisionId && (
          <p className="et-note warn">基线已变化：请返回后基于当前版本重新规划。</p>
        )}
      </div>}
    </div>

    <div className="modal-actions">
      {proposal ? <>
        <button type="button" onClick={() => setProposal(null)}>返回</button>
        {!proposal.applied_revision_id && proposal.patch.operations.length > 0 && (
          <button
            type="button"
            disabled={busy || adopted || !baseRevisionId || proposal.base_revision_id !== baseRevisionId}
            onClick={() => void applyProposal()}
          >
            采纳为正式 Timeline
          </button>
        )}
      </> : <>
        <button type="button" disabled={busy || !baseRevisionId} onClick={() => void runPrepare()}>干跑预览</button>
        <button type="button" disabled={busy || !baseRevisionId} onClick={() => void runPropose()}>生成提案</button>
      </>}
    </div>
  </Dialog>;
}
