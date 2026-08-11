import { useEffect, useMemo, useState, type ReactElement } from "react";
import type {
  Asset,
  AssetAvailability,
  AssetKind,
  AssetPresentation,
  Job,
  ModelDetail,
  ModelId,
  ModelSummary,
  Project,
  ProjectId,
  Transcript,
  TranscriptSummary
} from "@aivideo/contracts";

const assetKinds: AssetKind[] = ["video", "audio", "image", "text"];
const availabilityLabels: Record<AssetAvailability, string> = { available: "可用", missing: "缺失", changed: "已变更", unsupported: "不支持" };
const projectStatusLabels: Record<Project["status"], string> = { active: "活动", archived: "已归档", missing: "目录缺失" };
const modelStatusLabels: Record<ModelSummary["status"], string> = { unavailable: "未安装", queued: "排队中", downloading: "下载中", paused: "已暂停", verifying: "校验中", ready: "已就绪", cancelled: "已取消", failed: "下载失败" };
const jobStatusLabels: Record<Job["status"], string> = { queued: "排队中", running: "运行中", succeeded: "已完成", failed: "失败", cancelling: "取消中", cancelled: "已取消", interrupted: "已中断" };
const transcriptStatusLabels: Record<TranscriptSummary["status"], string> = { pending: "处理中", ready: "可查看", stale: "素材已变更，结果失效", failed: "转录失败" };
const providerStatusLabels: Record<ModelSummary["provider_status"], string> = { unavailable: "运行时不可用", installed: "运行时可用", corrupt: "运行时文件损坏", runtime_unavailable: "运行时不可用" };

function errorMessage(cause: unknown): string {
  if (cause && typeof cause === "object") {
    const value = cause as { code?: unknown; message?: unknown };
    if (typeof value.code === "string" && typeof value.message === "string") return `[${value.code}] ${value.message}`;
    if (typeof value.message === "string") return value.message;
  }
  return cause instanceof Error ? cause.message : "操作失败";
}

function errorCode(cause: unknown): string | undefined {
  return cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string" ? (cause as { code: string }).code : undefined;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1048576).toFixed(1)} MB`;
  return `${(value / 1073741824).toFixed(1)} GB`;
}

