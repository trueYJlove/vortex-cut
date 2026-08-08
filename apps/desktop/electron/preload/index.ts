import { contextBridge, ipcRenderer } from "electron";
import type { CoreHealth, FileGrant, Job, MediaInfo, GrantId, JobId, ArtifactId } from "@aivideo/contracts";

export interface MediaSelection { grant: FileGrant; media: MediaInfo }

export interface DesktopApi {
  getRuntime: () => Promise<{ base_url: string; ui_token: string; protocol_version: 1 }>;
  chooseMedia: () => Promise<MediaSelection | null>;
  probeMedia: (grantId: GrantId) => Promise<MediaInfo>;
  createJob: (input: { media_id: MediaInfo["media_id"]; kind: "proxy" | "portrait_sample"; encoder_mode?: "auto" | "software"; start_us?: number; duration_us?: number; layout?: "blurred_background" }) => Promise<Job>;
  getJob: (jobId: JobId) => Promise<Job>;
  cancelJob: (jobId: JobId) => Promise<Job>;
  openArtifact: (artifactId: ArtifactId) => Promise<void>;
  openArtifactFolder: (artifactId: ArtifactId) => Promise<void>;
  subscribeJob: (jobId: JobId, listener: (job: Job) => void) => () => void;
  diagnostics: () => Promise<CoreHealth>;
}

const api: DesktopApi = {
  getRuntime: () => ipcRenderer.invoke("runtime:get"),
  chooseMedia: () => ipcRenderer.invoke("media:choose"),
  probeMedia: grantId => ipcRenderer.invoke("media:probe", grantId),
  createJob: input => ipcRenderer.invoke("job:create", input),
  getJob: jobId => ipcRenderer.invoke("job:get", jobId),
  cancelJob: jobId => ipcRenderer.invoke("job:cancel", jobId),
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
