import { useEffect, useMemo, useState } from "react";
import type {
  EditingGrammarPrepareResult,
  EditingGrammarProposal,
  EditingGrammarProposalListItem,
  EditingGrammarTool,
  ProjectId,
  TimelineRevisionId,
  TimelineState
} from "@aivideo/contracts";
import { Dialog } from "../Dialog.js";
import { formatLocalStamp } from "../localTime.js";
import { TimelineDiffView } from "../PropertyPanels.js";
import { errorCode, safeErrorMessage } from "../safeErrors.js";

const FAILURE_LABELS: Record<string, string> = {
  EDITING_GRAMMAR_BASE_CONFLICT: "Timeline 基线已变化。下一步：关闭面板后重新打开，基于最新版本再试。",
  EDITING_GRAMMAR_PARAMS_INVALID: "规划器参数不合法。下一步：对照工具说明中的参数模式修正后重试。",
  EDITING_GRAMMAR_PLANNER_NOT_FOUND: "规划器不存在。下一步：刷新工具目录后重新选择。",
  EDITING_GRAMMAR_NO_SPEECH: "未检测到可用语音。下一步：先对素材做 CV 分析，或显式提供静音区间。",
  EDITING_GRAMMAR_NO_WORDS: "缺少词级时间戳。下一步：先对口播素材开启词级转录。",
  EDITING_GRAMMAR_PROPOSAL_NOT_FOUND: "语法提案不存在。下一步：刷新提案列表。",
  EDITING_GRAMMAR_PROPOSAL_APPLIED: "该提案已应用过，不能重复采纳。下一步：查看结果或发起新的规划。",
  EDITING_GRAMMAR_PROPOSAL_CONFLICT: "提案与当前 Timeline 基线不一致。下一步：基于最新版本重新规划。",
  EDITING_GRAMMAR_PROPOSAL_INVALID: "提案内容无效（例如空操作）。下一步：调整参数后重新规划。",
  TIMELINE_NOT_FOUND: "时间线不存在。下一步：先创建时间线。"
};

const PARAM_PRESETS: Record<string, string> = {
  drop_short_clips: '{\n  "min_duration_us": 500000\n}',
  remove_pauses: '{\n  "clip_id": "clip_xxx"\n}',
  beat_sync: '{\n  "target_duration_us": 15000000,\n  "beats_per_shot": 2,\n  "segments": []\n}',
  lj_cut: '{\n  "mode": "j",\n  "picture_cut_us": 2000000,\n  "words": [],\n  "clip_start_us": 0,\n  "clip_end_us": 5000000,\n  "offset_us": 400000\n}'
};

/**
 * W1.1 Desktop 语法层入口：零 egress 三段式（干跑 → 提案 → 采纳）。
 * 提案不会自动写 Timeline；采纳才落正式 Revision。
 */
