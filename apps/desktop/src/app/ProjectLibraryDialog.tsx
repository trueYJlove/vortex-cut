import { useEffect, useMemo, useState } from "react";
import { Archive, Check, Clock3, Film, FolderPlus, LayoutGrid, List, Pencil, Plus, RefreshCw, RotateCcw, Save, Search, X } from "lucide-react";
import type { Project } from "@aivideo/contracts";
import { Dialog } from "./Dialog.js";

type ProjectStatusFilter = "all" | Project["status"];
type ProjectSort = "recent" | "updated" | "name";

function readProjectPreference<T extends string>(key: string, fallback: T, options: readonly T[]): T {
  try {
    const saved = window.localStorage.getItem(`vortex-cut.projects.${key}.v1`);
    return options.find(option => option === saved) ?? fallback;
  } catch { return fallback; }
}

function formatProjectTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function ratioLabel(project: Project): string {
  const ratio = project.canvas.width / Math.max(1, project.canvas.height);
  for (const [value, label] of [[16 / 9, "16:9"], [9 / 16, "9:16"], [1, "1:1"], [4 / 3, "4:3"], [3 / 4, "3:4"]] as const) {
    if (Math.abs(ratio - value) < 0.015) return label;
  }
  return `${project.canvas.width} × ${project.canvas.height}`;
}

function projectStatus(project: Project): string {
  return project.status === "active" ? "本地项目" : project.status === "archived" ? "已归档" : "目录缺失";
}