function formatDuration(value: number): string {
  const seconds = Math.floor(value / 1_000_000);
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function jobLabel(job: Job): string {
  if (job.kind === "asset_probe") return "素材探测";
  if (job.kind === "asset_fingerprint") return "素材指纹";
  if (job.kind === "proxy") return "代理素材";
  if (job.kind === "portrait_sample" || job.kind === "vertical_sample") return "竖屏样片";
  if (job.kind === "model_download") return "模型下载";
  if (job.kind === "transcription") return "本地转录";
  return "未知任务";
}

function modelStatusClass(status: ModelSummary["status"]): string { return `model-status ${status}`; }
function isTranscribable(asset: Asset): boolean { return (asset.kind === "video" || asset.kind === "audio") && asset.availability === "available"; }

export function App(): ReactElement {
  const [status, setStatus] = useState("连接中");
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId>();
  const [assets, setAssets] = useState<AssetPresentation[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [modelDetails, setModelDetails] = useState<Record<string, ModelDetail>>({});
  const [modelJobs, setModelJobs] = useState<Record<string, Job | null>>({});
  const [confirmModel, setConfirmModel] = useState<ModelDetail>();
  const [licenseAccepted, setLicenseAccepted] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<ModelId>();
  const [transcripts, setTranscripts] = useState<Record<string, TranscriptSummary[]>>({});
  const [viewingTranscript, setViewingTranscript] = useState<Transcript>();
  const [transcriptionAsset, setTranscriptionAsset] = useState<Asset>();
  const [language, setLanguage] = useState("auto");
  const [wordTimestamps, setWordTimestamps] = useState(true);
  const [projectName, setProjectName] = useState("");
  const [rename, setRename] = useState("");
  const [availability, setAvailability] = useState<AssetAvailability | "all">("all");
  const [error, setError] = useState<string>();
  const [modelError, setModelError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  const selectedProject = useMemo(() => projects.find(project => project.project_id === selectedProjectId), [projects, selectedProjectId]);
  const canEdit = selectedProject?.status === "active";
  const hasInterruptedJob = jobs.some(job => job.status === "interrupted");
  const selectedModel = models.find(model => model.model_id === selectedModelId) ?? models[0];
  const readyModels = models.filter(model => model.status === "ready" && model.provider_status === "installed");

  async function loadModels(): Promise<void> {
    try {
      const page = await window.desktop.listModels({ limit: 100 });
      setModels(page.items);
      setSelectedModelId(current => current && page.items.some(item => item.model_id === current) ? current : page.items[0]?.model_id);
      setModelError(undefined);
    } catch (cause) {
      setModels([]);
      setModelError(errorCode(cause) === "NOT_FOUND" ? "当前 Core 尚未提供本地模型目录" : errorMessage(cause));
    }
  }

  async function loadProjects(selectFirst = false): Promise<void> {
    const page = await window.desktop.listProjects({ limit: 100 });
    setProjects(page.items);
    if (selectFirst || !selectedProjectId || !page.items.some(project => project.project_id === selectedProjectId)) {
      const next = page.items.find(project => project.status === "active") ?? page.items[0];
      setSelectedProjectId(next?.project_id);
      setRename(next?.name ?? "");
    }
  }

  async function loadWorkspace(projectId = selectedProjectId): Promise<void> {
    if (!projectId) { setAssets([]); setJobs([]); return; }
    const [assetPage, jobPage] = await Promise.all([
      window.desktop.listAssets({ project_id: projectId, ...(availability !== "all" ? { availability } : {}), limit: 100 }),
      window.desktop.listJobs({ project_id: projectId, limit: 100 })
    ]);
    setAssets(assetPage.items);
    setJobs(jobPage.items);
    const assetTranscriptEntries = await Promise.all(assetPage.items.filter(item => isTranscribable(item.asset)).map(async item => {
      try { return [item.asset.asset_id, (await window.desktop.listTranscripts(item.asset.asset_id)).items] as const; } catch { return [item.asset.asset_id, []] as const; }
    }));
    setTranscripts(Object.fromEntries(assetTranscriptEntries));
  }

  useEffect(() => {
    let mounted = true;
    void window.desktop.getRuntime().then(async () => {
      if (!mounted) return;
      setStatus("Core 已连接");
      await loadProjects(true);
      await loadModels();
    }).catch(cause => { if (mounted) { setStatus("Core 连接失败"); setError(errorMessage(cause)); } });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    setRename(selectedProject?.name ?? "");
    void loadWorkspace().catch(cause => setError(errorMessage(cause)));
  }, [selectedProjectId, availability]);

  useEffect(() => {
    // Keep the project list fresh so projects created outside the UI (e.g. a
    // second session or the real E2E harness) appear without a reload. When no
    // project is selected, loadProjects(true) auto-selects the first active one,
    // which then triggers the workspace load via the selectedProjectId effect.
    const timer = setInterval(() => {
      void loadProjects(!selectedProjectId).catch(() => undefined);
      if (selectedProjectId) void loadWorkspace(selectedProjectId).catch(() => undefined);
    }, 1500);
    return () => clearInterval(timer);
  }, [selectedProjectId]);

  useEffect(() => {
    if (models.length === 0) return;
    const timer = setInterval(() => {
      void Promise.all(models.filter(model => ["queued", "downloading", "paused", "verifying"].includes(model.status)).map(async model => {
        try {
          const result = await window.desktop.getModelDownload(model.model_id);
          setModels(current => current.map(item => item.model_id === model.model_id ? result.model : item));
          setModelDetails(current => ({ ...current, [model.model_id]: result.model }));
          setModelJobs(current => ({ ...current, [model.model_id]: result.job }));
        } catch { /* the next poll remains the source of truth */ }
      }));
    }, 1000);
    return () => clearInterval(timer);
  }, [models]);

  async function run(label: string, action: () => Promise<void>): Promise<void> {
    setError(undefined);
    setBusy(label);
    try { await action(); } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(undefined); }
  }

  async function openDownloadConfirmation(model: ModelSummary): Promise<void> {
    await run("model-detail", async () => {
      const detail = modelDetails[model.model_id] ?? await window.desktop.getModel(model.model_id);
      setModelDetails(current => ({ ...current, [model.model_id]: detail }));
      setConfirmModel(detail);
      setLicenseAccepted(!detail.license.acceptance_required);
    });
  }

  async function confirmDownload(): Promise<void> {
    if (!confirmModel || (confirmModel.license.acceptance_required && !licenseAccepted)) return;
    await run("model-download", async () => {
      const result = await window.desktop.downloadModel({ model_id: confirmModel.model_id, license_acceptance: confirmModel.license.acceptance_required ? confirmModel.license.id : null });
      setModels(current => current.map(model => model.model_id === result.model.model_id ? result.model : model));
      setModelDetails(current => ({ ...current, [result.model.model_id]: result.model }));
      setModelJobs(current => ({ ...current, [result.model.model_id]: result.job }));
      setConfirmModel(undefined);
    });
  }

  async function cancelModelDownload(model: ModelSummary): Promise<void> {
    await run(`model-cancel-${model.model_id}`, async () => {
      const result = await window.desktop.cancelModelDownload(model.model_id);
      setModels(current => current.map(item => item.model_id === model.model_id ? result.model : item));
      setModelJobs(current => ({ ...current, [model.model_id]: result.job }));
    });
  }

  async function createProject(): Promise<void> {
    const name = projectName.trim();
    if (!name) return;
    await run("create-project", async () => { const created = await window.desktop.createProject({ name }); setProjectName(""); await loadProjects(); setSelectedProjectId(created.project_id); });
  }

  async function renameProject(): Promise<void> {
    if (!selectedProjectId || !rename.trim()) return;
    await run("rename-project", async () => { const updated = await window.desktop.renameProject({ project_id: selectedProjectId, name: rename.trim() }); setProjects(current => current.map(project => project.project_id === updated.project_id ? updated : project)); });
  }

  async function archiveOrReopen(): Promise<void> {
    if (!selectedProject) return;
    await run("project-status", async () => {
      const updated = selectedProject.status === "archived" ? await window.desktop.reopenProject(selectedProject.project_id) : await window.desktop.archiveProject(selectedProject.project_id);
      setProjects(current => current.map(project => project.project_id === updated.project_id ? updated : project));
    });
  }

  async function importAsset(kind: AssetKind): Promise<void> {
    if (!selectedProjectId || !canEdit) return;
    await run(`import-${kind}`, async () => { const result = await window.desktop.importAsset({ project_id: selectedProjectId, kind }); if (result) setAssets(current => [{ asset: result.asset, media_url: result.media_url }, ...current.filter(item => item.asset.asset_id !== result.asset.asset_id)]); });
  }

  async function refreshAsset(asset: Asset): Promise<void> { await run(`refresh-${asset.asset_id}`, async () => { const result = await window.desktop.refreshAsset(asset.asset_id); setAssets(current => current.map(item => item.asset.asset_id === result.asset.asset_id ? result : item)); }); }
  async function relocateAsset(asset: Asset): Promise<void> { await run(`relocate-${asset.asset_id}`, async () => { const result = await window.desktop.relocateAsset({ asset_id: asset.asset_id }); if (result) setAssets(current => current.map(item => item.asset.asset_id === result.asset.asset_id ? { asset: result.asset, media_url: result.media_url } : item)); }); }
  async function cancelJob(job: Job): Promise<void> { await run(`cancel-${job.job_id}`, async () => { const updated = await window.desktop.cancelJob(job.job_id); setJobs(current => current.map(item => item.job_id === updated.job_id ? updated : item)); }); }

  async function retryTranscription(job: Job): Promise<void> {
    if (!job.asset_id || !job.model_id) return;
    const asset = assets.find(item => item.asset.asset_id === job.asset_id)?.asset;
    if (!asset) return;
    await run(`retry-${job.job_id}`, async () => {
      const result = await window.desktop.createTranscription({ asset_id: asset.asset_id, model_id: job.model_id!, language: "auto", word_timestamps: true, license_acceptance: null });
      setJobs(current => [result.job, ...current.filter(item => item.job_id !== result.job.job_id)]);
    });
  }

  async function startTranscription(asset: Asset): Promise<void> {
    if (!selectedModel) { setModelError("当前没有可用的本地 ASR 模型"); return; }
    if (selectedModel.status !== "ready") { await openDownloadConfirmation(selectedModel); return; }
    if (selectedModel.provider_status !== "installed") { setModelError(`${selectedModel.display_name}: ${providerStatusLabels[selectedModel.provider_status]}`); return; }
    setTranscriptionAsset(asset);
  }

  async function submitTranscription(): Promise<void> {
    if (!transcriptionAsset || !selectedModel) return;
    await run(`transcribe-${transcriptionAsset.asset_id}`, async () => {
      const result = await window.desktop.createTranscription({ asset_id: transcriptionAsset.asset_id, model_id: selectedModel.model_id, language, word_timestamps: wordTimestamps, license_acceptance: null });
      setJobs(current => [result.job, ...current.filter(item => item.job_id !== result.job.job_id)]);
      setTranscriptionAsset(undefined);
      await loadWorkspace();
    });
  }

  async function viewTranscript(summary: TranscriptSummary): Promise<void> {
    await run(`transcript-${summary.transcript_id}`, async () => setViewingTranscript(await window.desktop.getTranscript(summary.transcript_id)));
  }

  return <main className="workspace">
    <header className="topbar"><div className="brand"><span className="brand-mark">AI</span><strong>AIVideo Studio</strong><span className="stage-label">Stage 1B</span></div><div className="status"><span className="status-dot" />{status}</div></header>
    <section className="content">
      <div className="intro"><div><p className="eyebrow">LOCAL ASR WORKSPACE</p><h1>素材工作区</h1><p className="subhead">项目、外部素材、模型和本地转录结果均在本地 Core 中管理。</p><span className="workspace-capability">本地转录</span></div><div className="protocol"><span>契约</span><strong>stage1b-v1</strong></div></div>
      <div className="workspace-grid">
        <aside className="sidebar panel"><div className="panel-heading"><h2>项目</h2><span className="count">{projects.length}</span></div><div className="project-create"><input aria-label="项目名称" placeholder="新项目名称" value={projectName} onChange={event => setProjectName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void createProject(); }} /><button className="primary" disabled={!projectName.trim() || busy !== undefined} onClick={() => void createProject()}>创建</button></div><div className="project-list">{projects.map(project => <button key={project.project_id} className={`project-item ${project.project_id === selectedProjectId ? "selected" : ""}`} onClick={() => setSelectedProjectId(project.project_id)}><span><strong>{project.name}</strong><small>{projectStatusLabels[project.status]}</small></span><span className={`status-chip ${project.status}`}>{project.status === "active" ? "" : "!"}</span></button>)}{projects.length === 0 && <div className="empty compact"><span>+</span><p>创建第一个项目</p></div>}</div></aside>
        <section className="main-column">
          {selectedProject ? <>
            <section className="panel project-header"><div><p className="eyebrow">当前项目</p><h2>{selectedProject.name}</h2><span className={`project-state ${selectedProject.status}`}>{projectStatusLabels[selectedProject.status]}</span></div><div className="project-actions"><input aria-label="重命名项目" value={rename} onChange={event => setRename(event.target.value)} /><button disabled={!rename.trim() || rename.trim() === selectedProject.name || busy !== undefined} onClick={() => void renameProject()}>重命名</button><button className="quiet" disabled={busy !== undefined} onClick={() => void archiveOrReopen()}>{selectedProject.status === "archived" ? "重新打开" : "归档"}</button></div></section>
            <section className="panel model-panel"><div className="panel-heading"><div><h2>本地转录模型</h2><small>模型权重只在用户确认后下载，不上传素材或转录正文。</small></div><span className="count">{models.length}</span></div>{modelError && <div className="notice">{modelError}</div>}{models.map(model => <div className="model-row" key={model.model_id}><div className="model-main"><strong>{model.display_name}</strong><span className={modelStatusClass(model.status)}>{modelStatusLabels[model.status]}</span><small>{model.provider} · revision {model.revision} · {model.supported_languages.join("、")}</small><small>{model.requires_network ? "下载需要网络，转录时不上传媒体" : "下载无需网络，转录完全本地"} · {model.license.name}</small></div><div className="model-meta"><span>{formatBytes(model.model_size_bytes)} 下载</span><span>{formatBytes(model.installed_size_bytes)} 安装后</span><span>{formatBytes(model.required_disk_bytes)} 所需磁盘</span></div><div className="model-actions">{["queued", "downloading", "verifying", "paused"].includes(model.status) && <div className="progress-wrap"><progress max="1" value={model.progress ?? 0} /><small>{model.progress === null ? "处理中" : `${Math.round(model.progress * 100)}%`}</small></div>}{["unavailable", "failed", "cancelled"].includes(model.status) && <button disabled={busy !== undefined} onClick={() => void openDownloadConfirmation(model)}>{model.status === "failed" ? "重试下载" : "下载模型"}</button>}{model.status === "paused" && <button disabled={busy !== undefined} onClick={() => void openDownloadConfirmation(model)}>继续下载</button>}{["queued", "downloading", "verifying", "paused"].includes(model.status) && <button className="quiet" disabled={busy !== undefined} onClick={() => void cancelModelDownload(model)}>取消</button>}</div></div>)}{models.length === 0 && <div className="empty compact"><span>○</span><p>暂无可用模型</p></div>}</section>
            <section className="panel"><div className="panel-heading"><div><h2>素材库</h2><small>{assets.length} 项外部素材</small></div><div className="toolbar"><select aria-label="可用性筛选" value={availability} onChange={event => setAvailability(event.target.value as AssetAvailability | "all")}><option value="all">全部状态</option>{Object.keys(availabilityLabels).map(value => <option key={value} value={value}>{availabilityLabels[value as AssetAvailability]}</option>)}</select>{assetKinds.map(kind => <button key={kind} disabled={!canEdit || busy !== undefined} onClick={() => void importAsset(kind)}>导入{kind}</button>)}</div></div><div className="asset-table"><div className="table-head"><span>名称</span><span>类型</span><span>状态</span><span>大小</span><span>操作</span></div>{assets.map(({ asset, media_url }) => <div className="asset-row" key={asset.asset_id}><div className="asset-name"><span className={`kind-icon ${asset.kind}`}>{asset.kind.slice(0, 1).toUpperCase()}</span><div><strong>{asset.display_name}</strong><small>{media_url ?? "受限媒体 URL 不可用"}</small></div></div><span>{asset.kind}</span><span className={`availability ${asset.availability}`}>{availabilityLabels[asset.availability]}</span><span>{formatBytes(asset.size_bytes)}</span><div className="row-actions"><button disabled={busy !== undefined} onClick={() => void refreshAsset(asset)}>刷新</button><button disabled={busy !== undefined} onClick={() => void relocateAsset(asset)}>重新定位</button>{isTranscribable(asset) && <button data-testid={`transcribe-${asset.asset_id}`} disabled={busy !== undefined} onClick={() => void startTranscription(asset)}>转录</button>}</div></div>)}{assets.length === 0 && <div className="empty"><span>○</span><p>素材库为空</p></div>}</div></section>
            <section className="panel transcript-panel"><div className="panel-heading"><div><h2>原始转录</h2><small>只读保存，绑定素材 fingerprint，不覆盖原始记录。</small></div></div>{assets.filter(item => isTranscribable(item.asset)).map(item => <div className="transcript-row" key={item.asset.asset_id} data-asset-id={item.asset.asset_id}><strong>{item.asset.display_name}</strong><span>{transcripts[item.asset.asset_id]?.length ?? 0} 条记录</span><div>{(transcripts[item.asset.asset_id] ?? []).map(summary => <button key={summary.transcript_id} data-transcript-id={summary.transcript_id} aria-label={`查看转录 ${summary.transcript_id}`} className="quiet" onClick={() => void viewTranscript(summary)}>{summary.language} · {transcriptStatusLabels[summary.status]} · {formatDuration(summary.duration_us)}</button>)}</div></div>)}{assets.filter(item => isTranscribable(item.asset)).length === 0 && <div className="empty compact"><span>○</span><p>导入视频或音频后可创建本地转录</p></div>}</section>
            <section className="panel jobs-panel"><div className="panel-heading"><div><h2>任务</h2><small>状态、阶段、失败原因和恢复入口</small></div><span className="count">{jobs.length}</span></div>{hasInterruptedJob && <div className="recovery-banner"><strong>检测到可恢复任务</strong><span>Core 重启前有任务未完成，状态已恢复为 interrupted。</span></div>}<div className="job-list">{jobs.map(job => <div className="job-row" key={job.job_id}><div className="job-main"><strong>{jobLabel(job)}</strong><span className={`job-status ${job.status}`}>{jobStatusLabels[job.status]}</span><small>{job.stage} · {job.progress === null ? "处理中" : `${Math.round(job.progress * 100)}%`}</small>{job.error && <small className="job-error">{job.error.message}</small>}</div><div className="row-actions">{job.kind === "transcription" && ["failed", "interrupted"].includes(job.status) && <button onClick={() => void retryTranscription(job)}>重试转录</button>}{["queued", "running", "cancelling"].includes(job.status) && <button className="quiet" disabled={busy !== undefined} onClick={() => void cancelJob(job)}>取消</button>}</div></div>)}{jobs.length === 0 && <div className="empty compact"><span>○</span><p>暂无任务</p></div>}</div></section>
          </> : <section className="panel empty-state"><span>＋</span><h2>创建一个项目开始工作</h2><p>项目状态和外部素材会在本地 Core 中持久化。</p></section>}
        </section>
      </div>
      {error && <div className="error-banner" role="alert">{error}</div>}
    </section>
    {confirmModel && <div className="modal-backdrop"><section className="modal" data-testid="model-download-confirmation" role="dialog" aria-modal="true" aria-labelledby="model-confirm-title"><div className="modal-heading"><h2 id="model-confirm-title">确认下载本地模型</h2><button className="icon-button" aria-label="关闭" onClick={() => setConfirmModel(undefined)}>×</button></div><h3>{confirmModel.display_name}</h3><p>{confirmModel.purpose}</p><dl className="detail-list"><div><dt>隐私</dt><dd>模型在本机运行，不上传媒体或转录正文。</dd></div><div><dt>下载大小</dt><dd>{formatBytes(confirmModel.model_size_bytes)}</dd></div><div><dt>所需磁盘</dt><dd>{formatBytes(confirmModel.required_disk_bytes)}{confirmModel.available_disk_bytes === null ? "" : `，当前可用 ${formatBytes(confirmModel.available_disk_bytes)}`}</dd></div><div><dt>来源</dt><dd>{confirmModel.source.display_name}{confirmModel.source.host ? `（${confirmModel.source.host}）` : ""}</dd></div><div><dt>许可证</dt><dd>{confirmModel.license.name}{confirmModel.license.url ? ` · ${confirmModel.license.url}` : ""}</dd></div><div><dt>网络</dt><dd>{confirmModel.requires_network ? "下载需要网络，转录不需要网络" : "不需要网络"}</dd></div></dl>{confirmModel.license.acceptance_required && <label className="license-check"><input type="checkbox" checked={licenseAccepted} onChange={event => setLicenseAccepted(event.target.checked)} />我已阅读并接受该许可证</label>}<div className="modal-actions"><button data-testid="model-download-reject" className="quiet" onClick={() => setConfirmModel(undefined)}>暂不下载</button><button className="primary" disabled={confirmModel.license.acceptance_required && !licenseAccepted || busy !== undefined} onClick={() => void confirmDownload()}>确认并下载</button></div></section></div>}
    {transcriptionAsset && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="transcription-title"><div className="modal-heading"><h2 id="transcription-title">创建本地转录</h2><button className="icon-button" aria-label="关闭" onClick={() => setTranscriptionAsset(undefined)}>×</button></div><p>{transcriptionAsset.display_name}</p><label>语言<select value={language} onChange={event => setLanguage(event.target.value)}><option value="auto">自动检测</option>{(selectedModel?.supported_languages ?? []).map(item => <option key={item} value={item}>{item}</option>)}</select></label><label className="license-check"><input type="checkbox" checked={wordTimestamps} onChange={event => setWordTimestamps(event.target.checked)} />生成词级时间戳</label><div className="modal-actions"><button className="quiet" onClick={() => setTranscriptionAsset(undefined)}>取消</button><button className="primary" disabled={busy !== undefined} onClick={() => void submitTranscription()}>开始转录</button></div></section></div>}
    {viewingTranscript && <div className="modal-backdrop"><section className="modal transcript-viewer" data-testid="transcript-viewer" role="dialog" aria-modal="true" aria-labelledby="transcript-title"><div className="modal-heading"><div><h2 id="transcript-title">原始转录</h2><small>{viewingTranscript.language} · {viewingTranscript.provider} · {viewingTranscript.model_revision}</small></div><button className="icon-button" aria-label="关闭" onClick={() => setViewingTranscript(undefined)}>×</button></div><div className="readonly-note">原始 ASR 结果只读。字幕修订不会覆盖这份记录。</div><div className="segment-list">{viewingTranscript.segments.map(segment => <div className="segment" key={segment.segment_id}><span>{formatDuration(segment.start_us)} - {formatDuration(segment.end_us)}</span><p>{segment.text}</p>{segment.words && <small>{segment.words.map(word => word.text).join(" ")}</small>}</div>)}</div></section></div>}
  </main>;
}
