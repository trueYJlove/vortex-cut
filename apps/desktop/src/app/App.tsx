import { useEffect, useMemo, useState, type ReactElement } from "react";
import type { Asset, AssetAvailability, AssetKind, AssetPresentation, Job, Project, ProjectId } from "@aivideo/contracts";

const assetKinds: AssetKind[] = ["video", "audio", "image", "text"];
const availabilityLabels: Record<AssetAvailability, string> = {
  available: "可用",
  missing: "缺失",
  changed: "已变更",
  unsupported: "不支持"
};
const projectStatusLabels: Record<Project["status"], string> = { active: "活动", archived: "已归档", missing: "目录缺失" };

function errorMessage(cause: unknown): string {
  if (cause && typeof cause === "object") {
    const value = cause as { code?: unknown; message?: unknown };
    if (typeof value.code === "string" && typeof value.message === "string") return `[${value.code}] ${value.message}`;
    if (typeof value.message === "string") return value.message;
  }
  return cause instanceof Error ? cause.message : "操作失败";
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1048576).toFixed(1)} MB`;
  return `${(value / 1073741824).toFixed(1)} GB`;
}

function jobLabel(job: Job): string {
  if (job.kind === "asset_probe") return "素材探测";
  if (job.kind === "asset_fingerprint") return "素材指纹";
  if (job.kind === "proxy") return "代理素材";
  return job.kind;
}

export function App(): ReactElement {
  const [status, setStatus] = useState("连接中");
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId>();
  const [assets, setAssets] = useState<AssetPresentation[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [projectName, setProjectName] = useState("");
  const [rename, setRename] = useState("");
  const [availability, setAvailability] = useState<AssetAvailability | "all">("all");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  const selectedProject = useMemo(() => projects.find(project => project.project_id === selectedProjectId), [projects, selectedProjectId]);
  const canEdit = selectedProject?.status === "active";
  const hasInterruptedJob = jobs.some(job => job.status === "interrupted");

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
  }

  useEffect(() => {
    let mounted = true;
    void window.desktop.getRuntime().then(() => {
      if (!mounted) return;
      setStatus("Core 已连接");
      return loadProjects(true);
    }).catch(cause => { if (mounted) { setStatus("Core 连接失败"); setError(errorMessage(cause)); } });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    setRename(selectedProject?.name ?? "");
    void loadWorkspace().catch(cause => setError(errorMessage(cause)));
  }, [selectedProjectId, availability]);

  useEffect(() => {
    if (!selectedProjectId) return;
    const timer = setInterval(() => { void window.desktop.listJobs({ project_id: selectedProjectId, limit: 100 }).then(page => setJobs(page.items)).catch(() => undefined); }, 1500);
    return () => clearInterval(timer);
  }, [selectedProjectId]);

  async function run(label: string, action: () => Promise<void>): Promise<void> {
    setError(undefined);
    setBusy(label);
    try { await action(); } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(undefined); }
  }

  async function createProject(): Promise<void> {
    const name = projectName.trim();
    if (!name) return;
    await run("create-project", async () => {
      const created = await window.desktop.createProject({ name });
      setProjectName("");
      await loadProjects();
      setSelectedProjectId(created.project_id);
    });
  }

  async function renameProject(): Promise<void> {
    if (!selectedProjectId || !rename.trim()) return;
    await run("rename-project", async () => {
      const updated = await window.desktop.renameProject({ project_id: selectedProjectId, name: rename.trim() });
      setProjects(current => current.map(project => project.project_id === updated.project_id ? updated : project));
    });
  }

  async function archiveOrReopen(): Promise<void> {
    if (!selectedProject) return;
    await run("project-status", async () => {
      const updated = selectedProject.status === "archived"
        ? await window.desktop.reopenProject(selectedProject.project_id)
        : await window.desktop.archiveProject(selectedProject.project_id);
      setProjects(current => current.map(project => project.project_id === updated.project_id ? updated : project));
    });
  }

  async function importAsset(kind: AssetKind): Promise<void> {
    if (!selectedProjectId || !canEdit) return;
    await run(`import-${kind}`, async () => {
      const result = await window.desktop.importAsset({ project_id: selectedProjectId, kind });
      if (!result) return;
      setAssets(current => [{ asset: result.asset, media_url: result.media_url }, ...current.filter(item => item.asset.asset_id !== result.asset.asset_id)]);
    });
  }

  async function refreshAsset(asset: Asset): Promise<void> {
    await run(`refresh-${asset.asset_id}`, async () => {
      const result = await window.desktop.refreshAsset(asset.asset_id);
      setAssets(current => current.map(item => item.asset.asset_id === result.asset.asset_id ? result : item));
    });
  }

  async function relocateAsset(asset: Asset): Promise<void> {
    await run(`relocate-${asset.asset_id}`, async () => {
      const result = await window.desktop.relocateAsset({ asset_id: asset.asset_id });
      if (result) setAssets(current => current.map(item => item.asset.asset_id === result.asset.asset_id ? { asset: result.asset, media_url: result.media_url } : item));
    });
  }

  async function cancelJob(job: Job): Promise<void> {
    await run(`cancel-${job.job_id}`, async () => {
      const updated = await window.desktop.cancelJob(job.job_id);
      setJobs(current => current.map(item => item.job_id === updated.job_id ? updated : item));
    });
  }

  return <main className="workspace">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">AI</span><strong>AIVideo Studio</strong><span className="stage-label">Stage 1A</span></div>
      <div className="status"><span className="status-dot" />{status}</div>
    </header>
    <section className="content">
      <div className="intro">
        <div><p className="eyebrow">PROJECT WORKSPACE</p><h1>素材工作区</h1><p className="subhead">项目、外部素材和可恢复任务集中管理。</p></div>
        <div className="protocol"><span>契约</span><strong>stage1a-v1</strong></div>
      </div>
      <div className="workspace-grid">
        <aside className="sidebar panel">
          <div className="panel-heading"><h2>项目</h2><span className="count">{projects.length}</span></div>
          <div className="project-create"><input aria-label="项目名称" placeholder="新项目名称" value={projectName} onChange={event => setProjectName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void createProject(); }} /><button className="primary" disabled={!projectName.trim() || busy !== undefined} onClick={() => void createProject()}>创建</button></div>
          <div className="project-list">{projects.map(project => <button key={project.project_id} className={`project-item ${project.project_id === selectedProjectId ? "selected" : ""}`} onClick={() => setSelectedProjectId(project.project_id)}><span><strong>{project.name}</strong><small>{projectStatusLabels[project.status]}</small></span><span className={`status-chip ${project.status}`}>{project.status === "active" ? "" : "!"}</span></button>)}{projects.length === 0 && <div className="empty compact"><span>+</span><p>创建第一个项目</p></div>}</div>
        </aside>
        <section className="main-column">
          {selectedProject ? <>
            <section className="panel project-header">
              <div><p className="eyebrow">当前项目</p><h2>{selectedProject.name}</h2><span className={`project-state ${selectedProject.status}`}>{projectStatusLabels[selectedProject.status]}</span></div>
              <div className="project-actions"><input aria-label="重命名项目" value={rename} onChange={event => setRename(event.target.value)} /><button disabled={!rename.trim() || rename.trim() === selectedProject.name || busy !== undefined} onClick={() => void renameProject()}>重命名</button><button className="quiet" disabled={busy !== undefined} onClick={() => void archiveOrReopen()}>{selectedProject.status === "archived" ? "重新打开" : "归档"}</button></div>
            </section>
            <section className="panel">
              <div className="panel-heading"><div><h2>素材库</h2><small>{assets.length} 项外部素材</small></div><div className="toolbar"><select aria-label="可用性筛选" value={availability} onChange={event => setAvailability(event.target.value as AssetAvailability | "all")}><option value="all">全部状态</option>{Object.keys(availabilityLabels).map(value => <option key={value} value={value}>{availabilityLabels[value as AssetAvailability]}</option>)}</select>{assetKinds.map(kind => <button key={kind} disabled={!canEdit || busy !== undefined} onClick={() => void importAsset(kind)}>导入{kind}</button>)}</div></div>
              <div className="asset-table"><div className="table-head"><span>名称</span><span>类型</span><span>状态</span><span>大小</span><span>操作</span></div>{assets.map(({ asset, media_url }) => <div className="asset-row" key={asset.asset_id}><div className="asset-name"><span className={`kind-icon ${asset.kind}`}>{asset.kind.slice(0, 1).toUpperCase()}</span><div><strong>{asset.display_name}</strong><small>{media_url ?? "受限媒体 URL 不可用"}</small></div></div><span>{asset.kind}</span><span className={`availability ${asset.availability}`}>{availabilityLabels[asset.availability]}</span><span>{formatBytes(asset.size_bytes)}</span><div className="row-actions"><button disabled={busy !== undefined} onClick={() => void refreshAsset(asset)}>刷新</button><button disabled={busy !== undefined} onClick={() => void relocateAsset(asset)}>重新定位</button></div></div>)}{assets.length === 0 && <div className="empty"><span>○</span><p>素材库为空</p></div>}</div>
            </section>
            <section className="panel jobs-panel">
              <div className="panel-heading"><div><h2>任务</h2><small>持久化状态自动刷新</small></div><span className="count">{jobs.length}</span></div>
              {hasInterruptedJob && <div className="recovery-banner"><strong>检测到可恢复任务</strong><span>Core 重启前有任务未完成，状态已恢复为 interrupted。</span></div>}
              <div className="job-list">{jobs.map(job => <div className="job-row" key={job.job_id}><div className="job-main"><strong>{jobLabel(job)}</strong><span className={`job-status ${job.status}`}>{job.status}</span><small>{job.stage} · {job.progress === null ? "处理中" : `${Math.round(job.progress * 100)}%`}</small></div>{["queued", "running", "cancelling"].includes(job.status) && <button className="quiet" disabled={busy !== undefined} onClick={() => void cancelJob(job)}>取消</button>}</div>)}{jobs.length === 0 && <div className="empty compact"><span>○</span><p>暂无任务</p></div>}</div>
            </section>
          </> : <section className="panel empty-state"><span>＋</span><h2>创建一个项目开始工作</h2><p>项目状态和外部素材会在本地 Core 中持久化。</p></section>}
        </section>
      </div>
      {error && <div className="error-banner" role="alert">{error}</div>}
    </section>
  </main>;
}
