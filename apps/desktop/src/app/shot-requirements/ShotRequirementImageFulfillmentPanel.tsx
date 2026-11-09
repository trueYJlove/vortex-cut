import { ShotRequirementTimelineAssemblyPanel } from "./ShotRequirementTimelineAssemblyPanel.js";
import { Dialog } from '../Dialog.js';
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AssetPresentation,
  ImageProviderConfigSummary,
  ProjectId,
  ProviderImageGenerationRequest,
  ProviderImageGenerationTask,
  ShotListRevisionId,
  ShotRequirement,
  ShotRequirementImageFulfillmentPreparedPreview,
  ShotRequirementImageFulfillmentState,
  ShotRequirementImageGenerationLink,
} from "@aivideo/contracts";

const SAFE_ERROR = "图片履约操作未完成，请刷新后重试。";
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
const lifecycleLabel: Record<ShotRequirementImageFulfillmentState["lifecycle"], string> = {
  unstarted: "尚未生成",
  in_progress: "生成中",
  review_required: "等待采用",
  adopted: "已采用",
  adopted_unavailable: "已采用素材不可用",
  no_usable_output: "暂无可用结果",
};

type Props = {
  projectId: ProjectId;
  revisionId: ShotListRevisionId;
  requirement: ShotRequirement;
  readOnly: boolean;
  assets: AssetPresentation[];
};
type LinkedGeneration = {
  link: ShotRequirementImageGenerationLink;
  request: ProviderImageGenerationRequest | null;
  tasks: ProviderImageGenerationTask[];
};
type AdoptionCandidate = {
  link: ShotRequirementImageGenerationLink;
  task: ProviderImageGenerationTask;
};
type RetryConfirmation = {
  task: ProviderImageGenerationTask;
  preview: Awaited<ReturnType<Window["desktop"]['prepareProviderImageGenerationRetry']>>;
};

