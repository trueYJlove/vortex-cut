import { useEffect, useMemo, useState } from "react";
import type {
  EditingGrammarPrepareResult,
  EditingGrammarProposal,
  EditingGrammarProposalListItem,
  ProjectId,
  TimelineClip,
  TimelineRevisionId,
  TimelineState
} from "@aivideo/contracts";
import { Dialog } from "../Dialog.js";
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
  return id.length > 18 ? id.slice(0, 8) + "…" + id.slice(-4) : id;
}

function clipSourceRange(clip: TimelineClip): { start: number; end: number } | null {
  const start = clip.source_start_us;
  const end = clip.source_end_us;
  if (typeof start !== "number" || typeof end !== "number") return null;
  return { start, end };
}

function errText(caught: unknown): string {
  const code = errorCode(caught);
  const label = FAILURE_LABELS[code];
  if (label) return label;
  // 保留 "[CODE] message" 原文，便于对照 Core 业务错误
  return safeErrorMessage(caught, caught instanceof Error && caught.message.startsWith("[")
    ? caught.message
    : "操作失败。请检查参数与时间线后重试。");
}

/** 去停顿时间轴（对齐原型 .timeline / .lane / .seg） */
function PauseTimeline({ durationUs, minSilenceMs, padMs }: { durationUs: number; minSilenceMs: number; padMs: number }) {
  const dur = Math.max(durationUs, 1);
  // 原型示意两段静音：约 32–34% 与 65–68% 处；宽度随最短静音缩放
  const sil = Math.min(0.06, Math.max(0.012, (minSilenceMs / 1000) / (dur / 1e6) * 2));
  const pieces: Array<{ t: "keep" | "silence"; a: number; b: number }> = [
    { t: "keep", a: 0, b: 0.32 },
    { t: "silence", a: 0.32, b: 0.32 + sil },
    { t: "keep", a: 0.32 + sil, b: 0.65 },
    { t: "silence", a: 0.65, b: 0.65 + sil },
    { t: "keep", a: 0.65 + sil, b: 1 }
  ];
  return <div>
    <div className="et-timeline" aria-label="静音保留预览">
      <div className="et-lane">
        {pieces.map((p, i) => (
          <div
            key={i}
            className={"et-seg-blk " + p.t}
            style={{ left: `${p.a * 100}%`, width: `${(p.b - p.a) * 100}%` }}
            title={p.t === "keep" ? "保留" : `静音 pad=${padMs}ms`}
          />
        ))}
      </div>
    </div>
    <div className="et-axis"><span>0:00</span><span>0:30</span><span>1:00</span><span>1:30</span><span>{fmtUs(durationUs)}</span></div>
    <div className="et-note">预计删除 2 段静音 · 保留时长 ≈ {(dur / 1e6 - (minSilenceMs / 1000) * 2).toFixed(1)}s</div>
  </div>;
}

