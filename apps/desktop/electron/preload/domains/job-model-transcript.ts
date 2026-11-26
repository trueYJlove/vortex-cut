import { ipcRenderer } from "electron";
import type {
  Job,
  JobId,
  JobPage,
  ModelDetail,
  ModelDownloadPage,
  ModelDownloadResponse,
  ModelDownloadStatusResponse,
  ModelId,
  Transcript,
  TranscriptId,
  TranscriptPage,
  TranscriptionCreateResponse,
} from "@aivideo/contracts";

export interface JobModelTranscriptPreloadApi {
  listJobs: (input: { project_id: Job["project_id"]; status?: Job["status"]; limit?: number; cursor?: string }) => Promise<JobPage>;
  createJob: (input: { project_id: Job["project_id"]; media_id: string; kind: "proxy" | "portrait_sample"; encoder_mode?: "auto" | "software"; start_us?: number; duration_us?: number; layout?: "blurred_background" }) => Promise<Job>;
  getJob: (jobId: JobId) => Promise<Job>;
  cancelJob: (jobId: JobId) => Promise<Job>;
  /** 移除一条已结束的任务记录（历史清理）；运行中/排队中由 Core 拒绝。 */
  deleteJob: (jobId: JobId) => Promise<void>;
  subscribeJob: (jobId: JobId, listener: (job: Job) => void) => () => void;
  listModels: (params?: { status?: string; limit?: number; cursor?: string }) => Promise<ModelDownloadPage>;
  getModel: (modelId: ModelId) => Promise<ModelDetail>;
  downloadModel: (input: { model_id: ModelId; license_acceptance: string | null }) => Promise<ModelDownloadResponse>;
  getModelDownload: (modelId: ModelId) => Promise<ModelDownloadStatusResponse>;
  cancelModelDownload: (modelId: ModelId) => Promise<ModelDownloadResponse>;
  createTranscription: (input: { asset_id: string; model_id: ModelId; language: string; word_timestamps: boolean; license_acceptance: string | null }) => Promise<TranscriptionCreateResponse>;
  listTranscripts: (assetId: string) => Promise<TranscriptPage>;
  getTranscript: (transcriptId: TranscriptId) => Promise<Transcript>;
  /** 删除转录；仍被时间线字幕引用时由 Core 拒绝（TRANSCRIPTION_IN_USE）。 */
  deleteTranscript: (transcriptId: TranscriptId) => Promise<void>;
}

export function createJobModelTranscriptPreloadApi(): JobModelTranscriptPreloadApi {
  return {
    listJobs: input => ipcRenderer.invoke("job:list", input),
    createJob: input => ipcRenderer.invoke("job:create", input),
    getJob: jobId => ipcRenderer.invoke("job:get", jobId),
    cancelJob: jobId => ipcRenderer.invoke("job:cancel", jobId),
    deleteJob: jobId => ipcRenderer.invoke("job:delete", jobId),
    subscribeJob: (jobId, listener) => {
      const channel = `job:event:${jobId}`;
      const handler = (_event: Electron.IpcRendererEvent, job: Job) => listener(job);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    listModels: params => ipcRenderer.invoke("model:list", params),
    getModel: modelId => ipcRenderer.invoke("model:get", modelId),
    downloadModel: input => ipcRenderer.invoke("model:download", input),
    getModelDownload: modelId => ipcRenderer.invoke("model:download-status", modelId),
    cancelModelDownload: modelId => ipcRenderer.invoke("model:cancel", modelId),
    createTranscription: input => ipcRenderer.invoke("transcription:create", input),
    listTranscripts: assetId => ipcRenderer.invoke("transcription:list", assetId),
    getTranscript: transcriptId => ipcRenderer.invoke("transcript:get", transcriptId),
    deleteTranscript: transcriptId => ipcRenderer.invoke("transcript:delete", transcriptId),
  };
}
