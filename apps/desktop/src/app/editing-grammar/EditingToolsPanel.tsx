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

const TOOL_META: Record<ToolId, { title: string; sub: string }> = {
  remove_pauses: { title: "去停顿", sub: "remove_pauses" },
  beat_sync: { title: "卡点", sub: "beat_sync" },
  lj_cut: { title: "L/J cut", sub: "lj_cut" }
};

function fmtUs(us: number): string {
  const s = us / 1e6;
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toFixed(1).padStart(4, "0")}`;
}

function clipSourceRange(clip: TimelineClip): { start: number; end: number } | null {
  const start = clip.source_start_us;
  const end = clip.source_end_us;
  if (typeof start !== "number" || typeof end !== "number") return null;
  return { start, end };
}

/**
 * Wave 1 剪辑手法面板（docs/ui-mockups/wave1-editing-tools）：
 * 去停顿 / 卡点 / L-J 三页统一壳层，干跑 → 提案 → 采纳。
 * 零 egress；提案不自动改 Timeline。
 */
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
  const [preview, setPreview] = useState<EditingGrammarPrepareResult | null>(null);
  const [proposal, setProposal] = useState<EditingGrammarProposal | null>(null);
  const [history, setHistory] = useState<EditingGrammarProposalListItem[]>([]);

  // remove_pauses
  const [threshold, setThreshold] = useState(0.05);
  const [minSilenceMs, setMinSilenceMs] = useState(400);
  const [padMs, setPadMs] = useState(50);

  // beat_sync
  const [targetSec, setTargetSec] = useState(15);
  const [beatsPerShot, setBeatsPerShot] = useState(2);
  const [bgmClipId, setBgmClipId] = useState("");
  const [pickedShots, setPickedShots] = useState<string[]>([]);

  // lj_cut
  const [ljMode, setLjMode] = useState<"auto" | "j" | "l">("auto");
  const [offsetMs, setOffsetMs] = useState(400);
  const [pictureCutUs, setPictureCutUs] = useState<number | null>(null);

  const videoClips = useMemo(() => clips.filter(c => c.asset_kind === "video"), [clips]);
  const audioClips = useMemo(() => clips.filter(c => c.asset_kind === "audio" || c.asset_kind === "video"), [clips]);
  const currentClip = useMemo(() => clips.find(c => c.clip_id === clipId) ?? null, [clips, clipId]);

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
        segments
      };
    }
    // lj_cut
    if (!clipId || !currentClip) { setError("请选择目标视频片段。"); return null; }
    const range = clipSourceRange(currentClip);
    if (!range) { setError("片段缺少源时间范围。"); return null; }
    const cutUs = pictureCutUs
      ?? Math.round((range.start + range.end) / 2);
    // 词戳：端到端由 Core 注入时才完整；此处占位空数组将由服务/后续 ASR 填充
    const words: Array<{ start_us: number; end_us: number; text?: string }> = [];
    return {
      clip_id: clipId,
      mode: ljMode === "auto" ? "j" : ljMode,
      source_time_us: cutUs,
      offset_us: Math.round(offsetMs * 1000),
      words
    };
  };

  const runPrepare = async () => {
    const params = buildParams();
    if (!params || !baseRevisionId) return;
    setBusy(true); setError(""); setPreview(null);
    try {
      setPreview(await window.desktop.prepareEditingGrammar({
        project_id: projectId,
        base_revision_id: baseRevisionId,
        planner: tool,
        params
      }));
    } catch (caught) {
      setError(FAILURE_LABELS[errorCode(caught) ?? ""] ?? safeErrorMessage(caught, "干跑失败。请检查参数与时间线后重试。"));
    } finally { setBusy(false); }
  };

  const runPropose = async () => {
    const params = buildParams();
    if (!params || !baseRevisionId) return;
    setBusy(true); setError("");
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
      setError(FAILURE_LABELS[errorCode(caught) ?? ""] ?? safeErrorMessage(caught, "提案失败。请检查参数后重试。"));
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
      onApplied(next);
      onNotify("剪辑手法提案已应用为新的正式 Revision。");
      onClose();
    } catch (caught) {
      setError(FAILURE_LABELS[errorCode(caught) ?? ""] ?? safeErrorMessage(caught, "采纳失败。提案可能是空操作或基线已变化。"));
    } finally { setBusy(false); }
  };

  const openHistory = async (item: EditingGrammarProposalListItem) => {
    setBusy(true); setError("");
    try {
      setProposal(await window.desktop.getEditingGrammarProposal({ project_id: projectId, proposal_id: item.id }));
      setPreview(null);
    } catch (caught) {
      setError(FAILURE_LABELS[errorCode(caught) ?? ""] ?? safeErrorMessage(caught, "打开提案失败。"));
    } finally { setBusy(false); }
  };

  return <Dialog titleId="editing-tools-title" label="剪辑手法" onClose={onClose} className="editing-tools">
    <div className="modal-heading">
      <div>
        <h2 id="editing-tools-title">剪辑手法</h2>
        <p>本地确定性规划 · 零外传。提案不会自动修改正式 Timeline，采纳后才落新 Revision。</p>
      </div>
      <button className="icon-button" aria-label="关闭剪辑手法" onClick={onClose}>×</button>
    </div>

    <div className="editing-tools-tabs" role="tablist" aria-label="手法页签">
      {(Object.keys(TOOL_META) as ToolId[]).map(id => (
        <button
          key={id}
          role="tab"
          aria-selected={tool === id}
          className={tool === id ? "on" : ""}
          onClick={() => { setTool(id); setPreview(null); setProposal(null); setError(""); }}
        >
          <strong>{TOOL_META[id].title}</strong>
          <span>{TOOL_META[id].sub}</span>
        </button>
      ))}
    </div>

    <div className="editing-tools-ctx">
      <span>目标：{TOOL_META[tool].title}</span>
      <span>素材：{currentClip?.clip_id ?? bgmClipId ?? "—"}</span>
      <span>基线：{baseRevisionId ? baseRevisionId.slice(0, 12) + "…" : "—"}</span>
    </div>

    {error && <p className="ai-status" role="status">{error}</p>}

    {!proposal && <div className="editing-tools-grid">
      <div className="editing-tools-params">
        {tool === "remove_pauses" && <>
          <label>目标片段
            <select aria-label="目标片段" value={clipId} onChange={e => setClipId(e.target.value)}>
              {videoClips.map(c => {
                const range = clipSourceRange(c);
                return (
                  <option key={c.clip_id} value={c.clip_id}>
                    {c.clip_id} · {range ? fmtUs(range.end - range.start) : "—"}
                  </option>
                );
              })}
            </select>
          </label>
          <label>能量阈值 <em>{threshold.toFixed(2)}</em>
            <input type="range" min={0.01} max={0.3} step={0.01} value={threshold} onChange={e => setThreshold(+e.target.value)} aria-label="能量阈值" />
          </label>
          <label>最短静音（ms） <em>{minSilenceMs}</em>
            <input type="range" min={100} max={2000} step={50} value={minSilenceMs} onChange={e => setMinSilenceMs(+e.target.value)} aria-label="最短静音毫秒" />
          </label>
          <label>保留边距 pad（ms） <em>{padMs}</em>
            <input type="range" min={0} max={300} step={10} value={padMs} onChange={e => setPadMs(+e.target.value)} aria-label="保留边距毫秒" />
          </label>
          <p className="readonly-note">默认对齐 Core：阈值 0.05 · 最短静音 400ms · pad 50ms。无 CV 音频能量时请先做 AI 信号分析。</p>
        </>}

        {tool === "beat_sync" && <>
          <label>BGM / 音频轨
            <select aria-label="BGM" value={bgmClipId} onChange={e => setBgmClipId(e.target.value)}>
              {audioClips.map(c => <option key={c.clip_id} value={c.clip_id}>{c.clip_id} · {c.asset_kind}</option>)}
            </select>
          </label>
          <label>目标成片时长（s） <em>{targetSec.toFixed(1)}</em>
            <input type="range" min={5} max={60} step={0.5} value={targetSec} onChange={e => setTargetSec(+e.target.value)} aria-label="目标时长秒" />
          </label>
          <label>每镜头拍数 <em>{beatsPerShot}</em>
            <input type="range" min={1} max={8} step={1} value={beatsPerShot} onChange={e => setBeatsPerShot(+e.target.value)} aria-label="每镜头拍数" />
          </label>
          <fieldset>
            <legend>镜头段</legend>
            {videoClips.map(c => (
              <label key={c.clip_id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={pickedShots.includes(c.clip_id)}
                  onChange={e => setPickedShots(prev => e.target.checked ? [...prev, c.clip_id] : prev.filter(id => id !== c.clip_id))}
                />
                {c.clip_id}
              </label>
            ))}
          </fieldset>
          <p className="readonly-note">镜头时长 = beat 间隔 × 每镜头拍数；切点吸附网格。需 BGM 已分析节拍。</p>
        </>}

        {tool === "lj_cut" && <>
          <label>目标片段
            <select aria-label="目标片段" value={clipId} onChange={e => setClipId(e.target.value)}>
              {videoClips.map(c => {
                const range = clipSourceRange(c);
                return (
                  <option key={c.clip_id} value={c.clip_id}>
                    {c.clip_id} · {range ? `${fmtUs(range.start)}–${fmtUs(range.end)}` : "—"}
                  </option>
                );
              })}
            </select>
          </label>
          <label>画面切点（源时间 µs）
            <input
              type="number"
              aria-label="画面切点微秒"
              value={pictureCutUs ?? (currentClip && clipSourceRange(currentClip) ? Math.round(((clipSourceRange(currentClip)!.start + clipSourceRange(currentClip)!.end) / 2)) : 0)}
              onChange={e => setPictureCutUs(Number(e.target.value) || null)}
            />
          </label>
          <label>方向</label>
          <div className="editing-tools-seg" role="group" aria-label="LJ 方向">
            {(["auto", "j", "l"] as const).map(m => (
              <button key={m} type="button" className={ljMode === m ? "on" : ""} onClick={() => setLjMode(m)}>
                {m === "auto" ? "自动" : m === "j" ? "J · 声先入" : "L · 声延后"}
              </button>
            ))}
          </div>
          <label>偏移 offset（ms） <em>{offsetMs}</em>
            <input type="range" min={300} max={500} step={10} value={offsetMs} onChange={e => setOffsetMs(+e.target.value)} aria-label="音频偏移毫秒" />
          </label>
          <p className="readonly-note">Core 窗口 [300, 500]ms。自动启发：有下句词 → J。词戳优先 ASR（word_source 会记录）。</p>
        </>}

        <div className="modal-actions" style={{ justifyContent: "flex-start", marginTop: 12 }}>
          <button disabled={busy || !baseRevisionId} onClick={() => void runPrepare()}>干跑预览</button>
          <button disabled={busy || !baseRevisionId} onClick={() => void runPropose()}>生成提案</button>
        </div>

        {preview && <section aria-label="干跑结果" style={{ marginTop: 12 }}>
          <h3 style={{ fontSize: 13, marginBottom: 6 }}>干跑结果</h3>
          <p style={{ fontSize: 12, color: "var(--text2)" }}>{preview.summary}</p>
          <p className="readonly-note">操作 {preview.operations_count} 条{preview.noop ? " · 空操作（可提案，不可采纳）" : ""}</p>
        </section>}

        {history.length > 0 && <fieldset style={{ marginTop: 12 }}>
          <legend>历史提案</legend>
          <ul className="agent-session-history">
            {history.slice(0, 6).map(item => (
              <li key={item.id}>
                <button type="button" onClick={() => void openHistory(item)}>
                  {item.planner} · {item.created_at.slice(0, 16).replace("T", " ")}
                </button>
              </li>
            ))}
          </ul>
        </fieldset>}
      </div>

      <div className="editing-tools-preview">
        <h3 style={{ fontSize: 12.5, marginBottom: 8 }}>预览</h3>
        {tool === "remove_pauses" && (
          <div className="readonly-note">
            保留有声段并删除 ≥{minSilenceMs}ms 静音（阈值 {threshold.toFixed(2)}，pad {padMs}ms）。
            干跑后将在提案 Diff 中看到 clip 变更。
          </div>
        )}
        {tool === "beat_sync" && (
          <div className="readonly-note">
            目标 {targetSec}s · {beatsPerShot} 拍/镜 · 选中 {pickedShots.length} 个镜头段。
            切点将吸附 beat 网格。
          </div>
        )}
        {tool === "lj_cut" && (
          <div className="readonly-note">
            切点 {pictureCutUs !== null ? fmtUs(pictureCutUs) : "（片段中点）"} ·
            方向 {ljMode.toUpperCase()} · offset {offsetMs}ms。
            声画错位以提案中的 split_edit 为准。
          </div>
        )}
        {preview && (
          <ul className="agent-session-steps" style={{ marginTop: 10 }}>
            {preview.operations.slice(0, 8).map((op, i) => (
              <li key={i}><code>{op.op}</code></li>
            ))}
          </ul>
        )}
      </div>
    </div>}

    {proposal && <div>
      <h3 style={{ fontSize: 13, marginBottom: 6 }}>提案详情</h3>
      <p style={{ fontSize: 12, color: "var(--text2)" }}>{proposal.patch.summary}</p>
      <dl style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: "4px 10px", fontSize: 12, margin: "10px 0" }}>
        <dt>规划器</dt><dd>{proposal.planner}</dd>
        <dt>基线</dt><dd style={{ fontFamily: "monospace" }}>{proposal.base_revision_id}</dd>
        <dt>操作数</dt><dd>{proposal.patch.operations.length}</dd>
        <dt>状态</dt><dd>{proposal.applied_revision_id ? `已采纳 → ${proposal.applied_revision_id}` : "未采纳"}</dd>
        <dt>文档哈希</dt><dd style={{ fontFamily: "monospace", wordBreak: "break-all" }}>{proposal.proposed_document_sha256}</dd>
      </dl>
      <TimelineDiffView diff={proposal.diff} />
      <div className="modal-actions">
        <button onClick={() => setProposal(null)}>返回</button>
        {!proposal.applied_revision_id && proposal.patch.operations.length > 0 && (
          <button
            disabled={busy || !baseRevisionId || proposal.base_revision_id !== baseRevisionId}
            onClick={() => void applyProposal()}
          >
            采纳为正式 Timeline
          </button>
        )}
      </div>
      {baseRevisionId && proposal.base_revision_id !== baseRevisionId && (
        <p className="readonly-note">基线已变化：请返回后基于当前版本重新规划。</p>
      )}
    </div>}
  </Dialog>;
}
