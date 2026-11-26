import { ipcRenderer, webUtils } from "electron";
import type {
  AssetAvailability,
  AssetKind,
  AssetPresentation,
  AssetPresentationPage,
  GrantId,
  ImportedAsset,
  MediaInfo,
  Project,
  ProjectId,
  ProjectPage,
  ProjectStatus,
} from "@aivideo/contracts";
import type { MediaSelection } from "./types.js";

export interface ProjectAssetPreloadApi {
  chooseMedia: () => Promise<MediaSelection | null>;
  probeMedia: (grantId: GrantId) => Promise<MediaInfo>;
  listProjects: (params?: { status?: ProjectStatus; limit?: number; cursor?: string }) => Promise<ProjectPage>;
  createProject: (input: { name: string; root_dir_name?: string; canvas?: { width: number; height: number; fps_num?: number; fps_den?: number } }) => Promise<Project>;
  getProject: (projectId: ProjectId) => Promise<Project>;
  renameProject: (input: { project_id: ProjectId; name: string }) => Promise<Project>;
  archiveProject: (projectId: ProjectId) => Promise<Project>;
  reopenProject: (projectId: ProjectId) => Promise<Project>;
  listAssets: (input: { project_id: ProjectId; availability?: AssetAvailability; limit?: number; cursor?: string }) => Promise<AssetPresentationPage>;
  importAsset: (input: { project_id: ProjectId; kind?: AssetKind }) => Promise<ImportedAsset | null>;
  /** Import native files received by HTML5 drop; real paths are resolved inside preload and never returned to Renderer. */
  importDroppedAssets: (input: { project_id: ProjectId; files: readonly File[] }) => Promise<{
    imported: ImportedAsset[];
    failures: Array<{ name: string; reason: "unsupported" | "invalid" | "import_failed" }>;
  }>;
  /** E2E 基准专用：从 AIVS_E2E_ASSET_PATHS_LIST 夹具表按文件名导入；非基准环境无该表则拒绝。 */
  importAssetByFixture: (input: { project_id: ProjectId; fixture_file: string }) => Promise<ImportedAsset | null>;
  refreshAsset: (assetId: string) => Promise<AssetPresentation>;
  /** 按素材重签媒体票据（时间线抽帧源）；不触发 Core 素材重扫。 */
  assetMediaTicket: (assetId: string) => Promise<{ media_url: string }>;
  relocateAsset: (input: { asset_id: string }) => Promise<ImportedAsset | null>;
  /** 删除素材；remove_timeline_clips=true 时级联删除时间线相关片段，返回清理计数。 */
  deleteAsset: (input: { asset_id: string; remove_timeline_clips?: boolean }) => Promise<{ removed_clips: number; removed_captions: number }>;
  /** 打开素材所在文件夹；文件缺失时弹框提供 重新定位 / 移除 恢复路径。 */
  revealAsset: (assetId: string) => Promise<{ status: "opened" | "relocated" | "deleted" | "cancelled" }>;
  /** 弹出字幕文件选择框（SRT/ASS/SSA/LRC），返回文本内容；取消返回 null。 */
  importSubtitle: () => Promise<{ file_name: string; content: string } | null>;
  captionFontUrl: () => Promise<string>;
  captionFontUrls: () => Promise<Array<{ family: string; media_url: string }>>;
}

export function createProjectAssetPreloadApi(): ProjectAssetPreloadApi {
  return {
    chooseMedia: () => ipcRenderer.invoke("media:choose"),
    probeMedia: grantId => ipcRenderer.invoke("media:probe", grantId),
    listProjects: params => ipcRenderer.invoke("project:list", params),
    createProject: input => ipcRenderer.invoke("project:create", input),
    getProject: projectId => ipcRenderer.invoke("project:get", projectId),
    renameProject: input => ipcRenderer.invoke("project:rename", input),
    archiveProject: projectId => ipcRenderer.invoke("project:archive", projectId),
    reopenProject: projectId => ipcRenderer.invoke("project:reopen", projectId),
    listAssets: input => ipcRenderer.invoke("asset:list", input),
    importAsset: input => ipcRenderer.invoke("asset:import", input),
    importDroppedAssets: input => {
      const files = Array.from(input.files ?? []).map(file => ({
        path: webUtils.getPathForFile(file),
        name: file.name,
        size: file.size,
        type: file.type,
        last_modified: file.lastModified,
      }));
      return ipcRenderer.invoke("asset:import-dropped", { project_id: input.project_id, files });
    },
    importAssetByFixture: input => ipcRenderer.invoke("asset:import-fixture", input),
    refreshAsset: assetId => ipcRenderer.invoke("asset:refresh", assetId),
    assetMediaTicket: assetId => ipcRenderer.invoke("asset:media-ticket", assetId),
    relocateAsset: input => ipcRenderer.invoke("asset:relocate", input),
    deleteAsset: input => ipcRenderer.invoke("asset:delete", input),
    revealAsset: assetId => ipcRenderer.invoke("asset:reveal", assetId),
    importSubtitle: () => ipcRenderer.invoke("subtitle:import"),
    captionFontUrl: () => ipcRenderer.invoke("media:caption-font-url"),
    captionFontUrls: () => ipcRenderer.invoke("media:caption-font-urls"),
  };
}
