import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "../Dialog.js";
import type {
  AssetPresentation,
  Project,
  ShotListRevisionCreateInput,
  ShotListRevisionDetail,
  ShotListRevisionSummary,
  ShotListState,
  ShotRequirementInput,
} from "@aivideo/contracts";
import { ShotRequirementImageFulfillmentPanel } from "./ShotRequirementImageFulfillmentPanel.js";
import { ShotRequirementTimelineBatchAssemblyPanel } from "./ShotRequirementTimelineBatchAssemblyPanel.js";

const ZERO_SIDE_EFFECT_NOTICE = "人工规划素材需求；不会调用 Provider、不会生成媒体、不会写入时间线。";
const SAFE_ERROR = "操作未完成，请重新载入后重试。";

type Props = { project: Project; assets: AssetPresentation[]; onClose: () => void };
type DraftShot = ShotRequirementInput & { client_id: string; duration_seconds: string };
type Draft = { title: string; summary: string; requirements: DraftShot[] };

let draftSequence = 0;
function newShot(source?: ShotRequirementInput): DraftShot {
  draftSequence += 1;
  return {
    client_id: `draft-shot-${draftSequence}`,
    title: source?.title ?? "",
    visual_direction: source?.visual_direction ?? "",
    target_duration_us: source?.target_duration_us ?? null,
    duration_seconds: source?.target_duration_us === null || source?.target_duration_us === undefined ? "" : String(source.target_duration_us / 1_000_000),
    visual: source ? { ...source.visual } : { requirement_kind: "image", source_asset_id: null },
    narration: source?.narration ? { ...source.narration } : null,
  };
}
function emptyDraft(): Draft { return { title: "", summary: "", requirements: [newShot()] }; }
function draftFromRevision(revision: ShotListRevisionDetail): Draft {
  return { title: revision.title, summary: revision.summary, requirements: revision.requirements.map(newShot) };
}
function toInput(draft: Draft, baseRevisionId: ShotListRevisionDetail["shot_list_revision_id"] | null): ShotListRevisionCreateInput | null {
  if (!draft.title.trim() || draft.title.length > 120 || draft.summary.length > 4000 || draft.requirements.length < 1 || draft.requirements.length > 24) return null;
  const requirements: ShotRequirementInput[] = [];
  for (const item of draft.requirements) {
    const seconds = item.duration_seconds.trim() === "" ? null : Number(item.duration_seconds);
    const duration = seconds === null ? null : Math.round(seconds * 1_000_000);
    if (!item.title.trim() || item.title.length > 120 || !item.visual_direction.trim() || item.visual_direction.length > 2000
      || (duration !== null && (!Number.isFinite(duration) || duration < 100_000 || duration > 600_000_000))
      || (item.visual.requirement_kind === "existing_media" && !item.visual.source_asset_id)
      || (item.narration !== null && (!item.narration.text.trim() || item.narration.text.length > 2000))) return null;
    requirements.push({
      title: item.title,
      visual_direction: item.visual_direction,
      target_duration_us: duration,
      visual: item.visual.requirement_kind === "existing_media"
        ? { requirement_kind: "existing_media", source_asset_id: item.visual.source_asset_id }
        : { requirement_kind: "image", source_asset_id: null },
      narration: item.narration ? { requirement_kind: "tts", text: item.narration.text } : null,
    });
  }
  return { schema_version: 1, base_revision_id: baseRevisionId, title: draft.title, summary: draft.summary, requirements };
}

