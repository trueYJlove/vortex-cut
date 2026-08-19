import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AssetPresentation,
  GenerationStatus,
  ImageProviderConfigSummary,
  Project,
  ProviderImageGenerationPreparedPreview,
  ProviderImageGenerationRequest,
  ProviderImageGenerationTask,
  ProviderImageSize
} from "@aivideo/contracts";

const TERMINAL = new Set<GenerationStatus>(["succeeded", "failed", "cancelled", "interrupted"]);
const SAFE_ERROR = "操作未完成，请刷新后重试。";
const statusLabel: Record<GenerationStatus, string> = { queued: "排队中", running: "调用中", succeeded: "已生成", failed: "失败", cancelled: "已取消", interrupted: "已中断" };

type Props = { project: Project; assets: AssetPresentation[]; onClose: () => void };
type Confirmation = { preview: ProviderImageGenerationPreparedPreview; retryTaskId?: string };

function upsertTask(items: ProviderImageGenerationTask[], task: ProviderImageGenerationTask) {
  return [...items.filter(item => item.task_id !== task.task_id), task].sort((a, b) => a.attempt - b.attempt);
}

export function ProviderImageGenerationWorkbench({ project, assets, onClose }: Props) {
  const [view, setView] = useState<"create" | "history" | "providers">("create");
  const [configs, setConfigs] = useState<ImageProviderConfigSummary[]>([]);
  const [providerConfigId, setProviderConfigId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState<ProviderImageSize>("1024x1024");
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [requests, setRequests] = useState<ProviderImageGenerationRequest[]>([]);
  const [selectedRequestId, setSelectedRequestId] = useState<string>();
  const [tasks, setTasks] = useState<ProviderImageGenerationTask[]>([]);
  const [providerName, setProviderName] = useState("APIKEY.FUN Images");
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);

  const selectedConfig = configs.find(item => item.provider_config_id === providerConfigId);
  const selectedRequest = requests.find(item => item.request_id === selectedRequestId);
  const presentations = useMemo(() => new Map(assets.map(item => [item.asset.asset_id, item])), [assets]);

  const loadConfigs = useCallback(async () => {
    try {
      const page = await window.desktop.listImageProviderConfigs(project.project_id);
      if (!mounted.current) return;
      setConfigs(page.items);
      setProviderConfigId(current => page.items.some(item => item.provider_config_id === current) ? current : page.items[0]?.provider_config_id ?? "");
    } catch { if (mounted.current) setError(SAFE_ERROR); }
  }, [project.project_id]);

  const loadHistory = useCallback(async () => {
    try {
      const page = await window.desktop.listProviderImageGenerationRequests({ project_id: project.project_id, limit: 100 });
      if (!mounted.current) return;
      setRequests(page.items);
      setSelectedRequestId(current => page.items.some(item => item.request_id === current) ? current : page.items[0]?.request_id);
    } catch { if (mounted.current) setError(SAFE_ERROR); }
  }, [project.project_id]);

  const loadTasks = useCallback(async (requestId: string) => {
    try {
      const page = await window.desktop.listProviderImageGenerationTasks({ request_id: requestId as never, limit: 100 });
      if (mounted.current) setTasks(page.items);
    } catch { if (mounted.current) setError(SAFE_ERROR); }
  }, []);

  useEffect(() => { mounted.current = true; void loadConfigs(); return () => { mounted.current = false; }; }, [loadConfigs]);
  useEffect(() => { if (view === "history") void loadHistory(); }, [view, loadHistory]);
  useEffect(() => { if (!selectedRequestId) { setTasks([]); return; } void loadTasks(selectedRequestId); }, [selectedRequestId, loadTasks]);
  useEffect(() => {
    if (view !== "history" || !selectedRequestId || tasks.every(task => TERMINAL.has(task.status))) return;
    const timer = setInterval(() => void loadTasks(selectedRequestId), 1200);
    return () => clearInterval(timer);
  }, [view, selectedRequestId, tasks, loadTasks]);

  const prepare = async () => {
    if (!providerConfigId || !prompt.trim()) return;
    setBusy(true); setError("");
    try {
      const preview = await window.desktop.prepareProviderImageGeneration({ project_id: project.project_id, request: { provider_config_id: providerConfigId as never, prompt, size } });
      setConfirmation({ preview });
    } catch { setError(SAFE_ERROR); }
    finally { setBusy(false); }
  };

  const confirmCreate = async () => {
    if (!confirmation) return;
    setBusy(true); setError("");
    try {
      const request = { preview_id: confirmation.preview.preview_id, payload_sha256: confirmation.preview.payload_sha256, confirmed: true as const };
      let task: ProviderImageGenerationTask;
      let requestId: string;
      if (confirmation.retryTaskId) {
        task = await window.desktop.retryProviderImageGenerationTask({ task_id: confirmation.retryTaskId as never, request });
        requestId = task.request_id;
      } else {
        const created = await window.desktop.createProviderImageGeneration({ project_id: project.project_id, request });
        task = created.task; requestId = created.request.request_id;
      }
      setPrompt(""); setConfirmation(undefined); setView("history");
      await loadHistory(); setSelectedRequestId(requestId); setTasks(items => upsertTask(items, task));
    } catch { setError(SAFE_ERROR); }
    finally { setBusy(false); }
  };

  const prepareRetry = async (taskId: string) => {
    if (!prompt.trim()) { setError("重试必须重新输入与原请求完全相同的 Prompt。"); return; }
    setBusy(true); setError("");
    try {
      const preview = await window.desktop.prepareProviderImageGenerationRetry({ task_id: taskId as never, request: { prompt } });
      setConfirmation({ preview, retryTaskId: taskId }); setView("create");
    } catch { setError("Prompt 与原请求不一致，或当前任务不可重试。"); }
    finally { setBusy(false); }
  };

  const cancel = async (taskId: string) => {
    setBusy(true); setError("");
    try { const task = await window.desktop.cancelProviderImageGenerationTask(taskId as never); setTasks(items => upsertTask(items, task)); }
    catch { setError(SAFE_ERROR); }
    finally { setBusy(false); }
  };

  const createConfig = async () => {
    if (!providerName.trim()) return;
    setBusy(true); setError("");
    try {
      const config = await window.desktop.createImageProviderConfig({ project_id: project.project_id, config: { display_name: providerName.trim(), enabled: true } });
      await loadConfigs(); setProviderConfigId(config.provider_config_id); setCredential("");
    } catch { setError(SAFE_ERROR); }
    finally { setBusy(false); }
  };

  const saveCredential = async () => {
    if (!providerConfigId || !credential) return;
    setBusy(true); setError("");
    try { await window.desktop.setImageProviderSecret({ provider_config_id: providerConfigId, secret: credential }); setCredential(""); await loadConfigs(); }
    catch { setError("凭据未保存；请确认系统安全存储可用。"); }
    finally { setBusy(false); }
  };

  const deleteCredential = async () => {
    if (!providerConfigId) return;
    setBusy(true); setError("");
    try { await window.desktop.deleteImageProviderSecret(providerConfigId); setCredential(""); await loadConfigs(); }
    catch { setError(SAFE_ERROR); }
    finally { setBusy(false); }
  };

  return <div className="modal-backdrop"><section className="modal generation-modal provider-image-modal" role="dialog" aria-modal="true" aria-labelledby="provider-image-title">
    <div className="modal-heading"><div><h2 id="provider-image-title">真实图片生成（受控）</h2><p>纯文本生成单张 PNG；成功后仅注册为项目受管图片素材，不写入 Timeline。</p></div><button aria-label="关闭真实图片生成" onClick={onClose}>关闭</button></div>
    <div className="generation-tabs"><button className={view === "create" ? "active" : ""} onClick={() => setView("create")}>创建</button><button className={view === "history" ? "active" : ""} onClick={() => setView("history")}>历史</button><button className={view === "providers" ? "active" : ""} onClick={() => setView("providers")}>Provider</button></div>
    <p className="provider-cost-notice"><strong>外部调用与费用提示：</strong>Prompt 会发送给外部 Provider，可能产生费用。一次确认对应每个 Task 最多一次调用；失败或超时后 Provider 仍可能已处理。重试会再次调用并可能再次收费。</p>
    {error && <p className="generation-safe-error" role="alert">{error}</p>}

    {view === "create" && (!confirmation ? <div className="generation-create-form">
      <label>图片 Provider<select aria-label="图片 Provider" value={providerConfigId} onChange={event => setProviderConfigId(event.target.value)}><option value="">请选择</option>{configs.map(item => <option key={item.provider_config_id} value={item.provider_config_id}>{item.display_name} · {item.credential_status === "configured" ? "凭据已配置" : "缺少凭据"}</option>)}</select></label>
      <label>请求尺寸<select aria-label="生成图片尺寸" value={size} onChange={event => setSize(event.target.value as ProviderImageSize)}><option value="1024x1024">1024 × 1024（1K 请求意图）</option></select></label>
      <label>Prompt<textarea aria-label="图片生成 Prompt" value={prompt} maxLength={4000} rows={8} onChange={event => setPrompt(event.target.value)} placeholder="仅在当前表单和短期确认期间保留；历史不会显示正文。" /></label>
      <p className="readonly-note">Prompt 明文不写入数据库、Job、日志或历史记录；不要粘贴密钥、隐私数据或字幕/转写正文。</p>
      <div className="modal-actions"><button disabled={busy || !providerConfigId || !prompt.trim() || !selectedConfig?.enabled} onClick={() => void prepare()}>{busy ? "准备中…" : "准备付费调用确认"}</button></div>
    </div> : <div className="generation-confirm">
      <h3>{confirmation.retryTaskId ? "确认再次调用并可能再次收费" : "确认外部图片调用"}</h3>
      <dl><dt>Provider</dt><dd>{confirmation.preview.provider.provider_kind}</dd><dt>模型</dt><dd>{confirmation.preview.provider.model}</dd><dt>请求尺寸</dt><dd>{confirmation.preview.size}（实际输出以 Provider 返回为准）</dd><dt>图片数</dt><dd>1</dd><dt>Prompt</dt><dd>正文不回显；SHA-256：{confirmation.preview.prompt_sha256}</dd><dt>估算费用</dt><dd>{confirmation.preview.estimated_cost === null ? "未配置" : `${confirmation.preview.estimated_cost_currency} ${confirmation.preview.estimated_cost.toFixed(2)} · ${confirmation.preview.price_tier}`}</dd><dt>确认有效期</dt><dd>{confirmation.preview.expires_at}</dd></dl>
      <div className="modal-actions"><button disabled={busy} onClick={() => setConfirmation(undefined)}>返回修改</button><button disabled={busy} onClick={() => void confirmCreate()}>{busy ? "创建中…" : confirmation.retryTaskId ? "确认重试并再次调用" : "确认发送并创建任务"}</button></div>
    </div>)}

    {view === "providers" && <div className="provider-image-configs">
      <fieldset><legend>创建固定协议 Provider</legend><label>显示名称<input aria-label="图片 Provider 名称" value={providerName} maxLength={120} onChange={event => setProviderName(event.target.value)} /></label><p className="readonly-note">协议固定为 apikey_fun_images / gpt-image-2；1K：¥0.10/张，2K：¥0.15/张。当前仅开放 1024 × 1024（1K 请求意图）；实际输出保留 Provider 原生尺寸，不能配置 URL、Header、模型或价格。</p><button disabled={busy || !providerName.trim()} onClick={() => void createConfig()}>创建 Provider</button></fieldset>
      <fieldset><legend>OS 加密凭据</legend><label>Provider<select aria-label="凭据对应图片 Provider" value={providerConfigId} onChange={event => setProviderConfigId(event.target.value)}><option value="">请选择</option>{configs.map(item => <option key={item.provider_config_id} value={item.provider_config_id}>{item.display_name} · {item.credential_status === "configured" ? "已配置" : "未配置"}</option>)}</select></label><label>新凭据<input aria-label="图片 Provider 凭据" type="password" autoComplete="off" value={credential} onChange={event => setCredential(event.target.value)} /></label><div className="modal-actions"><button disabled={busy || !providerConfigId || !credential} onClick={() => void saveCredential()}>安全保存</button><button disabled={busy || !providerConfigId} onClick={() => void deleteCredential()}>删除凭据</button></div><p className="readonly-note">凭据只在 Electron Main 的 OS 加密存储与 Core 进程内存中存在，不会回传 Renderer。</p></fieldset>
    </div>}

    {view === "history" && <div className="generation-history"><div className="generation-history-toolbar"><strong>安全历史（不含 Prompt 正文）</strong><button disabled={busy} onClick={() => void loadHistory()}>刷新</button></div><div className="generation-history-grid">
      <div className="generation-request-list">{requests.length ? requests.map(request => <button className={selectedRequestId === request.request_id ? "active" : ""} key={request.request_id} onClick={() => setSelectedRequestId(request.request_id)}><strong>{request.parameters.size}</strong><small>{request.created_at}</small><small>{request.prompt_sha256}</small></button>) : <p>尚无真实图片生成记录。</p>}</div>
      <div className="generation-task-list">{selectedRequest && <dl className="generation-request-summary"><dt>模式</dt><dd>{selectedRequest.execution_mode}</dd><dt>请求尺寸</dt><dd>{selectedRequest.parameters.size}</dd><dt>Prompt</dt><dd>仅保留 hash</dd></dl>}{tasks.map(task => { const presentation = task.output_asset_id ? presentations.get(task.output_asset_id) : undefined; return <article className={`generation-task status-${task.status}`} key={task.task_id}><div><strong>Attempt {task.attempt}</strong><span>{statusLabel[task.status]}</span></div><small>Provider 调用：{task.provider_call_count} 次</small><small>{task.provider_may_have_processed ? "Provider 可能已处理" : "尚无 Provider 已处理证据"}</small>{task.error && <p className="generation-safe-error">{task.error.message}</p>}{task.status === "succeeded" && task.result_summary && <><p className="generation-success">已注册受管图片：{task.result_summary.asset.display_name}（实际尺寸 {task.result_summary.output.width} × {task.result_summary.output.height}）</p>{presentation?.media_url && <img className="provider-image-preview" src={presentation.media_url} alt={task.result_summary.asset.display_name} />}</>}<div className="generation-task-actions"><button disabled={busy || !(task.status === "queued" || task.status === "running")} onClick={() => void cancel(task.task_id)}>取消</button><button disabled={busy || !(task.status === "failed" || task.status === "cancelled" || task.status === "interrupted")} onClick={() => void prepareRetry(task.task_id)}>用当前表单 Prompt 准备重试</button></div></article>; })}</div>
    </div><p className="readonly-note">若要重试，请先在“创建”页重新输入与原请求完全相同的 Prompt，再回到此处准备重试；重试可能再次收费。</p></div>}
  </section></div>;
}