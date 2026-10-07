import { useEffect, useRef, useState } from "react";
import type { CaptionsProviderProposal, ProjectId, TimelineRevisionId, Worklist } from "@aivideo/contracts";
import { Dialog } from "../Dialog.js";

export function WorklistPanel({ projectId, baseRevisionId, onClose, onApplied, onNotify }: { projectId: ProjectId; baseRevisionId: TimelineRevisionId | null; onClose: () => void; onApplied: () => void; onNotify: (message: string) => void }) {
  const [items, setItems] = useState<Worklist[]>([]);
  const [current, setCurrent] = useState<Worklist>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stepKind, setStepKind] = useState<"editing_grammar" | "captions">("editing_grammar");
  const [transcriptId, setTranscriptId] = useState("");
  const [segmentIds, setSegmentIds] = useState("");
  const [generationId, setGenerationId] = useState("");
  const [providerProposal, setProviderProposal] = useState<CaptionsProviderProposal>();
  const proposalRequestRef = useRef(0);
  useEffect(() => { let active = true; proposalRequestRef.current += 1; setProviderProposal(undefined); setGenerationId(""); setCurrent(undefined); setItems([]); setError(""); setBusy(false); setStepKind("editing_grammar"); setTranscriptId(""); setSegmentIds(""); if (!window.desktop.listWorklists) return () => { active = false; }; void window.desktop.listWorklists(projectId).then(page => { if (active) setItems(page.items); }).catch(() => undefined); return () => { active = false; }; }, [projectId]);
  const prepare = async () => {
    if (!baseRevisionId) { setError("请先创建时间线。"); return; }
    setBusy(true); setError("");
    try {
      if (!window.desktop.prepareWorklist || !window.desktop.createWorklist) throw new Error("工作单功能不可用");
      const params = stepKind === "captions" ? { transcript_id: transcriptId.trim(), segment_ids: segmentIds.split(",").map(value => value.trim()).filter(Boolean), at_index: 0 } : { min_duration_us: 500000 };
      if (stepKind === "captions" && (!params.transcript_id || params.segment_ids.length === 0 || new Set(params.segment_ids).size !== params.segment_ids.length)) throw new Error("请填写 transcript ID 和不重复的 segment ID（逗号分隔）。");
      const prepared = await window.desktop.prepareWorklist({ project_id: projectId, base_revision_id: baseRevisionId, steps: [{ kind: stepKind, planner: stepKind === "captions" ? "captions" : "drop_short_clips", params }], max_steps: 1, token_budget: 1 });
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
      const proposal = step.planner_id === "captions_provider"
        ? await window.desktop.getCaptionsProviderProposal?.({ project_id: projectId, proposal_id: step.proposal_id })
        : await window.desktop.getEditingGrammarProposal({ project_id: projectId, proposal_id: step.proposal_id });
      if (!proposal) throw new Error("字幕 Provider 提案功能不可用");
      let done: Worklist | undefined;
      if (step.planner_id === "captions_provider") {
        if (!window.desktop.applyCaptionsProviderProposal || !window.desktop.listWorklists) throw new Error("字幕 Provider Apply 功能不可用");
        await window.desktop.applyCaptionsProviderProposal({ project_id: projectId, proposal_id: step.proposal_id, base_revision_id: step.base_revision_id, proposed_document_sha256: proposal.proposed_document_sha256 });
        done = (await window.desktop.listWorklists(projectId)).items.find(item => item.id === current.id);
      } else {
        if (!window.desktop.applyWorklistStep) throw new Error("工作单功能不可用");
        done = await window.desktop.applyWorklistStep({ project_id: projectId, worklist_id: current.id, step_id: step.id, base_revision_id: step.base_revision_id, proposed_document_sha256: proposal.proposed_document_sha256 });
      }
      if (!done) throw new Error("工作单状态刷新失败");
      setCurrent(done); setItems(value => value.map(item => item.id === done!.id ? done! : item)); onApplied(); onNotify("工作单步骤已应用为新的 Revision。");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "工作单步骤应用失败。"); } finally { setBusy(false); }
  };
  const loadProviderProposal = async () => {
    if (!generationId.trim() || !window.desktop.createCaptionsProviderProposal) { setError("请填写 generation ID。"); return; }
    const requestId = ++proposalRequestRef.current;
    const requestedProjectId = projectId;
    setBusy(true); setError("");
    try {
      const proposal = await window.desktop.createCaptionsProviderProposal({ project_id: requestedProjectId, generation_id: generationId.trim() });
      if (requestId === proposalRequestRef.current && requestedProjectId === projectId) setProviderProposal(proposal);
    } catch (caught) {
      if (requestId === proposalRequestRef.current && requestedProjectId === projectId) setError(caught instanceof Error ? caught.message : "字幕 Provider 提案读取失败。");
    } finally { if (requestId === proposalRequestRef.current) setBusy(false); }
  };
  const cancel = async () => { if (!current || !window.desktop.cancelWorklist) return; setBusy(true); try { const done = await window.desktop.cancelWorklist({ project_id: projectId, worklist_id: current.id }); setCurrent(done); setItems(value => value.map(item => item.id === done.id ? done : item)); } catch { setError("工作单取消失败。"); } finally { setBusy(false); } };
  return <Dialog titleId="worklist-title" label="AI 工作单" onClose={onClose} className="editing-grammar"><div className="modal-heading"><div><h2 id="worklist-title">AI 工作单</h2><p>当前切片只启用本地剪辑语法步骤；每一步需显式应用。</p></div><button className="icon-button" aria-label="关闭 AI 工作单" onClick={onClose}>×</button></div>{error && <p role="status" className="ai-status">{error}</p>}{!current && <><p className="readonly-note">已有工作单：{items.length} 个</p><section aria-label="字幕 Provider 只读提案"><label>字幕 Provider generation ID<input aria-label="字幕 Provider generation ID" value={generationId} onChange={event => setGenerationId(event.target.value)} /></label><button disabled={busy || !generationId.trim()} onClick={() => void loadProviderProposal()}>查看字幕提案（只读）</button>{providerProposal && <div className="readonly-note"><strong>提案：</strong>{providerProposal.patch.summary}<p>基线：{providerProposal.base_document_sha256} → {providerProposal.proposed_document_sha256}</p><ul>{providerProposal.patch.operations.map((operation, index) => <li key={index}>{operation.caption_id} → {operation.text}</li>)}</ul><small>仅在你明确点击下方按钮后应用。</small><button disabled={busy || !window.desktop.applyCaptionsProviderProposal} onClick={() => void (async () => { if (!window.desktop.applyCaptionsProviderProposal) return; setBusy(true); setError(""); try { await window.desktop.applyCaptionsProviderProposal({ project_id: projectId, proposal_id: providerProposal.captions_provider_proposal_id, base_revision_id: providerProposal.base_revision_id, proposed_document_sha256: providerProposal.proposed_document_sha256 }); onApplied(); onNotify("字幕 Provider 提案已应用为新的 Revision。"); } catch (caught) { setError(caught instanceof Error ? caught.message : "字幕 Provider 提案应用失败。"); } finally { setBusy(false); } })()}>应用字幕提案</button></div>}</section>{items.length > 0 && <div className="worklist-history" aria-label="历史工作单">{items.map(item => <button key={item.id} type="button" className="mini-btn" onClick={() => setCurrent(item)}>{item.id} · {item.status}</button>)}</div>}<label>步骤类型<select aria-label="工作单步骤类型" value={stepKind} onChange={event => setStepKind(event.target.value as "editing_grammar" | "captions")}><option value="editing_grammar">剪辑语法</option><option value="captions">本地转录字幕</option></select></label>{stepKind === "captions" && <><label>Transcript ID<input aria-label="Transcript ID" value={transcriptId} onChange={event => setTranscriptId(event.target.value)} /></label><label>Segment IDs（逗号分隔）<input aria-label="Segment IDs" value={segmentIds} onChange={event => setSegmentIds(event.target.value)} /></label></>}<button disabled={busy || !baseRevisionId} onClick={() => void prepare()}>创建本地工作单</button></>}{current && <><p>状态：{current.status}</p><ol className="agent-session-steps">{current.steps.map(step => <li key={step.id}><strong>{step.kind}</strong> · {step.status}{step.proposal_id ? " · 有待审阅提案" : ""}</li>)}</ol><div className="modal-actions">{current.status === "waiting_for_apply" && <button disabled={busy} onClick={() => void apply()}>应用当前步骤</button>}{!["succeeded", "cancelled", "failed", "expired"].includes(current.status) && <button disabled={busy} onClick={() => void cancel()}>取消工作单</button>}<button disabled={busy} onClick={() => setCurrent(undefined)}>返回列表</button></div></>}</Dialog>;
}
