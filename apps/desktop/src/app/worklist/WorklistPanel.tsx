import { useEffect, useState } from "react";
import type { ProjectId, TimelineRevisionId, Worklist } from "@aivideo/contracts";
import { Dialog } from "../Dialog.js";

export function WorklistPanel({ projectId, baseRevisionId, onClose, onApplied, onNotify }: { projectId: ProjectId; baseRevisionId: TimelineRevisionId | null; onClose: () => void; onApplied: () => void; onNotify: (message: string) => void }) {
  const [items, setItems] = useState<Worklist[]>([]);
  const [current, setCurrent] = useState<Worklist>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { let active = true; if (!window.desktop.listWorklists) return () => { active = false; }; void window.desktop.listWorklists(projectId).then(page => { if (active) setItems(page.items); }).catch(() => undefined); return () => { active = false; }; }, [projectId]);
  const prepare = async () => {
    if (!baseRevisionId) { setError("请先创建时间线。"); return; }
    setBusy(true); setError("");
    try {
      if (!window.desktop.prepareWorklist || !window.desktop.createWorklist) throw new Error("工作单功能不可用");
      const prepared = await window.desktop.prepareWorklist({ project_id: projectId, base_revision_id: baseRevisionId, steps: [{ kind: "editing_grammar", planner: "drop_short_clips", params: { min_duration_us: 500000 } }], max_steps: 1, token_budget: 1 });
      setCurrent(prepared); setItems(value => [prepared, ...value]);
      const running = await window.desktop.createWorklist({ project_id: projectId, worklist_id: prepared.id, base_revision_id: baseRevisionId });
      setCurrent(running); setItems(value => value.map(item => item.id === running.id ? running : item));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "工作单创建失败。"); } finally { setBusy(false); }
  };
  const apply = async () => {
    const step = current?.steps.find(item => item.status === "waiting_for_apply");
    if (!current || !step || !step.proposal_id || !step.base_revision_id) return;
    setBusy(true); setError("");
    try {
      const proposal = await window.desktop.getEditingGrammarProposal({ project_id: projectId, proposal_id: step.proposal_id });
      if (!window.desktop.applyWorklistStep) throw new Error("工作单功能不可用");
      const done = await window.desktop.applyWorklistStep({ project_id: projectId, worklist_id: current.id, step_id: step.id, base_revision_id: step.base_revision_id, proposed_document_sha256: proposal.proposed_document_sha256 });
      setCurrent(done); setItems(value => value.map(item => item.id === done.id ? done : item)); onApplied(); onNotify("工作单步骤已应用为新的 Revision。");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "工作单步骤应用失败。"); } finally { setBusy(false); }
  };
  const cancel = async () => { if (!current || !window.desktop.cancelWorklist) return; setBusy(true); try { const done = await window.desktop.cancelWorklist({ project_id: projectId, worklist_id: current.id }); setCurrent(done); setItems(value => value.map(item => item.id === done.id ? done : item)); } catch { setError("工作单取消失败。"); } finally { setBusy(false); } };
  return <Dialog titleId="worklist-title" label="AI 工作单" onClose={onClose} className="editing-grammar"><div className="modal-heading"><div><h2 id="worklist-title">AI 工作单</h2><p>当前切片只启用本地剪辑语法步骤；每一步需显式应用。</p></div><button className="icon-button" aria-label="关闭 AI 工作单" onClick={onClose}>×</button></div>{error && <p role="status" className="ai-status">{error}</p>}{!current && <><p className="readonly-note">已有工作单：{items.length} 个</p><button disabled={busy || !baseRevisionId} onClick={() => void prepare()}>创建本地剪辑工作单</button></>}{current && <><p>状态：{current.status}</p><ol className="agent-session-steps">{current.steps.map(step => <li key={step.id}><strong>{step.kind}</strong> · {step.status}{step.proposal_id ? " · 有待审阅提案" : ""}</li>)}</ol><div className="modal-actions">{current.status === "waiting_for_apply" && <button disabled={busy} onClick={() => void apply()}>应用当前步骤</button>}{!["succeeded", "cancelled", "failed", "expired"].includes(current.status) && <button disabled={busy} onClick={() => void cancel()}>取消工作单</button>}<button disabled={busy} onClick={() => setCurrent(undefined)}>返回列表</button></div></>}</Dialog>;
}
