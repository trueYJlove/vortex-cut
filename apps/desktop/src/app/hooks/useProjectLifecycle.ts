import { useEffect, useRef, useState } from "react";
import type React from "react";
import type {
  AssetPresentation,
  Job,
  ModelSummary,
  Project,
  TimelineDiff,
  TimelineDocument,
  TimelineState,
  TranscriptSummary,
} from "@aivideo/contracts";
import type { ExportRecordPresentation } from "../../../electron/preload/index.js";
import { BoundedTaskQueue, RequestScheduler } from "../request-scheduling.js";
import { errorCode, safeErrorMessage } from "../safeErrors.js";
import {
  assetCollectionSignature,
  assetReconcilePageLimit,
  FINALIZING_MS,
  isTranscribable,
  projectCanvasPresets,
  reconcileTimelineSelection,
  timelineRetryDelaysMs,
  type NoticeTone,
  type Selection,
} from "../appHelpers.js";

export interface UseProjectLifecycleParams {
  projects: Project[];
  setProjects: React.Dispatch<React.SetStateAction<Project[]>>;
  project: Project | undefined;
  setProject: React.Dispatch<React.SetStateAction<Project | undefined>>;
  projectRef: React.MutableRefObject<Project | undefined>;
  openProjectIds: Project["project_id"][];
  setOpenProjectIds: React.Dispatch<React.SetStateAction<Project["project_id"][]>>;
  newProject: string;
  setNewProject: React.Dispatch<React.SetStateAction<string>>;
  newProjectRatio: string;
  setProjectDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setProjectManagerRefreshing: React.Dispatch<React.SetStateAction<boolean>>;
  setModels: React.Dispatch<React.SetStateAction<ModelSummary[]>>;
  jobs: Job[];
  setJobs: React.Dispatch<React.SetStateAction<Job[]>>;
  jobsRef: React.MutableRefObject<Job[]>;
  timelineRef: React.MutableRefObject<TimelineState | undefined>;
  setTimeline: React.Dispatch<React.SetStateAction<TimelineState | undefined>>;
  setWorking: React.Dispatch<React.SetStateAction<TimelineDocument | undefined>>;
  setSelection: React.Dispatch<React.SetStateAction<Selection>>;
  timelineLoadEpoch: React.MutableRefObject<number>;
  timelineFetchSeq: React.MutableRefObject<number>;
  projectDataEpochRef: React.MutableRefObject<number>;
  assetsRef: React.MutableRefObject<AssetPresentation[]>;
  assetsMirrorTruncatedRef: React.MutableRefObject<boolean>;
  setAssets: React.Dispatch<React.SetStateAction<AssetPresentation[]>>;
  setTranscriptSummaries: React.Dispatch<React.SetStateAction<Record<string, TranscriptSummary[]>>>;
  transcriptSummaryQueueRef: React.MutableRefObject<BoundedTaskQueue<{ items: TranscriptSummary[] }> | null>;
  renderPanelOpenRef: React.MutableRefObject<boolean>;
  setExports: React.Dispatch<React.SetStateAction<ExportRecordPresentation[]>>;
  loadRenderData: (selected: Project) => Promise<void>;
  resetAiOnProjectSwitch: () => void;
  closePatch: () => void;
  setRevisionOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setRevisionDiff: React.Dispatch<React.SetStateAction<TimelineDiff | undefined>>;
  resetRenderOnProjectSwitch: () => void;
  resetReframeOnProjectChange: () => void;
  resetAssetLibraryOnSwitch: (hardReset: boolean) => void;
  resetPreviewOnProjectSwitch: () => void;
  showNotice: (text: string, tone?: NoticeTone) => void;
}

