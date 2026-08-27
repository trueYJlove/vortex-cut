import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "../Dialog.js";
import type {
  AssetPresentation,
  GenerationKind,
  GenerationStatus,
  MediaGenerationCreateInput,
  MediaGenerationPrepareInput,
  MediaGenerationPreparedRequest,
  MediaGenerationRequest,
  MediaGenerationTask,
  Project,
} from "@aivideo/contracts";

const SIMULATION_NOTICE = "模拟验证：Provider 调用 0 次；不会生成媒体，不会注册素材，也不会写入时间线。";
const SAFE_ERROR = "操作未完成，请刷新后重试。";
const TERMINAL = new Set<GenerationStatus>(["succeeded", "failed", "cancelled", "interrupted"]);
const statusLabels: Record<GenerationStatus, string> = {
  queued: "排队中",
  running: "运行中",
  succeeded: "验证完成",
  failed: "验证失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
const assetKindLabels: Record<string, string> = { video: "视频", audio: "音频", image: "图片", text: "文本" };
const assetAvailabilityLabels: Record<string, string> = { available: "可用", missing: "缺失", changed: "已变更", unsupported: "不支持" };

type Props = {
  project: Project;
  assets: AssetPresentation[];
  onClose: () => void;
};

type Draft = MediaGenerationPrepareInput;
type PreparedState = {
  value: MediaGenerationPreparedRequest;
  draft: Draft;
  promptCharacterCount: number;
};

type ImageForm = { width: string; height: string; stylePresetId: string; seed: string };
type TtsForm = { voicePresetId: string; language: "zh-CN" | "en-US"; speedMilli: string };

function cloneDraft(draft: Draft): Draft {
  return draft.generation_kind === "image"
    ? { ...draft, input_refs: [...draft.input_refs], parameters: { ...draft.parameters } }
    : { ...draft, input_refs: [...draft.input_refs], parameters: { ...draft.parameters } };
}

function withRequestHash(draft: Draft, requestSha256: string): MediaGenerationCreateInput {
  return draft.generation_kind === "image"
    ? { ...cloneDraft(draft), request_sha256: requestSha256 }
    : { ...cloneDraft(draft), request_sha256: requestSha256 };
}

function upsertRequest(items: MediaGenerationRequest[], request: MediaGenerationRequest) {
  return [request, ...items.filter(item => item.request_id !== request.request_id)];
}

function upsertTask(items: MediaGenerationTask[], task: MediaGenerationTask) {
  return [...items.filter(item => item.task_id !== task.task_id), task].sort((a, b) => a.attempt - b.attempt);
}

function requestKindLabel(kind: GenerationKind) {
  return kind === "image" ? "图片参数验证" : "语音参数验证";
}

export function MediaGenerationWorkbench({ project, assets, onClose }: Props) {
  const [view, setView] = useState<"create" | "history">("create");
  const [kind, setKind] = useState<GenerationKind>("image");
  const [prompt, setPrompt] = useState("");
  const [inputRefs, setInputRefs] = useState<string[]>([]);
  const [imageForm, setImageForm] = useState<ImageForm>({ width: "1024", height: "1024", stylePresetId: "", seed: "" });
  const [ttsForm, setTtsForm] = useState<TtsForm>({ voicePresetId: "validation_voice", language: "zh-CN", speedMilli: "1000" });
  const [prepared, setPrepared] = useState<PreparedState>();
  const [busy, setBusy] = useState<"prepare" | "create" | "history" | "action" | null>(null);
  const [requests, setRequests] = useState<MediaGenerationRequest[]>([]);
  const [selectedRequestId, setSelectedRequestId] = useState<string>();
  const [tasks, setTasks] = useState<MediaGenerationTask[]>([]);
  const [lastCreate, setLastCreate] = useState<{ requestId: string; taskId: string; reused: boolean }>();
  const [error, setError] = useState("");

  const epochRef = useRef(0);
  const mountedRef = useRef(true);
  const selectedRequestRef = useRef<string | undefined>(undefined);
  const subscriptionsRef = useRef(new Map<string, () => void>());
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const eventRefreshRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const promptRef = useRef(prompt);

  useEffect(() => { promptRef.current = prompt; }, [prompt]);
  useEffect(() => { selectedRequestRef.current = selectedRequestId; }, [selectedRequestId]);

  const stopRefresh = useCallback(() => {
    subscriptionsRef.current.forEach(stop => stop());
    subscriptionsRef.current.clear();
    if (pollRef.current) clearInterval(pollRef.current);
    if (eventRefreshRef.current) clearTimeout(eventRefreshRef.current);
    pollRef.current = undefined;
    eventRefreshRef.current = undefined;
  }, []);

  const isCurrent = useCallback((epoch: number) => mountedRef.current && epoch === epochRef.current, []);

  const refreshTasks = useCallback(async (requestId: string, epoch = epochRef.current) => {
    try {
      const page = await window.desktop.listMediaGenerationTasks({ request_id: requestId as never, limit: 100 });
      if (!isCurrent(epoch) || selectedRequestRef.current !== requestId) return [];
      setTasks(page.items);
      return page.items;
    } catch {
      if (isCurrent(epoch)) setError(SAFE_ERROR);
      return [];
    }
  }, [isCurrent]);

  const scheduleTaskRefresh = useCallback((requestId: string, epoch: number) => {
    if (!isCurrent(epoch) || selectedRequestRef.current !== requestId || eventRefreshRef.current) return;
    eventRefreshRef.current = setTimeout(() => {
      eventRefreshRef.current = undefined;
      void refreshTasks(requestId, epoch);
    }, 120);
  }, [isCurrent, refreshTasks]);

  const watchTasks = useCallback((requestId: string, nextTasks: MediaGenerationTask[], epoch: number) => {
    const active = nextTasks.filter(task => !TERMINAL.has(task.status));
    const activeIds = new Set(active.map(task => task.task_id));
    subscriptionsRef.current.forEach((stop, taskId) => {
      if (!activeIds.has(taskId as never)) {
        stop();
        subscriptionsRef.current.delete(taskId);
      }
    });
    for (const task of active) {
      if (!subscriptionsRef.current.has(task.task_id)) {
        const stop = window.desktop.subscribeJob(task.job_id, () => scheduleTaskRefresh(requestId, epoch));
        subscriptionsRef.current.set(task.task_id, stop);
      }
    }
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = active.length
      ? setInterval(() => void refreshTasks(requestId, epoch), 1500)
      : undefined;
  }, [refreshTasks, scheduleTaskRefresh]);

  const loadHistory = useCallback(async (selectNewest = false) => {
    const epoch = epochRef.current;
    setBusy("history");
    setError("");
    try {
      const page = await window.desktop.listMediaGenerationRequests({ project_id: project.project_id, limit: 100 });
      if (!isCurrent(epoch)) return;
      setRequests(page.items);
      const nextId = selectNewest ? page.items[0]?.request_id : selectedRequestRef.current ?? page.items[0]?.request_id;
      setSelectedRequestId(nextId);
      selectedRequestRef.current = nextId;
      if (!nextId) setTasks([]);
    } catch {
      if (isCurrent(epoch)) setError(SAFE_ERROR);
    } finally {
      if (isCurrent(epoch)) setBusy(null);
    }
  }, [isCurrent, project.project_id]);

  useEffect(() => {
    mountedRef.current = true;
    epochRef.current += 1;
    const epoch = epochRef.current;
    void loadHistory();
    return () => {
      mountedRef.current = false;
      epochRef.current = epoch + 1;
      promptRef.current = "";
      stopRefresh();
    };
  }, [loadHistory, stopRefresh]);

  useEffect(() => {
    stopRefresh();
    if (!selectedRequestId) {
      setTasks([]);
      return;
    }
    selectedRequestRef.current = selectedRequestId;
    const epoch = epochRef.current;
    void refreshTasks(selectedRequestId, epoch).then(nextTasks => {
      if (isCurrent(epoch) && selectedRequestRef.current === selectedRequestId) watchTasks(selectedRequestId, nextTasks, epoch);
    });
    return stopRefresh;
  }, [isCurrent, refreshTasks, selectedRequestId, stopRefresh, watchTasks]);

  useEffect(() => {
    if (selectedRequestId && tasks.length) watchTasks(selectedRequestId, tasks, epochRef.current);
  }, [selectedRequestId, tasks, watchTasks]);
  useEffect(() => {
    const allowed = new Set(assets.map(item => item.asset.asset_id));
    setInputRefs(current => {
      const filtered = current.filter(id => allowed.has(id as never));
      if (filtered.length !== current.length) setPrepared(undefined);
      return filtered.length === current.length ? current : filtered;
    });
  }, [assets]);
  const invalidatePrepared = () => {
    setPrepared(undefined);
    setLastCreate(undefined);
    setError("");
  };

  const toggleAsset = (assetId: string) => {
    invalidatePrepared();
    setInputRefs(current => current.includes(assetId) ? current.filter(id => id !== assetId) : current.length < 32 ? [...current, assetId] : current);
  };

  const draft = useMemo<Draft | null>(() => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || prompt.length > 4000 || inputRefs.length < 1 || inputRefs.length > 32) return null;
    if (kind === "image") {
      const width = Number(imageForm.width);
      const height = Number(imageForm.height);
      const seed = imageForm.seed === "" ? undefined : Number(imageForm.seed);
      if (!Number.isInteger(width) || width < 64 || width > 4096 || !Number.isInteger(height) || height < 64 || height > 4096) return null;
      if (seed !== undefined && (!Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647)) return null;
      return {
        generation_kind: "image",
        prompt,
        input_refs: inputRefs,
        parameters: {
          width,
          height,
          ...(imageForm.stylePresetId.trim() ? { style_preset_id: imageForm.stylePresetId.trim() } : {}),
          ...(seed === undefined ? {} : { seed }),
        },
      };
    }
    const speed = Number(ttsForm.speedMilli);
    if (!ttsForm.voicePresetId.trim() || !Number.isInteger(speed) || speed < 500 || speed > 2000) return null;
    return {
      generation_kind: "tts",
      prompt,
      input_refs: inputRefs,
      parameters: { voice_preset_id: ttsForm.voicePresetId.trim(), language: ttsForm.language, speed_milli: speed },
    };
  }, [imageForm, inputRefs, kind, prompt, ttsForm]);

  const prepare = async () => {
    if (!draft) return;
    const epoch = epochRef.current;
    const snapshot = cloneDraft(draft);
    setBusy("prepare");
    setError("");
    try {
      const value = await window.desktop.prepareMediaGeneration({ project_id: project.project_id, request: snapshot });
      if (!isCurrent(epoch)) return;
      setPrepared({ value, draft: snapshot, promptCharacterCount: snapshot.prompt.length });
    } catch {
      if (isCurrent(epoch)) setError(SAFE_ERROR);
    } finally {
      if (isCurrent(epoch)) setBusy(null);
    }
  };

  const create = async () => {
    if (!prepared) return;
    const epoch = epochRef.current;
    const snapshot = prepared;
    setBusy("create");
    setError("");
    try {
      const response = await window.desktop.createMediaGeneration({
        project_id: project.project_id,
        request: withRequestHash(snapshot.draft, snapshot.value.request_sha256),
      });
      if (!isCurrent(epoch)) return;
      setPrompt("");
      promptRef.current = "";
      setPrepared(undefined);
      setRequests(current => upsertRequest(current, response.request));
      setSelectedRequestId(response.request.request_id);
      selectedRequestRef.current = response.request.request_id;
      setTasks([response.task]);
      setLastCreate({ requestId: response.request.request_id, taskId: response.task.task_id, reused: response.reused });
      setView("history");

      // 第一次权威回读；若仍为非终态，先建立订阅，再进行第二次权威回读。
      let nextTasks = await refreshTasks(response.request.request_id, epoch);
      const target = nextTasks.find(task => task.task_id === response.task.task_id) ?? response.task;
      if (!TERMINAL.has(target.status) && isCurrent(epoch)) {
        watchTasks(response.request.request_id, nextTasks.length ? nextTasks : [response.task], epoch);
        nextTasks = await refreshTasks(response.request.request_id, epoch);
        if (isCurrent(epoch)) watchTasks(response.request.request_id, nextTasks, epoch);
      } else if (isCurrent(epoch)) {
        watchTasks(response.request.request_id, nextTasks, epoch);
      }
    } catch {
      if (isCurrent(epoch)) setError(SAFE_ERROR);
    } finally {
      if (isCurrent(epoch)) setBusy(null);
    }
  };

  const actOnTask = async (task: MediaGenerationTask, action: "cancel" | "retry") => {
    const epoch = epochRef.current;
    setBusy("action");
    setError("");
    try {
      const next = action === "cancel"
        ? await window.desktop.cancelMediaGenerationTask(task.task_id)
        : await window.desktop.retryMediaGenerationTask(task.task_id);
      if (!isCurrent(epoch)) return;
      setTasks(current => upsertTask(current, next));
      const refreshed = await refreshTasks(task.request_id, epoch);
      if (isCurrent(epoch)) watchTasks(task.request_id, refreshed, epoch);
    } catch {
      if (isCurrent(epoch)) setError(SAFE_ERROR);
    } finally {
      if (isCurrent(epoch)) setBusy(null);
    }
  };

  const close = () => {
    setPrompt("");
    promptRef.current = "";
    setPrepared(undefined);
    stopRefresh();
    onClose();
  };

  const selectedRequest = requests.find(item => item.request_id === selectedRequestId);

  return <Dialog titleId="generation-workbench-title" label="生成验证" onClose={onClose} className="generation-workbench">
      <div className="modal-heading">
        <div><h2 id="generation-workbench-title">生成验证（模拟）</h2><p>验证生成请求、任务状态和恢复链路，不执行真实生成。</p></div>
        <button className="icon-btn" aria-label="关闭生成验证" onClick={close}>×</button>
      </div>
      <p className="simulation-notice">{SIMULATION_NOTICE}</p>
      <div className="generation-tabs" role="tablist" aria-label="生成验证视图">
        <button role="tab" aria-selected={view === "create"} className={view === "create" ? "active" : ""} onClick={() => setView("create")}>新建验证</button>
        <button role="tab" aria-selected={view === "history"} className={view === "history" ? "active" : ""} onClick={() => { setView("history"); void loadHistory(); }}>历史与任务</button>
      </div>
      {error && <p className="generation-safe-error" role="alert">{error}</p>}

      {view === "create" && <div className="generation-create">
        {!prepared ? <>
          <fieldset disabled={busy !== null}>
            <legend>验证类型</legend>
            <label><input type="radio" name="generation-kind" checked={kind === "image"} onChange={() => { invalidatePrepared(); setKind("image"); }} /> 图片参数验证</label>
            <label><input type="radio" name="generation-kind" checked={kind === "tts"} onChange={() => { invalidatePrepared(); setKind("tts"); }} /> TTS 参数验证</label>
          </fieldset>
          <label className="generation-field">Prompt（仅当前表单内存，1–4000 字符）
            <textarea aria-label="生成验证 Prompt" maxLength={4000} value={prompt} onChange={event => { invalidatePrepared(); setPrompt(event.target.value); }} />
          </label>
          <fieldset className="generation-assets" disabled={busy !== null}>
            <legend>输入素材引用（1–32 项，仅提交 Asset ID）</legend>
            {assets.length ? assets.map(item => <label key={item.asset.asset_id}>
              <input type="checkbox" aria-label={`引用素材 ${item.asset.display_name}`} checked={inputRefs.includes(item.asset.asset_id)} onChange={() => toggleAsset(item.asset.asset_id)} />
              <span>{item.asset.display_name}</span><small>{assetKindLabels[item.asset.kind] ?? item.asset.kind} · {assetAvailabilityLabels[item.asset.availability] ?? item.asset.availability}</small>
            </label>) : <p>当前项目没有可引用素材。</p>}
          </fieldset>
          {kind === "image" ? <div className="generation-parameters">
            <label>宽度<input aria-label="图片宽度" type="number" min={64} max={4096} value={imageForm.width} onChange={event => { invalidatePrepared(); setImageForm(value => ({ ...value, width: event.target.value })); }} /></label>
            <label>高度<input aria-label="图片高度" type="number" min={64} max={4096} value={imageForm.height} onChange={event => { invalidatePrepared(); setImageForm(value => ({ ...value, height: event.target.value })); }} /></label>
            <label>样式预设（可选）<input aria-label="样式预设" value={imageForm.stylePresetId} onChange={event => { invalidatePrepared(); setImageForm(value => ({ ...value, stylePresetId: event.target.value })); }} /></label>
            <label>Seed（可选）<input aria-label="图片 Seed" type="number" min={0} max={2_147_483_647} value={imageForm.seed} onChange={event => { invalidatePrepared(); setImageForm(value => ({ ...value, seed: event.target.value })); }} /></label>
          </div> : <div className="generation-parameters">
            <label>声音验证预设<input aria-label="声音验证预设" value={ttsForm.voicePresetId} onChange={event => { invalidatePrepared(); setTtsForm(value => ({ ...value, voicePresetId: event.target.value })); }} /></label>
            <label>语言<select aria-label="TTS 语言" value={ttsForm.language} onChange={event => { invalidatePrepared(); setTtsForm(value => ({ ...value, language: event.target.value as TtsForm["language"] })); }}><option value="zh-CN">zh-CN</option><option value="en-US">en-US</option></select></label>
            <label>速度（千分比）<input aria-label="TTS 速度" type="number" min={500} max={2000} value={ttsForm.speedMilli} onChange={event => { invalidatePrepared(); setTtsForm(value => ({ ...value, speedMilli: event.target.value })); }} /></label>
            <p className="readonly-note">以上仅为参数验证，不会合成或试听真实声音。</p>
          </div>}
          <div className="modal-actions"><button disabled={!draft || busy !== null} onClick={() => void prepare()}>{busy === "prepare" ? "准备中…" : "准备验证"}</button></div>
        </> : <div className="generation-confirm">
          <h3>确认模拟验证请求</h3>
          <p className="simulation-notice">{SIMULATION_NOTICE}</p>
          <dl>
            <dt>类型</dt><dd>{requestKindLabel(prepared.value.generation_kind)}</dd>
            <dt>执行模式</dt><dd>{prepared.value.execution_mode}</dd>
            <dt>Prompt</dt><dd>{prepared.promptCharacterCount} 字符；正文不回显</dd>
            <dt>Prompt hash</dt><dd>{prepared.value.prompt_sha256}</dd>
            <dt>素材引用</dt><dd>{prepared.value.input_refs.length} 项</dd>
            <dt>参数</dt><dd><code>{JSON.stringify(prepared.value.parameters)}</code></dd>
            <dt>Request hash</dt><dd>{prepared.value.request_sha256}</dd>
          </dl>
          <div className="modal-actions"><button disabled={busy !== null} onClick={() => setPrepared(undefined)}>返回修改</button><button disabled={busy !== null} onClick={() => void create()}>{busy === "create" ? "创建中…" : "确认并创建验证任务"}</button></div>
        </div>}
      </div>}

      {view === "history" && <div className="generation-history">
        <div className="generation-history-toolbar"><strong>请求历史</strong><button disabled={busy !== null} onClick={() => void loadHistory(true)}>刷新历史</button></div>
        <div className="generation-history-grid">
          <div className="generation-request-list" aria-label="生成验证请求列表">
            {requests.length ? requests.map(request => <button key={request.request_id} className={request.request_id === selectedRequestId ? "active" : ""} onClick={() => setSelectedRequestId(request.request_id)}>
              <strong>{requestKindLabel(request.generation_kind)}</strong><small>{request.created_at}</small><small>{request.request_sha256}</small>
            </button>) : <p>尚无模拟验证记录。</p>}
          </div>
          <div className="generation-task-list" aria-label="生成验证任务列表">
            {lastCreate && lastCreate.requestId === selectedRequestId && <p className="generation-create-result">{lastCreate.reused ? "复用既有请求与任务" : "已创建新的模拟验证任务"}</p>}
            {selectedRequest && <dl className="generation-request-summary"><dt>模式</dt><dd>{selectedRequest.execution_mode}</dd><dt>Prompt hash</dt><dd>{selectedRequest.prompt_sha256}</dd><dt>素材引用</dt><dd>{selectedRequest.input_refs.length} 项</dd></dl>}
            {tasks.length ? tasks.map(task => <article className={`generation-task status-${task.status}`} key={task.task_id}>
              <div><strong>Attempt {task.attempt}</strong><span>{statusLabels[task.status]}</span></div>
              <small>Task {task.task_id}</small>
              <small>Retry parent：{task.retry_of_task_id ?? "无"}</small>
              {task.status === "succeeded" && task.result_summary && <p className="generation-success">验证完成，未生成媒体 · Provider 调用 {task.result_summary.provider_call_count} 次</p>}
              {task.status === "failed" && <p className="generation-safe-error">任务验证失败；未生成媒体。</p>}
              <div className="generation-task-actions">
                <button disabled={busy !== null || !(task.status === "queued" || task.status === "running")} onClick={() => void actOnTask(task, "cancel")}>取消</button>
                <button disabled={busy !== null || !(task.status === "failed" || task.status === "cancelled" || task.status === "interrupted")} onClick={() => void actOnTask(task, "retry")}>重试</button>
              </div>
            </article>) : selectedRequestId ? <p>此请求暂无任务记录。</p> : <p>选择请求后查看任务。</p>}
          </div>
        </div>
        <p className="simulation-notice">{SIMULATION_NOTICE}</p>
      </div>}
    </Dialog>;
}