function BeatTimeline({ targetSec, beatsPerShot, shotCount, bpm = 110 }: { targetSec: number; beatsPerShot: number; shotCount: number; bpm?: number }) {
  const beatStep = 60 / bpm;
  const shotDur = beatStep * beatsPerShot;
  const n = Math.max(1, Math.floor(targetSec / shotDur));
  const ticks: number[] = [];
  for (let t = 0; t < 30; t += beatStep) ticks.push(t);
  return <div>
    <div className="et-timeline" aria-label="beat 与切点预览" style={{ height: 88 }}>
      <div className="et-lane" style={{ display: "flex", gap: 2, height: 28 }}>
        {Array.from({ length: Math.min(n, 24) }, (_, i) => (
          <div key={i} className="et-seg-blk shot" style={{ position: "relative", flex: 1, left: "auto", right: "auto", width: "auto" }} />
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
    <div className="et-note">镜头时长 ≈ {shotDur.toFixed(2)}s（{beatsPerShot} × 60/{bpm}）· 预计 {n} 个镜头 · 选中 {shotCount} 段</div>
  </div>;
}

function LjTimeline({ cutSec, offsetMs, mode }: { cutSec: number; offsetMs: number; mode: "auto" | "j" | "l" }) {
  const dir = mode === "auto" ? "j" : mode;
  const delta = dir === "j" ? -offsetMs : offsetMs;
  const cutPct = Math.min(92, Math.max(8, (cutSec / 122.4) * 100));
  const audioPct = Math.min(96, Math.max(2, cutPct + (delta / 1000 / 122.4) * 100 * 6));
  return <div>
    <div className="et-av" aria-label="声画错位预览">
      <div className="et-av-row">
        <div className="et-av-lbl"><span>画面 Video</span><span>切于 {fmtUs(cutSec * 1e6)}</span></div>
        <div className="et-bar-track">
          <div className="et-bar-fill" />
          <div className="et-bar-cut" style={{ left: `${cutPct}%` }} />
        </div>
      </div>
      <div className="et-av-row">
        <div className="et-av-lbl"><span>音频 Audio</span><span>切于 {fmtUs((cutSec + delta / 1000) * 1e6)}（{dir.toUpperCase()} · {delta > 0 ? "+" : "−"}{offsetMs}ms）</span></div>
        <div className="et-bar-track">
          <div className="et-bar-fill gold" style={{ right: `${100 - audioPct}%` }} />
          <div className="et-bar-cut audio" style={{ left: `${audioPct}%` }} />
          {[12, 28, 41, 58, 72, 86].map(p => <div key={p} className="et-word" style={{ left: `${p}%` }} />)}
        </div>
      </div>
    </div>
    <div className="et-note">{dir === "j" ? `J-cut：下句声提前 ${offsetMs}ms 进入当前画面。` : `L-cut：上句声延后 ${offsetMs}ms 叠到下一画面。`}</div>
  </div>;
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
  const currentClip = useMemo(() => clips.find(c => c.clip_id === clipId) ?? null, [clips, clipId]);
  const clipDurUs = useMemo(() => {
    const r = currentClip ? clipSourceRange(currentClip) : null;
    return r ? r.end - r.start : 122_400_000;
  }, [currentClip]);
  const bgmClip = useMemo(() => clips.find(c => c.clip_id === bgmClipId) ?? null, [clips, bgmClipId]);

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
    if (!bgmClipId && audioClips.length) setBgmClipId(audioClips[audioClips.length - 1].clip_id);
  }, [audioClips, bgmClipId]);

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
        segments.push({
          asset_id: String(c.asset_id),
          source_start_us: range.start,
          source_end_us: range.end
        });
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
    const cutUs = pictureCutUs ?? Math.round((range.start + range.end) / 2);
    return {
      clip_id: clipId,
      mode: ljMode,
      source_time_us: cutUs,
      offset_us: Math.round(offsetMs * 1000)
    };
  };

  const runPrepare = async () => {
    const params = buildParams();
    if (!params || !baseRevisionId) return;
    setBusy(true); setError(""); setPreview(null); setProposal(null); setAdopted(false);
    try {
      setPreview(await window.desktop.prepareEditingGrammar({
        project_id: projectId,
        base_revision_id: baseRevisionId,
        planner: tool,
        params
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
        project_id: projectId,
        base_revision_id: baseRevisionId,
        planner: tool,
        params
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
    setTool(id);
    setPreview(null);
    setProposal(null);
    setError("");
    setAdopted(false);
    setDryNote(id === "remove_pauses" ? "拖动滑杆可实时预览保留区间。" : "调整参数后干跑预览。");
  };

  const meta = TOOL_META[tool];
  const range = currentClip ? clipSourceRange(currentClip) : null;
  const cutSecForLj = pictureCutUs !== null
    ? pictureCutUs / 1e6
    : range ? (range.start + range.end) / 2 / 1e6 : 39;

  return <Dialog titleId="editing-tools-title" label="剪辑手法" onClose={onClose} className="editing-tools">
    <div className="et-topbar">
      <div className="et-brand">剪辑手法</div>
      <span className="et-chip">{meta.sub}</span>
      <div className="et-spacer" />
      <span className="et-hint">本地零外传 · 提案不自动改 Timeline</span>
      <button className="icon-button" aria-label="关闭剪辑手法" onClick={onClose}>×</button>
    </div>

    <div className="et-wrap">
      <h1 className="et-h1">{meta.title}</h1>
      <p className="et-sub">{meta.desc}</p>

      <div className="et-tabs" role="tablist" aria-label="手法页签">
        {(Object.keys(TOOL_META) as ToolId[]).map(id => (
          <button key={id} type="button" role="tab" aria-selected={tool === id} className={tool === id ? "on" : ""} onClick={() => switchTool(id)}>
            <strong>{TOOL_META[id].title}</strong>
            <span>{TOOL_META[id].sub}</span>
          </button>
        ))}
      </div>

      <div className="et-shell">
        <div className="et-bar">
          <div className="et-title">{meta.title} · {shortId(currentClip?.clip_id ?? bgmClipId ?? "—")}</div>
          <div className="et-meta">{fmtUs(clipDurUs)} · 基线 {baseRevisionId ? shortId(baseRevisionId) : "—"}</div>
          <div className="et-spacer" />
          {tool === "remove_pauses" && <span className="et-pill ok">CV 音频能量</span>}
          {tool === "beat_sync" && <span className="et-pill gold">beat_grid</span>}
          {tool === "lj_cut" && <span className="et-pill ok">word_source: asr</span>}
        </div>

        <div className="et-grid">
          <div className="et-col">
            {tool === "remove_pauses" && <>
              <div className="et-field">
                <label>目标片段</label>
                <select value={clipId} onChange={e => setClipId(e.target.value)}>
                  {videoClips.map(c => {
                    const r = clipSourceRange(c);
                    return <option key={c.clip_id} value={c.clip_id}>{shortId(c.clip_id)} · {r ? fmtUs(r.end - r.start) : "—"}</option>;
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
                <div className="et-note">源：editing_grammar/silence.py · 空操作可提案、不可采纳</div>
              </details>
            </>}

            {tool === "beat_sync" && <>
              <div className="et-field">
                <label>BGM / 音频轨</label>
                <select value={bgmClipId} onChange={e => setBgmClipId(e.target.value)}>
                  {audioClips.map(c => <option key={c.clip_id} value={c.clip_id}>{shortId(c.clip_id)} · {c.asset_kind}</option>)}
                </select>
              </div>
              <div className="et-field">
                <label>目标成片时长（s） <span className="et-val">{targetSec.toFixed(1)}</span></label>
                <input type="range" min={5} max={60} step={0.5} value={targetSec} onChange={e => setTargetSec(+e.target.value)} />
              </div>
              <div className="et-field">
                <label>每镜头拍数 beats_per_shot <span className="et-val">{beatsPerShot}</span></label>
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
                <div className="et-note">源：editing_grammar/beat_sync.py · 切点吸附 beat 网格</div>
              </details>
            </>}

            {tool === "lj_cut" && <>
              <div className="et-field">
                <label>目标片段</label>
                <select value={clipId} onChange={e => setClipId(e.target.value)}>
                  {videoClips.map(c => {
                    const r = clipSourceRange(c);
                    return <option key={c.clip_id} value={c.clip_id}>{shortId(c.clip_id)} · {r ? `${fmtUs(r.start)}–${fmtUs(r.end)}` : "—"}</option>;
                  })}
                </select>
              </div>
              <div className="et-field">
                <label>画面切点</label>
                <select
                  value={String(pictureCutUs ?? "mid")}
                  onChange={e => setPictureCutUs(e.target.value === "mid" ? null : Number(e.target.value))}
                >
                  <option value="mid">片段中点（默认）</option>
                  {range && (
                    <>
                      <option value={String(range.start + Math.round(clipDurUs * 0.32))}>{fmtUs(range.start + Math.round(clipDurUs * 0.32))} · 与静音/切换对齐</option>
                      <option value={String(range.start + Math.round(clipDurUs * 0.66))}>{fmtUs(range.start + Math.round(clipDurUs * 0.66))} · 第二处切换</option>
                    </>
                  )}
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
                <div className="et-note">Core 窗口 [300, 500] · 默认 400</div>
              </div>
              <details className="et-adv">
                <summary>高级 · 与 Core 参数对齐</summary>
                <div className="et-field"><label>自动方向启发</label><input type="text" readOnly value="auto_lj_mode：有下句词 → J，否则 L" /></div>
                <div className="et-field"><label>op</label><input type="text" readOnly value="split_edit {clip_id, source_time_us, audio_delta_us}" /></div>
                <div className="et-note">源：editing_grammar/lj_cut.py</div>
              </details>
            </>}

            <div className="et-actions">
              <button type="button" className="et-btn" disabled={busy || !baseRevisionId} onClick={() => void runPrepare()}>干跑预览</button>
              <button type="button" className="et-btn primary" disabled={busy || !baseRevisionId} onClick={() => void runPropose()}>生成提案</button>
            </div>
            <div className="et-note">{dryNote}</div>

            {history.length > 0 && <div className="et-adv" style={{ marginTop: 14 }}>
              <div className="et-note" style={{ marginTop: 0, marginBottom: 6 }}>历史提案</div>
              <ul className="agent-session-history" style={{ margin: 0, paddingLeft: 16 }}>
                {history.slice(0, 6).map(item => (
                  <li key={item.id}>
                    <button type="button" onClick={() => void openHistory(item)}>{item.planner} · {item.created_at.slice(0, 16).replace("T", " ")}</button>
                  </li>
                ))}
              </ul>
            </div>}
          </div>

          <div className="et-col">
            <div className="et-preview">
              <div className="et-ph">
                <h3>{tool === "remove_pauses" ? "时间轴预览 · 静音 / 保留" : tool === "beat_sync" ? "时间轴预览 · beat 与切点" : "声画错位预览"}</h3>
                <div className="et-legend">
                  {tool === "remove_pauses" && <>
                    <span><i style={{ background: "#3a5fd4" }} />保留有声</span>
                    <span><i style={{ background: "#2a333b" }} />静音（将删除）</span>
                  </>}
                  {tool === "beat_sync" && <>
                    <span><i style={{ background: "#d1a453" }} />beat</span>
                    <span><i style={{ background: "#86a0ff" }} />切点</span>
                    <span><i style={{ background: "#243044" }} />镜头</span>
                  </>}
                  {tool === "lj_cut" && <>
                    <span><i style={{ background: "#fff" }} />画面切线</span>
                    <span><i style={{ background: "#d1a453" }} />音频切线</span>
                    <span><i style={{ background: "#57cf92" }} />词锚</span>
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
                <ul style={{ margin: "6px 0 0", paddingLeft: 16 }}>
                  {preview.operations.slice(0, 8).map((op, i) => <li key={i} style={{ fontSize: 11, color: "#a3aeb5" }}><code>{String(op.op)}</code></li>)}
                </ul>
              </div>}
            </div>

            {proposal && <div className="et-proposal">
              <h4>提案 · {proposal.planner}</h4>
              <div className="et-sum">{proposal.patch.summary}</div>
              <div className="et-diff">
                <div className="et-cell"><div className="et-n">{proposal.diff.summary.clip_changes}</div><div className="et-k">Clip 变更</div></div>
                <div className="et-cell"><div className="et-n">{proposal.diff.summary.caption_changes}</div><div className="et-k">Caption</div></div>
                <div className="et-cell"><div className="et-n">{(proposal.diff.duration_delta_us / 1e6).toFixed(1)}s</div><div className="et-k">时长变化</div></div>
              </div>
              <TimelineDiffView diff={proposal.diff} />
              <div className="et-actions">
                <button type="button" className="et-btn ghost" onClick={() => setProposal(null)}>返回</button>
                <div className="et-spacer" />
                {!proposal.applied_revision_id && proposal.patch.operations.length > 0 && (
                  <button
                    type="button"
                    className="et-btn primary"
                    disabled={busy || adopted || !baseRevisionId || proposal.base_revision_id !== baseRevisionId}
                    onClick={() => void applyProposal()}
                  >
                    采纳为正式 Timeline
                  </button>
                )}
              </div>
              {adopted && <div className="et-note ok">已采纳为新 Revision。</div>}
              {baseRevisionId && proposal.base_revision_id !== baseRevisionId && (
                <div className="et-note warn">基线已变化：请返回后基于当前版本重新规划。</div>
              )}
            </div>}
          </div>
        </div>
      </div>
    </div>
    {error && <p className="ai-status" role="status" style={{ margin: "0 22px 16px" }}>{error}</p>}
  </Dialog>;
}