export function ProjectLibraryDialog({
  projects,
  activeProjectId,
  newProject,
  newProjectRatio,
  creating,
  refreshing,
  onNewProjectChange,
  onNewProjectRatioChange,
  onCreateProject,
  onRefresh,
  onOpen,
  onRename,
  onToggleArchive,
  onClose,
}: {
  projects: Project[];
  activeProjectId?: Project["project_id"];
  newProject: string;
  newProjectRatio: string;
  creating: boolean;
  refreshing: boolean;
  onNewProjectChange: (name: string) => void;
  onNewProjectRatioChange: (ratio: string) => void;
  onCreateProject: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onOpen: (project: Project) => void;
  onRename: (project: Project, name: string) => Promise<void>;
  onToggleArchive: (project: Project) => Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ProjectStatusFilter>(() => readProjectPreference("status", "all", ["all", "active", "archived", "missing"]));
  const [sort, setSort] = useState<ProjectSort>(() => readProjectPreference("sort", "recent", ["recent", "updated", "name"]));
  const [reversed, setReversed] = useState(() => readProjectPreference("reversed", "false", ["true", "false"]) === "true");
  const [view, setView] = useState<"grid" | "list">(() => readProjectPreference("view", "grid", ["grid", "list"]));
  const [renamingId, setRenamingId] = useState<Project["project_id"] | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    try {
      window.localStorage.setItem("vortex-cut.projects.status.v1", statusFilter);
      window.localStorage.setItem("vortex-cut.projects.sort.v1", sort);
      window.localStorage.setItem("vortex-cut.projects.reversed.v1", String(reversed));
      window.localStorage.setItem("vortex-cut.projects.view.v1", view);
    } catch { /* Project view preferences are optional. */ }
  }, [statusFilter, sort, reversed, view]);

  const visibleProjects = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const filtered = projects.filter(project =>
      (statusFilter === "all" || project.status === statusFilter) &&
      (!needle || `${project.name} ${project.root_dir_name}`.toLocaleLowerCase().includes(needle)),
    );
    const sorted = [...filtered].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name, "zh-CN");
      const aValue = Date.parse(sort === "recent" ? a.last_opened_at : a.updated_at) || 0;
      const bValue = Date.parse(sort === "recent" ? b.last_opened_at : b.updated_at) || 0;
      return bValue - aValue || a.name.localeCompare(b.name, "zh-CN");
    });
    return reversed ? sorted.reverse() : sorted;
  }, [projects, query, statusFilter, sort, reversed]);

  const runProjectAction = async (key: string, action: () => Promise<void>) => {
    setBusyKey(key);
    setError("");
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "操作未完成，请重试。"); }
    finally { setBusyKey(null); }
  };

  const beginRename = (project: Project) => {
    setError("");
    setRenamingId(project.project_id);
    setRenameValue(project.name);
  };

  return <Dialog
    titleId="project-management-title"
    closeLabel="关闭项目管理"
    title="项目管理"
    subtitle="浏览最近项目，搜索、切换和整理本机项目。"
    label="项目管理"
    onClose={onClose}
    className="project-management-modal project-library-modal"
    bodyClassName="project-library-body"
  >
    <section className="project-library-create" aria-labelledby="project-create-title">
      <div className="project-library-create-copy">
        <span className="project-library-kicker">新建剪辑</span>
        <h3 id="project-create-title">开始一个新项目</h3>
        <p>设置项目名称与画布比例，创建后会直接打开工作区。</p>
      </div>
      <div className="project-library-create-form">
        <input aria-label="新项目名称" value={newProject} onChange={event => onNewProjectChange(event.target.value)} placeholder="例如：品牌宣传片" onKeyDown={event => { if (event.key === "Enter" && newProject.trim() && !creating) void runProjectAction("create", onCreateProject); }} />
        <label>
          <span>画布比例</span>
          <select aria-label="新建项目画布比例" value={newProjectRatio} onChange={event => onNewProjectRatioChange(event.target.value)}>
            {[{ value: "169", label: "16:9" }, { value: "916", label: "9:16" }, { value: "11", label: "1:1" }, { value: "43", label: "4:3" }, { value: "34", label: "3:4" }].map(option => <option value={option.value} key={option.value}>{option.label}</option>)}
          </select>
        </label>
        <button className="project-library-primary" disabled={!newProject.trim() || creating || busyKey === "create"} onClick={() => void runProjectAction("create", onCreateProject)}><Plus size={15} />{creating || busyKey === "create" ? "正在创建…" : "新建项目"}</button>
      </div>
    </section>

    <section className="project-library-listing" aria-labelledby="project-list-title">
      <header className="project-library-listing-head">
        <div><h3 id="project-list-title">项目库</h3><span>{visibleProjects.length} 个项目</span></div>
        <button className="project-library-refresh" disabled={refreshing || busyKey !== null} onClick={() => void runProjectAction("refresh", onRefresh)} aria-label={refreshing || busyKey === "refresh" ? "正在刷新项目" : "刷新项目列表"} title="刷新项目列表"><RefreshCw size={14} className={refreshing || busyKey === "refresh" ? "spin" : ""} /></button>
      </header>
      <div className="project-library-tools">
        <label className="project-library-search"><Search size={15} aria-hidden="true" /><input type="text" role="searchbox" inputMode="search" autoComplete="off" aria-label="搜索项目" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索项目名称或目录" /></label>
        <select aria-label="筛选项目状态" value={statusFilter} onChange={event => setStatusFilter(event.target.value as ProjectStatusFilter)}>
          <option value="all">全部项目</option><option value="active">本机项目</option><option value="archived">已归档</option><option value="missing">目录缺失</option>
        </select>
        <select aria-label="项目排序方式" value={sort} onChange={event => { setSort(event.target.value as ProjectSort); setReversed(false); }}>
          <option value="recent">最近打开</option><option value="updated">最近修改</option><option value="name">项目名称</option>
        </select>
        <button type="button" className="project-library-order" aria-label={reversed ? "恢复排序方向" : "反转排序方向"} aria-pressed={reversed} title={reversed ? "恢复排序方向" : "反转排序方向"} onClick={() => setReversed(value => !value)}>↕</button>
        <div className="project-library-view" role="group" aria-label="项目视图">
          <button type="button" aria-label="卡片视图" aria-pressed={view === "grid"} className={view === "grid" ? "active" : ""} onClick={() => setView("grid")}><LayoutGrid size={15} /></button>
          <button type="button" aria-label="列表视图" aria-pressed={view === "list"} className={view === "list" ? "active" : ""} onClick={() => setView("list")}><List size={15} /></button>
        </div>
      </div>
      {error && <p className="project-library-error" role="alert">{error}</p>}
      <div className={`project-library-grid${view === "list" ? " list-view" : ""}`} role="list" aria-label="项目列表">
        {visibleProjects.map(project => {
          const active = project.project_id === activeProjectId;
          const coverUrl = (() => { try { return localStorage.getItem(`vortex-cut.cover.${project.project_id}`); } catch { return null; } })();
          const editing = renamingId === project.project_id;
          const cardBusy = busyKey === `project:${project.project_id}`;
          return <article key={project.project_id} role="listitem" className={`project-library-card${active ? " current" : ""}${editing ? " editing" : ""}`} data-project-id={project.project_id}>
            <div className="project-library-card-main">
              <div className="project-library-cover" aria-hidden="true">{coverUrl ? <img src={coverUrl} alt="" /> : <><Film size={27} /><span>VORTEX CUT</span></>}</div>
              <div className="project-library-card-info">
                <div className="project-library-card-title"><h4 title={project.name}>{project.name}</h4><span className={`project-library-status ${project.status}`}>{projectStatus(project)}</span></div>
                <p className="project-library-root" title={project.root_dir_name}>{project.root_dir_name}</p>
                <div className="project-library-meta"><span>{ratioLabel(project)} · {project.canvas.fps_num / Math.max(1, project.canvas.fps_den)} fps</span><span><Clock3 size={12} />最近打开 {formatProjectTime(project.last_opened_at)}</span></div>
                {editing && <form className="project-library-rename" onSubmit={event => { event.preventDefault(); if (!renameValue.trim()) return; void runProjectAction(`project:${project.project_id}`, async () => { await onRename(project, renameValue.trim()); setRenamingId(null); }); }}>
                  <input aria-label={`项目名称 ${project.name}`} autoFocus value={renameValue} maxLength={120} onChange={event => setRenameValue(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setRenamingId(null); } }} />
                  <button type="submit" disabled={!renameValue.trim() || cardBusy} aria-label="保存项目名称" title="保存"><Save size={14} /></button>
                  <button type="button" disabled={cardBusy} aria-label="取消重命名" title="取消" onClick={() => setRenamingId(null)}><X size={14} /></button>
                </form>}
              </div>
            </div>
            <footer className="project-library-card-actions">
              <button className="project-library-open" disabled={project.status === "missing" || cardBusy} onClick={() => onOpen(project)}>{active ? <><Check size={14} />当前项目</> : "打开项目"}</button>
              <button type="button" disabled={cardBusy || editing} aria-label={`重命名项目 ${project.name}`} title="重命名" onClick={() => beginRename(project)}><Pencil size={14} /></button>
              <button type="button" disabled={cardBusy} aria-label={project.status === "archived" ? `重新打开项目 ${project.name}` : `归档项目 ${project.name}`} title={project.status === "archived" ? "重新打开项目" : "归档项目"} onClick={() => void runProjectAction(`project:${project.project_id}`, () => onToggleArchive(project))}>{project.status === "archived" ? <RotateCcw size={14} /> : <Archive size={14} />}</button>
            </footer>
          </article>;
        })}
        {!visibleProjects.length && <div className="project-library-empty"><FolderPlus size={24} /><strong>{projects.length ? "没有匹配的项目" : "还没有项目"}</strong><span>{projects.length ? "试试其他搜索词或筛选条件。" : "新建项目后，它们会出现在这里。"}</span></div>}
      </div>
    </section>
  </Dialog>;
}