export function EditingGrammarPanel({
  projectId,
  baseRevisionId,
  onClose,
  onApplied,
  onNotify
}: {
  projectId: ProjectId;
  baseRevisionId: TimelineRevisionId | null;
  onClose: () => void;
  onApplied: (state: TimelineState) => void;
  onNotify: (message: string) => void;
}) {
  const [planners, setPlanners] = useState<EditingGrammarTool[]>([]);
  const [plannerName, setPlannerName] = useState("");
  const [paramsText, setParamsText] = useState("{}");
  const [preview, setPreview] = useState<EditingGrammarPrepareResult>();
  const [proposal, setProposal] = useState<EditingGrammarProposal>();
  const [list, setList] = useState<EditingGrammarProposalListItem[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const planner = useMemo(() => planners.find(item => item.name === plannerName), [planners, plannerName]);

  useEffect(() => {
    let active = true;
    void window.desktop.listEditingGrammarPlanners(projectId).then(page => {
      if (!active) return;
      setPlanners(page.items);
      if (page.items[0]) {
        setPlannerName(page.items[0].name);
        setParamsText(PARAM_PRESETS[page.items[0].name] ?? "{}");
      }
    }).catch(() => undefined);
    void window.desktop.listEditingGrammarProposals(projectId).then(page => {
      if (active) setList(page.items);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [projectId]);

  const parseParams = (): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(paramsText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setError("参数必须是 JSON 对象。");
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch {
      setError("参数不是合法 JSON。");
      return null;
    }
  };

  const runPrepare = async () => {
    if (!baseRevisionId) { setError("请先创建时间线。"); return; }
    const params = parseParams();
    if (!params) return;
    setBusy(true); setError(""); setPreview(undefined);
    try {
      setPreview(await window.desktop.prepareEditingGrammar({
        project_id: projectId,
        base_revision_id: baseRevisionId,
        planner: plannerName,
        params
      }));
    } catch (caught) {
      setError(FAILURE_LABELS[errorCode(caught) ?? ""] ?? safeErrorMessage(caught, "干跑失败。请检查参数与时间线后重试。"));
    } finally { setBusy(false); }
  };

  const runPropose = async () => {
    if (!baseRevisionId) { setError("请先创建时间线。"); return; }
    const params = parseParams();
    if (!params) return;
    setBusy(true); setError("");
    try {
      const created = await window.desktop.proposeEditingGrammar({
        project_id: projectId,
        base_revision_id: baseRevisionId,
        planner: plannerName,
        params
      });
      setProposal(created);
      setPreview(undefined);
      const page = await window.desktop.listEditingGrammarProposals(projectId);
      setList(page.items);
    } catch (caught) {
      setError(FAILURE_LABELS[errorCode(caught) ?? ""] ?? safeErrorMessage(caught, "提案失败。请检查参数后重试。"));
    } finally { setBusy(false); }
  };

  const openProposal = async (item: EditingGrammarProposalListItem) => {
    setBusy(true); setError("");
    try {
      setProposal(await window.desktop.getEditingGrammarProposal({ project_id: projectId, proposal_id: item.id }));
      setPreview(undefined);
    } catch (caught) {
      setError(FAILURE_LABELS[errorCode(caught) ?? ""] ?? safeErrorMessage(caught, "打开提案失败。"));
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
      onNotify("剪辑语法提案已应用为新的正式 Revision。");
      onClose();
    } catch (caught) {
      setError(FAILURE_LABELS[errorCode(caught) ?? ""] ?? safeErrorMessage(caught, "采纳失败。提案可能是空操作或基线已变化。"));
    } finally { setBusy(false); }
  };

  return <Dialog titleId="editing-grammar-title" label="剪辑语法" onClose={onClose} className="editing-grammar">
    <div className="modal-heading">
      <div>
        <h2 id="editing-grammar-title">剪辑语法</h2>
        <p>本地确定性规划：零外传。提案不会自动修改正式 Timeline，采纳后才落新 Revision。</p>
      </div>
      <button className="icon-button" aria-label="关闭剪辑语法" onClick={onClose}>×</button>
    </div>
    {error && <p className="ai-status" role="status">{error}</p>}

    {!proposal && <>
      <label>规划器
        <select aria-label="剪辑语法规划器" value={plannerName} onChange={event => {
          setPlannerName(event.target.value);
          setParamsText(PARAM_PRESETS[event.target.value] ?? "{}");
          setPreview(undefined);
        }}>
          {planners.map(item => <option key={item.name} value={item.name}>{item.title}</option>)}
        </select>
      </label>
      {planner && <p className="readonly-note">{planner.description}</p>}
      <label>参数（JSON）
        <textarea aria-label="规划器参数" rows={8} value={paramsText} onChange={event => setParamsText(event.target.value)} spellCheck={false} />
      </label>
      <div className="modal-actions">
        <button disabled={busy || !plannerName || !baseRevisionId} onClick={() => void runPrepare()}>干跑预览</button>
        <button disabled={busy || !plannerName || !baseRevisionId} onClick={() => void runPropose()}>生成提案</button>
      </div>
      {preview && <section aria-label="干跑结果">
        <h3>干跑结果</h3>
        <p>{preview.summary}</p>
        <p className="readonly-note">操作 {preview.operations_count} 条{preview.noop ? " · 空操作（可提案，不可采纳）" : ""}</p>
        {preview.operations.length > 0 && <ol className="agent-session-steps">
          {preview.operations.slice(0, 12).map((op, index) => <li key={index}><code>{op.op}</code></li>)}
        </ol>}
      </section>}
      {list.length > 0 && <fieldset>
        <legend>历史提案</legend>
        <ul className="agent-session-history">
          {list.slice(0, 8).map(item => <li key={item.id}>
            <button onClick={() => void openProposal(item)}>{item.planner} · {formatLocalStamp(item.created_at)}</button>
          </li>)}
        </ul>
      </fieldset>}
    </>}

    {proposal && <>
      <h3>提案详情</h3>
      <p>{proposal.patch.summary}</p>
      <dl>
        <dt>规划器</dt><dd>{proposal.planner}</dd>
        <dt>基线</dt><dd>{proposal.base_revision_id}</dd>
        <dt>操作数</dt><dd>{proposal.patch.operations.length}</dd>
        <dt>状态</dt><dd>{proposal.applied_revision_id ? `已采纳 → ${proposal.applied_revision_id}` : "未采纳"}</dd>
        <dt>文档哈希</dt><dd>{proposal.proposed_document_sha256}</dd>
      </dl>
      <TimelineDiffView diff={proposal.diff} />
      <div className="modal-actions">
        <button onClick={() => { setProposal(undefined); }}>返回</button>
        {!proposal.applied_revision_id && proposal.patch.operations.length > 0 && (
          <button disabled={busy || !baseRevisionId || proposal.base_revision_id !== baseRevisionId} onClick={() => void applyProposal()}>
            采纳为正式 Timeline
          </button>
        )}
      </div>
      {proposal.base_revision_id !== baseRevisionId && (
        <p className="readonly-note">基线已变化：请返回后基于当前版本重新规划。</p>
      )}
    </>}
  </Dialog>;
}