export function ShotRequirementImageFulfillmentPanel({ projectId, revisionId, requirement, readOnly, assets }: Props) {
  const [state, setState] = useState<ShotRequirementImageFulfillmentState>();
  const [providers, setProviders] = useState<ImageProviderConfigSummary[]>([]);
  const [providerConfigId, setProviderConfigId] = useState("");
  const [prompt, setPrompt] = useState(requirement.visual_direction);
  const [preview, setPreview] = useState<ShotRequirementImageFulfillmentPreparedPreview>();
  const [generations, setGenerations] = useState<LinkedGeneration[]>([]);
  const [adoptionCandidate, setAdoptionCandidate] = useState<AdoptionCandidate>();
  const [retryConfirmation, setRetryConfirmation] = useState<RetryConfirmation>();
  const [resultNotice, setResultNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const presentations = useMemo(() => new Map(assets.map(item => [item.asset.asset_id, item])), [assets]);
  const canWrite = !readOnly && state?.currently_confirmed === true;

  const load = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const [nextState, linkPage, providerPage] = await Promise.all([
        window.desktop.getShotRequirementImageFulfillment({ project_id: projectId, requirement_id: requirement.shot_requirement_id }),
        window.desktop.listShotRequirementImageFulfillmentLinks({ project_id: projectId, requirement_id: requirement.shot_requirement_id, limit: 100 }),
        window.desktop.listImageProviderConfigs(projectId),
      ]);
      const linked = await Promise.all(linkPage.items.map(async link => {
        const [request, taskPage] = await Promise.all([
          window.desktop.getProviderImageGenerationRequest(link.request_id),
          window.desktop.listProviderImageGenerationTasks({ request_id: link.request_id, limit: 100 }),
        ]);
        return { link, request, tasks: taskPage.items };
      }));
      if (!mounted.current) return;
      setState(nextState); setGenerations(linked); setProviders(providerPage.items);
      setProviderConfigId(current => providerPage.items.some(item => item.provider_config_id === current)
        ? current : providerPage.items[0]?.provider_config_id ?? "");
    } catch { if (mounted.current) setError(SAFE_ERROR); }
    finally { if (mounted.current) setBusy(false); }
  }, [projectId, requirement.shot_requirement_id]);

  useEffect(() => {
    mounted.current = true;
    setPrompt(requirement.visual_direction); setPreview(undefined); setAdoptionCandidate(undefined); setRetryConfirmation(undefined); setResultNotice("");
    void load();
    return () => { mounted.current = false; };
  }, [load, requirement.visual_direction]);

  useEffect(() => {
    if (generations.flatMap(item => item.tasks).every(task => TERMINAL.has(task.status))) return;
    const timer = setInterval(() => void load(), 1200);
    return () => clearInterval(timer);
  }, [generations, load]);

  const prepare = async () => {
    if (!canWrite || !providerConfigId || !prompt.trim()) return;
    setBusy(true); setError(""); setResultNotice("");
    try {
      const prepared = await window.desktop.prepareShotRequirementImageFulfillment({
        project_id: projectId,
        requirement_id: requirement.shot_requirement_id,
        request: { expected_confirmed_revision_id: revisionId, provider_config_id: providerConfigId as never, prompt },
      });
      if (!mounted.current) return;
      setPrompt("");
      setPreview(prepared);
    } catch { if (mounted.current) setError(SAFE_ERROR); }
    finally { if (mounted.current) setBusy(false); }
  };

  const create = async () => {
    if (!canWrite || !preview) return;
    setBusy(true); setError("");
    try {
      const result = await window.desktop.createShotRequirementImageFulfillment({
        project_id: projectId,
        requirement_id: requirement.shot_requirement_id,
        request: {
          preview_id: preview.preview_id,
          fulfillment_payload_sha256: preview.fulfillment_payload_sha256,
          expected_confirmed_revision_id: revisionId,
          confirmed: true,
        },
      });
      if (!mounted.current) return;
      setPreview(undefined);
      setResultNotice(`${result.generation_reused ? "已复用既有生成请求" : "已创建生成请求"}；${result.link_reused ? "已复用既有关联" : "已建立需求关联"}。`);
      await load();
    } catch { if (mounted.current) setError(SAFE_ERROR); }
    finally { if (mounted.current) setBusy(false); }
  };

  const cancel = async (task: ProviderImageGenerationTask) => {
    if (!canWrite || !(task.status === "queued" || task.status === "running")) return;
    setBusy(true); setError("");
    try { await window.desktop.cancelProviderImageGenerationTask(task.task_id); await load(); }
    catch { if (mounted.current) setError(SAFE_ERROR); }
    finally { if (mounted.current) setBusy(false); }
  };

  const retry = async (task: ProviderImageGenerationTask) => {
    if (!canWrite || !prompt.trim() || !(task.status === "failed" || task.status === "cancelled" || task.status === "interrupted")) return;
    setBusy(true); setError("");
    try {
      const retryPreview = await window.desktop.prepareProviderImageGenerationRetry({ task_id: task.task_id, request: { prompt } });
      if (!mounted.current) return;
      setPrompt("");
      setRetryConfirmation({ task, preview: retryPreview });
    } catch { if (mounted.current) setError(SAFE_ERROR); }
    finally { if (mounted.current) setBusy(false); }
  };

  const confirmRetry = async () => {
    if (!canWrite || !retryConfirmation) return;
    setBusy(true); setError("");
    try {
      await window.desktop.retryProviderImageGenerationTask({
        task_id: retryConfirmation.task.task_id,
        request: {
          preview_id: retryConfirmation.preview.preview_id,
          payload_sha256: retryConfirmation.preview.payload_sha256,
          confirmed: true,
        },
      });
      if (!mounted.current) return;
      setRetryConfirmation(undefined);
      setResultNotice("已确认创建重试任务；可能产生新的 Provider 调用与费用。");
      await load();
    } catch { if (mounted.current) setError(SAFE_ERROR); }
    finally { if (mounted.current) setBusy(false); }
  };

  const adopt = async () => {
    if (!canWrite || !adoptionCandidate?.task.output_asset_id) return;
    setBusy(true); setError("");
    try {
      const response = await window.desktop.adoptShotRequirementImageFulfillment({
        project_id: projectId,
        requirement_id: requirement.shot_requirement_id,
        request: {
          generation_link_id: adoptionCandidate.link.link_id,
          task_id: adoptionCandidate.task.task_id,
          asset_id: adoptionCandidate.task.output_asset_id,
          expected_current_adoption_id: state?.current_adoption?.adoption_id ?? null,
          confirmed: true,
        },
      });
      if (!mounted.current) return;
      setAdoptionCandidate(undefined);
      setResultNotice(response.reused ? "该结果已经是当前采用项。" : "已采用图片结果；未修改 Timeline。");
      await load();
    } catch (caught) {
      if (!mounted.current) return;
      setAdoptionCandidate(undefined);
      if (caught instanceof Error && caught.message.includes("SHOT_REQUIREMENT_IMAGE_ADOPTION_CONFLICT")) {
        await load();
        if (mounted.current) setError("当前采用项已变化，已刷新；请核对后重新操作。");
      } else setError(SAFE_ERROR);
    } finally { if (mounted.current) setBusy(false); }
  };

  return <section className="shot-fulfillment" aria-label={`${requirement.title} 图片履约`}>
    <header><div><strong>{requirement.title}</strong><small>{state ? lifecycleLabel[state.lifecycle] : "载入中"}</small></div><button disabled={busy} onClick={() => void load()}>刷新履约状态</button></header>
    {readOnly && <p className="readonly-note readonly-note--plain">历史 Revision 仅供查看，不能 Prepare、Create、Retry、Cancel 或 Adopt。</p>}
    {error && <p role="alert">{error}</p>}
    {resultNotice && <p role="status">{resultNotice}</p>}

    {canWrite && !preview && <div className="shot-fulfillment-create">
      <label>图片 Provider<select aria-label={`${requirement.title} 图片 Provider`} value={providerConfigId} onChange={event => setProviderConfigId(event.target.value)}><option value="">请选择</option>{providers.map(item => <option key={item.provider_config_id} value={item.provider_config_id}>{item.display_name} · {item.credential_status === "configured" ? "已配置" : "未配置"}</option>)}</select></label>
      <label>图片生成 Prompt<textarea aria-label={`${requirement.title} 履约 Prompt`} maxLength={16000} value={prompt} onChange={event => setPrompt(event.target.value)} /></label>
      <p className="readonly-note">Prompt 只在当前表单与短期确认中存在；Prepare 本身不调用 Provider。</p>
      <button disabled={busy || !providerConfigId || !prompt.trim()} onClick={() => void prepare()}>准备图片履约</button>
    </div>}

    {preview && <div className="shot-fulfillment-confirmation" aria-label="图片履约确认">
      <p>即将按当前已确认 Requirement 创建或复用 Stage 4D 图片生成任务。</p>
      <dl><dt>Provider / 模型</dt><dd>{preview.provider.provider_kind} / {preview.provider.model}</dd><dt>请求意图</dt><dd>{preview.price_tier} · PNG · 1 张</dd><dt>估算费用</dt><dd>{preview.estimated_cost === null ? "未配置" : `${preview.estimated_cost_currency} ${preview.estimated_cost.toFixed(2)}`}</dd><dt>Prompt hash</dt><dd>{preview.prompt_sha256}</dd><dt>Requirement hash</dt><dd>{preview.requirement_sha256}</dd><dt>有效期</dt><dd>{preview.expires_at}</dd></dl>
      <div className="modal-actions"><button disabled={busy} onClick={() => setPreview(undefined)}>返回修改</button><button disabled={busy} onClick={() => void create()}>确认创建图片任务</button></div>
    </div>}

    <div className="shot-fulfillment-history">
      <h4>关联生成记录</h4>
      {generations.length === 0 ? <p>尚无关联生成记录。</p> : generations.map(item => <article key={item.link.link_id} aria-label={`关联 ${item.link.link_id}`}>
        <small>Request {item.link.request_id} · {item.link.created_at}</small>
        {item.tasks.map(task => {
          const output = task.result_summary?.asset;
          const presentation = output ? presentations.get(output.asset_id) : undefined;
          const adoptable = task.status === "succeeded" && output?.availability === "available" && output.storage_mode === "managed";
          return <div className={`generation-task status-${task.status}`} key={task.task_id}>
            <strong>Attempt {task.attempt} · {task.status}</strong><small>Provider 调用：{task.provider_call_count} 次</small>
            {output && <p>受管图片：{output.display_name}</p>}
            {presentation?.media_url && <img className="provider-image-preview" src={presentation.media_url} alt={output?.display_name ?? "生成结果"} />}
            <div className="generation-task-actions">
              <button disabled={!canWrite || busy || !(task.status === "queued" || task.status === "running")} onClick={() => void cancel(task)}>取消</button>
              <button disabled={!canWrite || busy || !prompt.trim() || !(task.status === "failed" || task.status === "cancelled" || task.status === "interrupted")} onClick={() => void retry(task)}>使用当前 Prompt 重试</button>
              <button disabled={!canWrite || busy || !adoptable} onClick={() => setAdoptionCandidate({ link: item.link, task })}>采用此结果</button>
            </div>
          </div>;
        })}
      </article>)}
    </div>

    {retryConfirmation && <Dialog title="确认重试图片生成" onClose={() => setRetryConfirmation(undefined)} className="compact-dialog" footer={<><button onClick={() => setRetryConfirmation(undefined)}>取消重试</button><button disabled={busy} onClick={() => void confirmRetry()}>确认重试并再次调用</button></>}><p>重试会建立新 Attempt，可能再次调用 Provider 并收费。</p><dl><dt>模型</dt><dd>{retryConfirmation.preview.provider.model}</dd><dt>估算费用</dt><dd>{retryConfirmation.preview.estimated_cost === null ? "未配置" : `${retryConfirmation.preview.estimated_cost_currency} ${retryConfirmation.preview.estimated_cost.toFixed(2)}`}</dd><dt>Prompt</dt><dd>正文不回显；{retryConfirmation.preview.prompt_sha256}</dd></dl></Dialog>}
    {adoptionCandidate && <Dialog title="确认采用图片结果" onClose={() => setAdoptionCandidate(undefined)} className="compact-dialog" footer={<><button onClick={() => setAdoptionCandidate(undefined)}>取消采用</button><button disabled={busy} onClick={() => void adopt()}>确认采用此结果</button></>}><p>采用会追加 Requirement 履约记录，<strong>不会修改 Timeline</strong>。</p></Dialog>}
    {state?.current_adoption && <p>当前采用 Asset：{state.current_adoption.asset_id} · ordinal {state.current_adoption.adoption_ordinal}{state.current_asset_availability !== "available" ? " · 当前不可用" : ""}</p>}
    {state?.current_adoption && <ShotRequirementTimelineAssemblyPanel projectId={projectId} requirementId={requirement.shot_requirement_id} adoption={state.current_adoption} available={state.current_asset_availability === "available"} readOnly={readOnly} />}
  </section>;
}