export function ShotRequirementWorkbench({ project, assets, onClose }: Props) {
  const [state, setState] = useState<ShotListState>();
  const [history, setHistory] = useState<ShotListRevisionSummary[]>([]);
  const [selected, setSelected] = useState<ShotListRevisionDetail>();
  const [draft, setDraft] = useState<Draft>(() => emptyDraft());
  const [tab, setTab] = useState<"edit" | "history" | "fulfillment">("edit");
  const [fulfillmentRevision, setFulfillmentRevision] = useState<ShotListRevisionDetail>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirming, setConfirming] = useState(false);
  const epochRef = useRef(0);
  const mountedRef = useRef(true);

  const visualAssets = useMemo(() => assets.filter(item => ["video", "image"].includes(item.asset.kind) && item.asset.availability === "available"), [assets]);
  const currentId = state?.current_revision?.shot_list_revision_id ?? null;
  const validInput = useMemo(() => toInput(draft, currentId), [draft, currentId]);
  const isCurrent = useCallback((epoch: number) => mountedRef.current && epoch === epochRef.current, []);

  const load = useCallback(async (epoch: number) => {
    setBusy(true); setError("");
    try {
      const [nextState, page] = await Promise.all([
        window.desktop.getShotList(project.project_id),
        window.desktop.listShotListRevisions({ project_id: project.project_id, limit: 100 }),
      ]);
      if (!isCurrent(epoch)) return;
      setState(nextState); setHistory(page.items); setSelected(undefined);
      setDraft(nextState.current_revision ? draftFromRevision(nextState.current_revision) : emptyDraft());
    } catch { if (isCurrent(epoch)) setError(SAFE_ERROR); }
    finally { if (isCurrent(epoch)) setBusy(false); }
  }, [isCurrent, project.project_id]);

  useEffect(() => {
    mountedRef.current = true;
    const epoch = ++epochRef.current;
    setDraft(emptyDraft()); setState(undefined); setHistory([]); setSelected(undefined); setFulfillmentRevision(undefined); setNotice(""); setError(""); setConfirming(false);
    void load(epoch);
    return () => { mountedRef.current = false; epochRef.current += 1; };
  }, [load]);

  useEffect(() => {
    if (tab !== "fulfillment") return;
    const confirmedId = state?.confirmed_revision?.shot_list_revision_id;
    if (!confirmedId) { setFulfillmentRevision(undefined); return; }
    if (state?.current_revision?.shot_list_revision_id === confirmedId) {
      setFulfillmentRevision(state.current_revision);
      return;
    }
    const epoch = epochRef.current;
    setBusy(true); setError("");
    void window.desktop.getShotListRevision(confirmedId)
      .then(detail => { if (isCurrent(epoch)) setFulfillmentRevision(detail); })
      .catch(() => { if (isCurrent(epoch)) setError(SAFE_ERROR); })
      .finally(() => { if (isCurrent(epoch)) setBusy(false); });
  }, [isCurrent, state, tab]);

  const patchShot = (index: number, patch: Partial<DraftShot>) => setDraft(current => ({ ...current, requirements: current.requirements.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) }));
  const move = (index: number, delta: number) => setDraft(current => {
    const target = index + delta;
    if (target < 0 || target >= current.requirements.length) return current;
    const requirements = [...current.requirements];
    [requirements[index], requirements[target]] = [requirements[target]!, requirements[index]!];
    return { ...current, requirements };
  });
  const remove = (index: number) => setDraft(current => current.requirements.length === 1 ? current : ({ ...current, requirements: current.requirements.filter((_, itemIndex) => itemIndex !== index) }));

  const save = async () => {
    const input = toInput(draft, currentId); if (!input) return;
    const epoch = epochRef.current; setBusy(true); setError(""); setNotice(""); setConfirming(false);
    try {
      const result = await window.desktop.createShotListRevision({ project_id: project.project_id, revision: input });
      if (!isCurrent(epoch)) return;
      setState(result.state); setDraft(draftFromRevision(result.revision));
      const page = await window.desktop.listShotListRevisions({ project_id: project.project_id, limit: 100 });
      if (!isCurrent(epoch)) return;
      setHistory(page.items); setNotice(result.reused ? "内容未变化，已复用当前 Revision。" : "已保存新的不可变 Revision。");
    } catch (caught) {
      if (isCurrent(epoch)) setError(caught instanceof Error && /SHOT_LIST_CONFLICT|409|CONFLICT/.test(caught.message) ? "当前 Revision 已变化；未覆盖他人修改，请重新载入。" : SAFE_ERROR);
    } finally { if (isCurrent(epoch)) setBusy(false); }
  };

  const loadDetail = async (revisionId: ShotListRevisionSummary["shot_list_revision_id"]) => {
    const epoch = epochRef.current; setBusy(true); setError("");
    try { const detail = await window.desktop.getShotListRevision(revisionId); if (isCurrent(epoch)) setSelected(detail); }
    catch { if (isCurrent(epoch)) setError(SAFE_ERROR); }
    finally { if (isCurrent(epoch)) setBusy(false); }
  };

  const confirm = async () => {
    if (!currentId) return;
    if (!confirming) { setConfirming(true); return; }
    const epoch = epochRef.current; setBusy(true); setError("");
    try {
      const result = await window.desktop.confirmShotListRevision({ project_id: project.project_id, confirmation: { revision_id: currentId, expected_current_revision_id: currentId } });
      if (!isCurrent(epoch)) return;
      setState(result.state); setConfirming(false); setNotice(result.reused ? "当前 Revision 已经确认。" : "当前 Revision 已确认。");
    } catch (caught) {
      if (isCurrent(epoch)) setError(caught instanceof Error && /SHOT_LIST_CONFIRMATION_CONFLICT|409|CONFLICT/.test(caught.message) ? "当前 Revision 已变化，确认未执行，请重新载入。" : SAFE_ERROR);
    } finally { if (isCurrent(epoch)) setBusy(false); }
  };

  const footer = tab === "edit" ? <>
    <button disabled={busy} onClick={() => void load(epochRef.current)}>重新载入</button>
    <button disabled={busy || !currentId} onClick={() => void confirm()}>{confirming ? "再次点击确认当前 Revision" : "确认当前 Revision"}</button>
    <button disabled={busy || !validInput} onClick={() => void save()}>{busy ? "处理中…" : "保存新 Revision"}</button>
  </> : undefined;

  return <Dialog title="镜头与资产需求清单" subtitle={<>{project.name} · 每次保存形成不可变 Revision</>}
      closeLabel="关闭镜头需求工作台" onClose={onClose} className="shot-workbench" footer={footer}>
      <p className="shot-zero-notice">{ZERO_SIDE_EFFECT_NOTICE}</p>
      <div className="generation-tabs" role="tablist"><button role="tab" aria-selected={tab === "edit"} onClick={() => setTab("edit")}>编辑当前需求</button><button role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}>Revision 历史</button><button role="tab" aria-selected={tab === "fulfillment"} onClick={() => setTab("fulfillment")}>图片履约</button></div>
      {error && <p className="generation-safe-error" role="alert">{error}</p>}{notice && <p className="generation-success">{notice}</p>}
      {tab === "edit" ? <div className="shot-editor">
        <label className="generation-field">清单标题<input aria-label="清单标题" maxLength={120} value={draft.title} onChange={event => setDraft(current => ({ ...current, title: event.target.value }))} /></label>
        <label className="generation-field">清单摘要<textarea aria-label="清单摘要" maxLength={4000} value={draft.summary} onChange={event => setDraft(current => ({ ...current, summary: event.target.value }))} /></label>
        <div className="shot-toolbar"><strong>镜头（{draft.requirements.length}/24）</strong><button disabled={busy || draft.requirements.length >= 24} onClick={() => setDraft(current => ({ ...current, requirements: [...current.requirements, newShot()] }))}>添加镜头</button></div>
        <div className="shot-list">{draft.requirements.map((item, index) => <article className="shot-card" key={item.client_id} aria-label={`镜头 ${index + 1}`}>
          <div className="shot-card-heading"><strong>镜头 {index + 1}</strong><span><button aria-label={`上移镜头 ${index + 1}`} disabled={index === 0 || busy} onClick={() => move(index, -1)}>↑</button><button aria-label={`下移镜头 ${index + 1}`} disabled={index === draft.requirements.length - 1 || busy} onClick={() => move(index, 1)}>↓</button><button aria-label={`删除镜头 ${index + 1}`} disabled={draft.requirements.length === 1 || busy} onClick={() => remove(index)}>删除</button></span></div>
          <label>镜头标题<input aria-label={`镜头 ${index + 1} 标题`} maxLength={120} value={item.title} onChange={event => patchShot(index, { title: event.target.value })} /></label>
          <label>画面与构图要求<textarea aria-label={`镜头 ${index + 1} 画面要求`} maxLength={2000} value={item.visual_direction} onChange={event => patchShot(index, { visual_direction: event.target.value })} /></label>
          <label>目标时长（秒，可选）<input aria-label={`镜头 ${index + 1} 目标时长`} type="number" min="0.1" max="600" step="0.1" value={item.duration_seconds} onChange={event => patchShot(index, { duration_seconds: event.target.value })} /></label>
          <fieldset><legend>视觉需求</legend><label><input type="radio" name={`visual-${item.client_id}`} checked={item.visual.requirement_kind === "image"} onChange={() => patchShot(index, { visual: { requirement_kind: "image", source_asset_id: null } })} />新图片需求</label><label><input type="radio" name={`visual-${item.client_id}`} checked={item.visual.requirement_kind === "existing_media"} onChange={() => patchShot(index, { visual: { requirement_kind: "existing_media", source_asset_id: visualAssets[0]?.asset.asset_id ?? null } })} />使用现有素材</label>{item.visual.requirement_kind === "existing_media" && <select aria-label={`镜头 ${index + 1} 现有素材`} value={item.visual.source_asset_id ?? ""} onChange={event => patchShot(index, { visual: { requirement_kind: "existing_media", source_asset_id: event.target.value as never } })}><option value="">选择素材</option>{visualAssets.map(asset => <option key={asset.asset.asset_id} value={asset.asset.asset_id}>{asset.asset.display_name}</option>)}</select>}</fieldset>
          <fieldset><legend>旁白需求</legend><label><input type="radio" name={`narration-${item.client_id}`} checked={item.narration === null} onChange={() => patchShot(index, { narration: null })} />无旁白</label><label><input type="radio" name={`narration-${item.client_id}`} checked={item.narration !== null} onChange={() => patchShot(index, { narration: { requirement_kind: "tts", text: "" } })} />TTS 人工正文</label>{item.narration && <textarea aria-label={`镜头 ${index + 1} 旁白正文`} maxLength={2000} value={item.narration.text} onChange={event => patchShot(index, { narration: { requirement_kind: "tts", text: event.target.value } })} />}</fieldset>
        </article>)}</div>
      </div> : tab === "history" ? <div className="shot-history">
        <div className="shot-history-list">{history.length === 0 ? <p>尚无 Revision。</p> : history.map(item => <button key={item.shot_list_revision_id} onClick={() => void loadDetail(item.shot_list_revision_id)}><strong>{item.title}</strong><small>{item.requirement_count} 个镜头 · {item.created_at}</small>{state?.current_revision?.shot_list_revision_id === item.shot_list_revision_id && <em>当前</em>}{state?.confirmed_revision?.shot_list_revision_id === item.shot_list_revision_id && <em>已确认</em>}</button>)}</div>
        <div className="shot-history-detail">{selected ? <><h3>{selected.title}</h3><p>{selected.summary || "（无摘要）"}</p><ol>{selected.requirements.map(item => <li key={item.shot_requirement_id}><strong>{item.title}</strong><p>{item.visual_direction}</p><small>{item.visual.requirement_kind === "existing_media" ? "现有素材" : "图片需求"}{item.narration ? " · TTS 旁白" : " · 无旁白"}</small></li>)}</ol><button onClick={() => { setDraft(draftFromRevision(selected)); setTab("edit"); setNotice("已复制历史内容；保存仍基于最新 current Revision。"); }}>复制到编辑表单</button><div className="shot-history-fulfillment"><h4>图片履约记录（只读）</h4>{selected.requirements.filter(item => item.visual.requirement_kind === "image" && item.visual.source_asset_id === null).length === 0 ? <p>此 Revision 没有新图片需求。</p> : selected.requirements.filter(item => item.visual.requirement_kind === "image" && item.visual.source_asset_id === null).map(item => <ShotRequirementImageFulfillmentPanel key={item.shot_requirement_id} projectId={project.project_id} revisionId={selected.shot_list_revision_id} requirement={item} readOnly={true} assets={assets} />)}</div></> : <p>选择一个 Revision 按需加载详情。</p>}</div>
      </div> : <div className="shot-fulfillment-workbench">
        {!state?.confirmed_revision ? <p>请先确认一个 Revision，再为其中的新图片需求创建履约任务。</p> : !fulfillmentRevision ? <p>正在载入已确认 Revision…</p> : <>
          <p className="readonly-note">履约只关联已确认 Revision 中的真实 Requirement ID；生成与采用均不会修改 Timeline。</p>
          <ShotRequirementTimelineBatchAssemblyPanel projectId={project.project_id} revisionId={fulfillmentRevision.shot_list_revision_id} requirements={fulfillmentRevision.requirements.filter(item => item.visual.requirement_kind === "image" && item.visual.source_asset_id === null)} />
          {fulfillmentRevision.requirements.filter(item => item.visual.requirement_kind === "image" && item.visual.source_asset_id === null).length === 0
            ? <p>已确认 Revision 中没有待履约的新图片需求。</p>
            : fulfillmentRevision.requirements.filter(item => item.visual.requirement_kind === "image" && item.visual.source_asset_id === null).map(item =>
              <ShotRequirementImageFulfillmentPanel key={item.shot_requirement_id} projectId={project.project_id} revisionId={fulfillmentRevision.shot_list_revision_id} requirement={item} readOnly={false} assets={assets} />
            )}
        </>}
      </div>}
    </Dialog>;
}
