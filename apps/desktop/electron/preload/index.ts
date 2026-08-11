import { contextBridge, ipcRenderer } from "electron";
import type {
  Asset,
  AssetAvailability,
  AssetKind,
  AssetPage,
  AssetPresentationPage,
  AssetPresentation,
  CoreHealth,
  FileGrant,
  GrantId,
  ImportedAsset,
  Job,
  JobId,
  JobPage,
  MediaInfo,
  ModelDetail,
  ModelDownloadPage,
  ModelDownloadResponse,
  ModelDownloadStatusResponse,
  ModelId,
  Project,
  ProjectId,
  ProjectPage,
  ProjectStatus,
  Transcript,
  TranscriptId,
  TranscriptPage,
  TranscriptionCreateResponse
} from "@aivideo/contracts";

export interface MediaSelection { grant: FileGrant; media: MediaInfo }
export interface DesktopRuntime { protocol_version: 1; status: "ready" }

export interface DesktopApi {
  getRuntime: () => Promise<DesktopRuntime>;
  chooseMedia: () => Promise<MediaSelection | null>;
  probeMedia: (grantId: GrantId) => Promise<MediaInfo>;
  listProjects: (params?: { status?: ProjectStatus; limit?: number; cursor?: string }) => Promise<ProjectPage>;
  createProject: (input: { name: string; root_dir_name?: string }) => Promise<Project>;
  getProject: (projectId: ProjectId) => Promise<Project>;
  renameProject: (input: { project_id: ProjectId; name: string }) => Promise<Project>;
  archiveProject: (projectId: ProjectId) => Promise<Project>;
  reopenProject: (projectId: ProjectId) => Promise<Project>;
  listAssets: (input: { project_id: ProjectId; availability?: AssetAvailability; limit?: number; cursor?: string }) => Promise<AssetPresentationPage>;
  importAsset: (input: { project_id: ProjectId; kind?: AssetKind }) => Promise<ImportedAsset | null>;
  refreshAsset: (assetId: string) => Promise<AssetPresentation>;
  relocateAsset: (input: { asset_id: string }) => Promise<ImportedAsset | null>;
  listJobs: (input: { project_id: ProjectId; status?: Job["status"]; limit?: number; cursor?: string }) => Promise<JobPage>;
  createJob: (input: { project_id: ProjectId; media_id: MediaInfo["media_id"]; kind: "proxy" | "portrait_sample"; encoder_mode?: "auto" | "software"; start_us?: number; duration_us?: number; layout?: "blurred_background" }) => Promise<Job>;
  getJob: (jobId: JobId) => Promise<Job>;
  cancelJob: (jobId: JobId) => Promise<Job>;
  listModels: (params?: { status?: string; limit?: number; cursor?: string }) => Promise<ModelDownloadPage>;
  getModel: (modelId: ModelId) => Promise<ModelDetail>;
  downloadModel: (input: { model_id: ModelId; license_acceptance: string | null }) => Promise<ModelDownloadResponse>;
  getModelDownload: (modelId: ModelId) => Promise<ModelDownloadStatusResponse>;
  cancelModelDownload: (modelId: ModelId) => Promise<ModelDownloadResponse>;
  createTranscription: (input: { asset_id: string; model_id: ModelId; language: string; word_timestamps: boolean; license_acceptance: string | null }) => Promise<TranscriptionCreateResponse>;
  listTranscripts: (assetId: string) => Promise<TranscriptPage>;
  getTranscript: (transcriptId: TranscriptId) => Promise<Transcript>;
  openArtifact: (artifactId: string) => Promise<void>;
  openArtifactFolder: (artifactId: string) => Promise<void>;
  subscribeJob: (jobId: JobId, listener: (job: Job) => void) => () => void;
  diagnostics: () => Promise<CoreHealth>;
}

const api: DesktopApi = {
  getRuntime: () => ipcRenderer.invoke("runtime:get"),
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
  refreshAsset: assetId => ipcRenderer.invoke("asset:refresh", assetId),
  relocateAsset: input => ipcRenderer.invoke("asset:relocate", input),
  listJobs: input => ipcRenderer.invoke("job:list", input),
  createJob: input => ipcRenderer.invoke("job:create", input),
  getJob: jobId => ipcRenderer.invoke("job:get", jobId),
  cancelJob: jobId => ipcRenderer.invoke("job:cancel", jobId),
  listModels: params => ipcRenderer.invoke("model:list", params),
  getModel: modelId => ipcRenderer.invoke("model:get", modelId),
  downloadModel: input => ipcRenderer.invoke("model:download", input),
  getModelDownload: modelId => ipcRenderer.invoke("model:download-status", modelId),
  cancelModelDownload: modelId => ipcRenderer.invoke("model:cancel", modelId),
  createTranscription: input => ipcRenderer.invoke("transcription:create", input),
  listTranscripts: assetId => ipcRenderer.invoke("transcription:list", assetId),
  getTranscript: transcriptId => ipcRenderer.invoke("transcript:get", transcriptId),
  openArtifact: artifactId => ipcRenderer.invoke("artifact:open", artifactId),
  openArtifactFolder: artifactId => ipcRenderer.invoke("artifact:folder", artifactId),
  subscribeJob: (jobId, listener) => {
    const channel = `job:event:${jobId}`;
    const handler = (_event: Electron.IpcRendererEvent, job: Job) => listener(job);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  diagnostics: () => ipcRenderer.invoke("diagnostics:get")
};

contextBridge.exposeInMainWorld("desktop", api);