/** 管理运行环境初始化、项目生命周期/切换隔离、时间线加载退避、项目 CRUD 与 RequestScheduler 轮询。 */
export function useProjectLifecycle({
  projects,
  setProjects,
  project,
  setProject,
  projectRef,
  openProjectIds,
  setOpenProjectIds,
  newProject,
  setNewProject,
  newProjectRatio,
  setProjectDialogOpen,
  setProjectManagerRefreshing,
  setModels,
  jobs,
  setJobs,
  jobsRef,
  timelineRef,
  setTimeline,
  setWorking,
  setSelection,
  timelineLoadEpoch,
  timelineFetchSeq,
  projectDataEpochRef,
  assetsRef,
  assetsMirrorTruncatedRef,
  setAssets,
  setTranscriptSummaries,
  transcriptSummaryQueueRef,
  renderPanelOpenRef,
  setExports,
  loadRenderData,
  resetAiOnProjectSwitch,
  closePatch,
  setRevisionOpen,
  setRevisionDiff,
  resetRenderOnProjectSwitch,
  resetReframeOnProjectChange,
  resetAssetLibraryOnSwitch,
  resetPreviewOnProjectSwitch,
  showNotice,
}: UseProjectLifecycleParams) {
  const [runtimeReady, setRuntimeReady] = useState(false);
  /** B13：Main 离散资源档位（getRuntime 注入；驱动会话环深/预算决策）。 */
  const [resourceTier, setResourceTier] = useState<"conservative" | "balanced" | "high">("balanced");
  /** B13-R 判别诊断开关（perf 诊断构建 + AIVS_FORCE_COPYTO=1 时 Main 下发）。 */
  const [forceCopyTo, setForceCopyTo] = useState(false);

  // P195：时间线装载的瞬时失败重试预算，按项目重置（切项目再来一轮 1s/4s）。
  const timelineRetryRef = useRef<{ projectId: Project["project_id"] | undefined; attempts: number }>({
    projectId: undefined,
    attempts: 0,
  });
  // 新建项目自动补建空时间线（剪映/喵影式：项目即有时间线，无需手动创建）。
  // 仅对新建项目生效——存量无时间线项目仍走菜单「创建空时间线」。
  const autoProvisionProjectId = useRef<Project["project_id"] | undefined>(undefined);
  const pollInstanceRef = useRef<symbol | null>(null);

  useEffect(() => {
    if (project) setOpenProjectIds(ids => (ids.includes(project.project_id) ? ids : [...ids, project.project_id]));
  }, [project?.project_id]);

  // 活跃任务拉取（初始加载与轮询共用）：按三个活跃状态各查一页合并去重。
  const fetchActiveJobs = async (projectId: Project["project_id"]): Promise<Job[]> => {
    const statuses = ["queued", "running", "cancelling"] as const;
    const pages = await Promise.all(statuses.map(status => window.desktop.listJobs({ project_id: projectId, status })));
    const seen = new Set<string>();
    return pages.flatMap(page => page.items).filter(item => {
      if (seen.has(item.job_id)) return false;
      seen.add(item.job_id);
      return true;
    });
  };

  // A08：loadProjectData 摘要优先——素材/任务先落库，转录正文不再全量预取
  const loadProjectData = async (selected: Project) => {
    const epoch = ++projectDataEpochRef.current;
    // GAP-LIST-ASSETS-PAGING：assets 跟随 next_cursor 翻页装载（200 页 = 10,000 条防病态游标环）
    const listAllAssets = async (projectId: Project["project_id"]) => {
      const items: Awaited<ReturnType<typeof window.desktop.listAssets>>["items"] = [];
      let cursor: string | null | undefined;
      let truncated = false;
      for (let page = 0; page < 200; page++) {
        const assetPage = await window.desktop.listAssets({ project_id: projectId, ...(cursor ? { cursor } : {}) });
        items.push(...assetPage.items);
        if (!assetPage.next_cursor) break;
        cursor = assetPage.next_cursor;
        if (page === 199) truncated = true;
      }
      return { items, truncated };
    };
    const [assetsPage, activeJobs] = await Promise.all([listAllAssets(selected.project_id), fetchActiveJobs(selected.project_id)]);
    const assetsAll = assetsPage.items;
    if (epoch !== projectDataEpochRef.current) return;
    assetsMirrorTruncatedRef.current = assetsPage.truncated;
    setAssets(assetsAll);
    setJobs(activeJobs);
    const queue = (transcriptSummaryQueueRef.current ??= new BoundedTaskQueue<{ items: TranscriptSummary[] }>(4));
    const summaries = await Promise.all(
      assetsAll
        .filter(item => isTranscribable(item.asset))
        .map(async item => {
          const assetId = String(item.asset.asset_id);
          const summaryPage = await queue.push(() => window.desktop.listTranscripts(item.asset.asset_id));
          if (summaryPage === queue.skipped) return { assetId, kind: "stale" as const };
          if (summaryPage === queue.failed) return { assetId, kind: "failed" as const };
          return { assetId, kind: "ok" as const, items: summaryPage.items };
        }),
    );
    if (epoch !== projectDataEpochRef.current) return;
    setTranscriptSummaries(previous => {
      const next: Record<string, TranscriptSummary[]> = {};
      for (const entry of summaries) {
        if (entry.kind === "stale") continue;
        if (entry.kind === "failed") {
          if (entry.assetId in previous) next[entry.assetId] = previous[entry.assetId];
          continue;
        }
        next[entry.assetId] = entry.items;
      }
      return next;
    });
  };

  const switchProject = (next: Project) => {
    if (next.project_id === projectRef.current?.project_id) return;
    resetAiOnProjectSwitch();
    projectDataEpochRef.current += 1;
    resetRenderOnProjectSwitch();
    resetAssetLibraryOnSwitch(true);
    setJobs([]);
    setTimeline(undefined);
    setWorking(undefined);
    setSelection(null);
    resetPreviewOnProjectSwitch();
    if (autoProvisionProjectId.current !== next.project_id) autoProvisionProjectId.current = undefined;
    setOpenProjectIds(ids => (ids.includes(next.project_id) ? ids : [...ids, next.project_id]));
    setProject(next);
  };

  const refreshProjects = async () => {
    const page = await window.desktop.listProjects({ limit: 100 });
    setProjects(page.items);
    const next = page.items.find(item => item.project_id === projectRef.current?.project_id) ?? page.items[0];
    if (!next) {
      projectDataEpochRef.current += 1;
      setAssets([]);
      setTimeline(undefined);
      setWorking(undefined);
      setSelection(null);
      setProject(undefined);
    } else if (next.project_id !== projectRef.current?.project_id) {
      switchProject(next);
    } else {
      setProject(next);
    }
  };

  const createProject = async () => {
    if (!newProject.trim()) return;
    const created = await window.desktop.createProject({ name: newProject.trim(), canvas: projectCanvasPresets[newProjectRatio] });
    setNewProject("");
    autoProvisionProjectId.current = created.project_id;
    await refreshProjects();
    switchProject(created);
    setProjectDialogOpen(false);
  };

  const renameManagedProject = async (item: Project, name: string) => {
    const updated = await window.desktop.renameProject({ project_id: item.project_id, name });
    setProjects(items => items.map(candidate => (candidate.project_id === updated.project_id ? updated : candidate)));
    if (projectRef.current?.project_id === updated.project_id) setProject(updated);
  };

  const toggleManagedProjectArchive = async (item: Project) => {
    const updated =
      item.status === "archived"
        ? await window.desktop.reopenProject(item.project_id)
        : await window.desktop.archiveProject(item.project_id);
    setProjects(items => items.map(candidate => (candidate.project_id === updated.project_id ? updated : candidate)));
    if (projectRef.current?.project_id === updated.project_id) setProject(updated);
  };

  const refreshProjectManager = async () => {
    setProjectManagerRefreshing(true);
    try {
      await refreshProjects();
    } finally {
      setProjectManagerRefreshing(false);
    }
  };

  useEffect(() => {
    // Capture the preload bridge for this mounted editor instance to prevent stale continuations.
    const desktop = window.desktop;
    let active = true;
    void desktop
      .getRuntime()
      .then(async runtime => {
        if (runtime?.resource_tier) setResourceTier(runtime.resource_tier);
        if (runtime?.force_copy_to) setForceCopyTo(true);
        const [projectPage, modelPage] = await Promise.all([desktop.listProjects({ limit: 100 }), desktop.listModels({ limit: 100 })]);
        if (!active) return;
        setRuntimeReady(true);
        setProjects(projectPage.items);
        const initialProject = projectPage.items[0];
        if (initialProject) switchProject(initialProject);
        else setProject(undefined);
        setModels(modelPage.items);
      })
      .catch(error => {
        if (active) showNotice(safeErrorMessage(error, "运行环境初始化失败，请刷新后重试。"));
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!project) return;
    // 防御性清理：直接由外部状态驱动项目变化时，也不能保留上一项目数据。
    setJobs([]);
    setTimeline(undefined);
    setWorking(undefined);
    setSelection(null);
    resetPreviewOnProjectSwitch();
    closePatch();
    setRevisionOpen(false);
    setRevisionDiff(undefined);
    resetReframeOnProjectChange();
    let active = true;
    timelineLoadEpoch.current += 1;
    resetAssetLibraryOnSwitch(false);
    void loadProjectData(project).catch(error => active && showNotice(safeErrorMessage(error, "项目数据加载失败，请刷新后重试。")));
    void loadRenderData(project).catch(error => active && showNotice(safeErrorMessage(error, "渲染记录加载失败，请刷新后重试。")));
    return () => {
      active = false;
    };
  }, [project?.project_id]);

  // P195：时间线装载独立成 effect，键为 project_id + updated_at。
  useEffect(() => {
    if (!project) return;
    const projectId = project.project_id;
    let active = true;
    const seq = ++timelineFetchSeq.current;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    if (timelineRetryRef.current.projectId !== projectId) timelineRetryRef.current = { projectId, attempts: 0 };
    const load = async () => {
      try {
        const value = await window.desktop.getTimeline(projectId);
        if (!active || seq !== timelineFetchSeq.current) return;
        timelineRetryRef.current.attempts = 0;
        const current = timelineRef.current;
        if (current?.project_id === projectId && current.current_revision.timeline_revision_id === value.current_revision.timeline_revision_id) {
          return;
        }
        setTimeline(value);
        setWorking(value.current_revision.document);
        setSelection(previous => reconcileTimelineSelection(previous, value));
      } catch (error) {
        if (!active || seq !== timelineFetchSeq.current) return;
        const code = errorCode(error);
        const notFound = code.includes("TIMELINE_NOT_FOUND") || code.includes("404");
        if (notFound && autoProvisionProjectId.current === projectId) {
          autoProvisionProjectId.current = undefined;
          try {
            const value = await window.desktop.createTimeline({
              project_id: projectId,
              timeline: { schema_version: 1, source: { kind: "empty" }, default_layout: "blurred_background", caption_preset_id: "default-bottom" },
            });
            if (active && seq === timelineFetchSeq.current) {
              setTimeline(value);
              setWorking(value.current_revision.document);
              setSelection(null);
            }
          } catch {
            if (active && seq === timelineFetchSeq.current) showNotice(safeErrorMessage(error, "时间线加载失败，请刷新后重试。"));
          }
          return;
        }
        if (notFound) {
          setTimeline(undefined);
          setWorking(undefined);
          return;
        }
        const attempts = timelineRetryRef.current.attempts;
        if (attempts < timelineRetryDelaysMs.length) {
          timelineRetryRef.current.attempts = attempts + 1;
          retryTimer = setTimeout(() => {
            void load();
          }, timelineRetryDelaysMs[attempts]);
          return;
        }
        setTimeline(undefined);
        setWorking(undefined);
        showNotice(safeErrorMessage(error, "时间线加载失败，请刷新后重试。"));
      }
    };
    void load();
    return () => {
      active = false;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [project?.project_id, project?.updated_at]);

  useEffect(() => {
    if (!runtimeReady) return;
    const instance = Symbol("app-poll-instance");
    pollInstanceRef.current = instance;
    const projectsSignature = { value: "" };
    const jobsSignature = { value: "" };
    const exportsSignature = { value: "" };
    const scheduler = new RequestScheduler({
      hasActiveWork: () => jobsRef.current.some(job => ["queued", "running", "cancelling"].includes(job.status)),
    });
    scheduler.register({
      key: "projects",
      fetch: async () => window.desktop.listProjects({ limit: 100 }),
      apply: page => {
        if (pollInstanceRef.current !== instance) return false;
        const signature = page.items.map(item => `${item.project_id}:${item.updated_at}`).join("|");
        if (signature === projectsSignature.value) return false;
        projectsSignature.value = signature;
        setProjects(page.items);
        const next = page.items.find(item => item.project_id === projectRef.current?.project_id) ?? page.items[0];
        if (!next) {
          projectDataEpochRef.current += 1;
          setAssets([]);
          setTimeline(undefined);
          setWorking(undefined);
          setSelection(null);
          setProject(undefined);
        } else if (next.project_id !== projectRef.current?.project_id) {
          switchProject(next);
        } else {
          setProject(next);
        }
        return true;
      },
    });
    scheduler.register({
      key: "jobs",
      enabled: () => pollInstanceRef.current === instance,
      fetch: async () => {
        if (!project) return { items: [], next_cursor: null };
        return { items: await fetchActiveJobs(project.project_id), next_cursor: null };
      },
      apply: page => {
        if (pollInstanceRef.current !== instance) return false;
        const activeIds = new Set(page.items.map(item => item.job_id));
        const staleActive = jobsRef.current.filter(
          item => ["queued", "running", "cancelling"].includes(item.status) && !activeIds.has(item.job_id),
        );
        const signature = `${page.items.map(item => `${item.job_id}:${item.status}:${item.progress ?? ""}`).join("|")}#${staleActive.length}`;
        if (signature === jobsSignature.value) return false;
        jobsSignature.value = signature;
        setJobs(items => [...page.items, ...items.filter(item => !activeIds.has(item.job_id))]);
        for (const job of staleActive) {
          void window.desktop
            .getJob(job.job_id)
            .then(updated => {
              if (pollInstanceRef.current !== instance) return;
              const wasRunning = jobsRef.current.find(item => item.job_id === updated.job_id)?.status === "running";
              setJobs(items => {
                const current = items.find(item => item.job_id === updated.job_id);
                if (!current || current.status === updated.status) return items;
                if (updated.status === "succeeded" && wasRunning && current.progress !== null && current.progress < 1) {
                  const finishing: Job = { ...updated, status: "running", progress: 1 };
                  setTimeout(() => {
                    if (pollInstanceRef.current !== instance) return;
                    setJobs(list =>
                      list.map(item => (item.job_id === updated.job_id && item.status === "running" && item.progress === 1 ? updated : item)),
                    );
                  }, FINALIZING_MS);
                  return [finishing, ...items.filter(item => item.job_id !== updated.job_id)];
                }
                return [updated, ...items.filter(item => item.job_id !== updated.job_id)];
              });
              if (
                ["succeeded", "failed", "cancelled", "interrupted"].includes(updated.status) &&
                (updated.kind === "authoritative_preview" || updated.kind === "final_export") &&
                project
              ) {
                void loadRenderData(project).catch(() => undefined);
              }
              if (updated.status === "succeeded" && updated.kind === "transcription" && projectRef.current) {
                void loadProjectData(projectRef.current).catch(() => undefined);
              }
            })
            .catch(() => undefined);
        }
        return true;
      },
    });
    scheduler.register({
      key: "exports",
      enabled: () => pollInstanceRef.current === instance && renderPanelOpenRef.current,
      fetch: async () => {
        if (!project) return { items: [], next_cursor: null };
        return window.desktop.listExports({ project_id: project.project_id, limit: 100 });
      },
      apply: page => {
        if (pollInstanceRef.current !== instance) return false;
        const signature = page.items.map(item => `${item.export_record.export_record_id}:${item.export_record.status}`).join("|");
        if (signature === exportsSignature.value) return false;
        exportsSignature.value = signature;
        setExports(page.items);
        return true;
      },
    });
    scheduler.register({
      key: "assets",
      enabled: () => {
        if (pollInstanceRef.current !== instance) return false;
        return scheduler.stats.cycles > 0 && !assetsMirrorTruncatedRef.current;
      },
      fetch: async () => {
        if (!project) return { items: [], next_cursor: null };
        return window.desktop.listAssets({ project_id: project.project_id, limit: assetReconcilePageLimit });
      },
      apply: page => {
        if (pollInstanceRef.current !== instance) return false;
        const selected = projectRef.current;
        if (!selected) return false;
        const signature = assetCollectionSignature(page.items);
        if (signature === assetCollectionSignature(assetsRef.current.slice(0, page.items.length))) return false;
        void loadProjectData(selected).catch(() => undefined);
        return true;
      },
    });
    scheduler.start();
    const handleVisibility = () => {
      if (!document.hidden) scheduler.refresh();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      scheduler.dispose();
      if (pollInstanceRef.current === instance) pollInstanceRef.current = null;
    };
  }, [runtimeReady, project?.project_id]);

  const terminalRenderJobs = jobs
    .filter(
      item =>
        (item.kind === "authoritative_preview" || item.kind === "final_export") &&
        ["succeeded", "failed", "cancelled", "interrupted"].includes(item.status),
    )
    .map(item => `${item.job_id}:${item.status}`)
    .sort()
    .join("|");

  useEffect(() => {
    if (project && terminalRenderJobs) {
      void loadRenderData(project).catch(error => showNotice(safeErrorMessage(error, "渲染记录加载失败，请刷新后重试。")));
    }
  }, [project?.project_id, terminalRenderJobs]);

  const openProjects = openProjectIds.flatMap(id => {
    const item = id === project?.project_id ? project : projects.find(candidate => candidate.project_id === id);
    return item ? [item] : [];
  });

  const closeProjectTab = (item: Project) => {
    const index = openProjects.indexOf(item);
    const next = openProjects[index + 1] ?? openProjects[index - 1];
    if (item.project_id === project?.project_id && !next) return;
    setOpenProjectIds(ids => ids.filter(id => id !== item.project_id));
    if (next && item.project_id === project?.project_id) switchProject(next);
  };

  return {
    runtimeReady,
    resourceTier,
    forceCopyTo,
    loadProjectData,
    refreshProjects,
    switchProject,
    createProject,
    renameManagedProject,
    toggleManagedProjectArchive,
    refreshProjectManager,
    openProjects,
    closeProjectTab,
  };
}
