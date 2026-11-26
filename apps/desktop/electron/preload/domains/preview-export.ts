import { ipcRenderer } from "electron";
import type {
  DerivedMediaEntry,
  DerivedMediaStats,
  DestinationGrant,
  DirectoryGrant,
  EncoderMode,
  ExportBatch,
  ExportBatchCreateInput,
  ExportBatchRetryInput,
  ExportQuality,
  Job,
  OutputRatio,
  PcmChunkDescription,
  PcmChunkMediaResponse,
  PlatformPreset,
  PreviewIrV2Manifest,
  PreviewIrV2Window,
  PreviewSourceDescription,
  PreviewSourceJobResponse,
  PreviewSourceMediaResponse,
  PreviewSourceMode,
  PreviewSourceProfileId,
  ProjectId,
  ReframeExportBatch,
  ReframeExportBatchCreateInput,
  ReframeExportBatchRetryInput,
  RenderArtifactId,
  RenditionPreset,
  RenditionPreviewCreateInput,
  RenditionReframePreviewCreateInput,
  TimelineRevisionId,
  WaveformDescription,
  WaveformMediaResponse,
} from "@aivideo/contracts";
import type {
  AuthoritativePreviewPresentation,
  ExportRecordPresentation,
  PreviewIrPresentation,
  RenderArtifactPresentation,
  RenditionPreviewPresentation,
  RenditionReframePreviewPresentation,
} from "./types.js";

export interface PreviewExportPreloadApi {
  createPreview: (input: { project_id: ProjectId; preview: { timeline_revision_id?: TimelineRevisionId; encoder_mode?: EncoderMode; output_ratio?: OutputRatio } }) => Promise<{ job: Job | null; preview: AuthoritativePreviewPresentation | null; reused: boolean }>;
  listPreviews: (input: { project_id: ProjectId; limit?: number; cursor?: string }) => Promise<{ items: AuthoritativePreviewPresentation[]; next_cursor: string | null }>;
  chooseExportDestination: (projectId: ProjectId, fileNameOverride?: string) => Promise<DestinationGrant | null>;
  renameExportDestination: (input: { grant_id: DestinationGrant["destination_grant_id"]; file_name: string }) => Promise<DestinationGrant>;
  createExport: (input: { project_id: ProjectId; export: { timeline_revision_id?: TimelineRevisionId; destination_grant_id: DestinationGrant["destination_grant_id"]; encoder_mode?: EncoderMode; output_ratio?: OutputRatio; quality?: ExportQuality; resolution?: string; frame_rate?: number } }) => Promise<{ job: Job; export_record: ExportRecordPresentation | null }>;
  listExports: (input: { project_id: ProjectId; limit?: number; cursor?: string }) => Promise<{ items: ExportRecordPresentation[]; next_cursor: string | null }>;
  deleteExportRecord: (input: { project_id: ProjectId; export_record_id: string }) => Promise<void>;
  listPlatformPresets: () => Promise<{ items: PlatformPreset[] }>;
  listRenditionPresets: () => Promise<{ items: RenditionPreset[] }>;
  createRenditionPreview: (input: { project_id: ProjectId; preview: RenditionPreviewCreateInput }) => Promise<{ job: Job | null; preview: RenditionPreviewPresentation | null; reused: boolean }>;
  listRenditionPreviews: (input: { project_id: ProjectId; limit?: number; cursor?: string }) => Promise<{ items: RenditionPreviewPresentation[]; next_cursor: string | null }>;
  chooseExportDirectory: (projectId: ProjectId) => Promise<DirectoryGrant | null>;
  createExportBatch: (input: { project_id: ProjectId; batch: ExportBatchCreateInput }) => Promise<{ batch: ExportBatch; jobs: Job[] }>;
  getExportBatch: (batchId: string) => Promise<ExportBatch>;
  listExportBatches: (input: { project_id: ProjectId; limit?: number; cursor?: string }) => Promise<{ items: ExportBatch[]; next_cursor: string | null }>;
  cancelExportBatch: (batchId: string) => Promise<ExportBatch>;
  retryExportBatch: (input: { batch_id: string; retry: ExportBatchRetryInput }) => Promise<{ batch: ExportBatch; jobs: Job[] }>;
  createRenditionReframePreview: (input: { project_id: ProjectId; preview: RenditionReframePreviewCreateInput }) => Promise<{ job: Job | null; preview: RenditionReframePreviewPresentation | null; reused: boolean }>;
  listRenditionReframePreviews: (input: { project_id: ProjectId; limit?: number; cursor?: string }) => Promise<{ items: RenditionReframePreviewPresentation[]; next_cursor: string | null }>;
  createReframeExportBatch: (input: { project_id: ProjectId; batch: ReframeExportBatchCreateInput }) => Promise<{ batch: ReframeExportBatch; jobs: Job[] }>;
  getReframeExportBatch: (batchId: string) => Promise<ReframeExportBatch>;
  listReframeExportBatches: (input: { project_id: ProjectId; limit?: number; cursor?: string }) => Promise<{ items: ReframeExportBatch[]; next_cursor: string | null }>;
  cancelReframeExportBatch: (batchId: string) => Promise<ReframeExportBatch>;
  retryReframeExportBatch: (input: { batch_id: string; retry: ReframeExportBatchRetryInput }) => Promise<{ batch: ReframeExportBatch; jobs: Job[] }>;
  getRenderArtifact: (artifactId: RenderArtifactId) => Promise<RenderArtifactPresentation>;
  getPreviewIr: (input: { project_id: ProjectId; timeline_revision_id?: string | null; output_ratio?: string }) => Promise<PreviewIrPresentation>;
  // C20 窗口化 IR v2：manifest（非帧 DTO）+ 窗口帧表切片（Renderer 分页取帧）
  getPreviewIrV2Manifest: (input: { project_id: ProjectId; timeline_revision_id?: string | null; output_ratio?: string }) => Promise<PreviewIrV2Manifest>;
  getPreviewIrV2Window: (input: { project_id: ProjectId; start_frame: number; frame_count: number; timeline_revision_id?: string | null; output_ratio?: string }) => Promise<PreviewIrV2Window>;
  // B10 派生媒体缓存（performance-v1）：查询/用量 + 票据化媒体 URL
  lookupDerivedMedia: (input: { project_id: ProjectId; asset_id: string; kind: string; params: Record<string, string> }) => Promise<DerivedMediaEntry>;
  derivedMediaStats: (projectId: ProjectId) => Promise<DerivedMediaStats>;
  derivedMediaUrl: (input: { project_id: ProjectId; asset_id: string; kind: string; params: Record<string, string> }) => Promise<{ media_url: string; cache_key: string; status: "ready"; size_bytes: number }>;
  // B11 preview-source（全源代理与预览源选择）：描述/作业/代理票据
  getPreviewSource: (input: { project_id: ProjectId; asset_id: string; profile_id?: PreviewSourceProfileId; mode?: PreviewSourceMode; generate?: boolean }) => Promise<PreviewSourceDescription>;
  createPreviewSourceJob: (input: { project_id: ProjectId; asset_id: string; profile_id?: PreviewSourceProfileId }) => Promise<PreviewSourceJobResponse>;
  previewSourceMediaUrl: (input: { project_id: ProjectId; asset_id: string; profile_id: PreviewSourceProfileId }) => Promise<PreviewSourceMediaResponse>;
  // B14 素材级持久化波形：描述（generate 登记作业）+ 票据化文件 URL
  getWaveform: (input: { project_id: ProjectId; asset_id: string; generate?: boolean }) => Promise<WaveformDescription>;
  waveformMediaUrl: (input: { project_id: ProjectId; asset_id: string }) => Promise<WaveformMediaResponse>;
  /** WP-P232：缩略图条目查询/登记。 */
  ensureFilmstrip: (input: { project_id: ProjectId; asset_id: string; step_ms: number; generate: boolean }) => Promise<{ cache_key: string; step_ms: number; status: string; job_id: string | null; size_bytes: number | null }>;
  /** WP-P232：缩略图 sprite 取件。 */
  filmstripMediaUrl: (input: { project_id: ProjectId; asset_id: string; step_ms: number }) => Promise<{ media_url: string; cache_key: string; step_ms: number; cell_w: number; cell_h: number; count: number; duration_us: number; size_bytes: number }>;
  // B15 分块 PCM：块确保（网格对齐）+ 票据化块文件 URL
  ensurePcmChunk: (input: { project_id: ProjectId; asset_id: string; start_sample: number }) => Promise<PcmChunkDescription>;
  pcmChunkMediaUrl: (input: { project_id: ProjectId; asset_id: string; start_sample: number }) => Promise<PcmChunkMediaResponse>;
  /** H3 后端 B：窗口帧解码（AIV1 紧凑二进制；路径永不进 Renderer）。 */
  decodeFrames: (input: { project_id: ProjectId; asset_id: string; frame_numbers: number[]; fps: number; ticket_ref: string }) => Promise<ArrayBuffer>;
  decodeCapability?: () => Promise<{ decoders: Record<string, boolean>; probed_at: string; ffmpeg_fingerprint: string }>;
  openArtifact: (artifactId: string) => Promise<void>;
  openArtifactFolder: (artifactId: string) => Promise<void>;
}

export function createPreviewExportPreloadApi(): PreviewExportPreloadApi {
  return {
    createPreview: input => ipcRenderer.invoke("preview:create", input),
    listPreviews: input => ipcRenderer.invoke("preview:list", input),
    chooseExportDestination: (projectId, fileNameOverride?) => ipcRenderer.invoke("export:choose-destination", projectId, fileNameOverride),
    renameExportDestination: input => ipcRenderer.invoke("export:rename-destination", input),
    createExport: input => ipcRenderer.invoke("export:create", input),
    listExports: input => ipcRenderer.invoke("export:list", input),
    deleteExportRecord: input => ipcRenderer.invoke("export:delete-record", input),
    listPlatformPresets: () => ipcRenderer.invoke("preset:list-platforms"),
    listRenditionPresets: () => ipcRenderer.invoke("preset:list-renditions"),
    createRenditionPreview: input => ipcRenderer.invoke("rendition-preview:create", input),
    listRenditionPreviews: input => ipcRenderer.invoke("rendition-preview:list", input),
    chooseExportDirectory: projectId => ipcRenderer.invoke("export:choose-directory", projectId),
    createExportBatch: input => ipcRenderer.invoke("export-batch:create", input),
    getExportBatch: batchId => ipcRenderer.invoke("export-batch:get", batchId),
    listExportBatches: input => ipcRenderer.invoke("export-batch:list", input),
    cancelExportBatch: batchId => ipcRenderer.invoke("export-batch:cancel", batchId),
    retryExportBatch: input => ipcRenderer.invoke("export-batch:retry", input),
    createRenditionReframePreview: input => ipcRenderer.invoke("reframe-preview:create", input),
    listRenditionReframePreviews: input => ipcRenderer.invoke("reframe-preview:list", input),
    createReframeExportBatch: input => ipcRenderer.invoke("reframe-export-batch:create", input),
    getReframeExportBatch: batchId => ipcRenderer.invoke("reframe-export-batch:get", batchId),
    listReframeExportBatches: input => ipcRenderer.invoke("reframe-export-batch:list", input),
    cancelReframeExportBatch: batchId => ipcRenderer.invoke("reframe-export-batch:cancel", batchId),
    retryReframeExportBatch: input => ipcRenderer.invoke("reframe-export-batch:retry", input),
    getRenderArtifact: artifactId => ipcRenderer.invoke("render-artifact:get", artifactId),
    getPreviewIr: input => ipcRenderer.invoke("preview-ir:get", input),
    getPreviewIrV2Manifest: input => ipcRenderer.invoke("preview-ir-v2:manifest", input),
    getPreviewIrV2Window: input => ipcRenderer.invoke("preview-ir-v2:window", input),
    lookupDerivedMedia: input => ipcRenderer.invoke("derived-media:lookup", input),
    derivedMediaStats: projectId => ipcRenderer.invoke("derived-media:stats", { project_id: projectId }),
    derivedMediaUrl: input => ipcRenderer.invoke("derived-media:media", input),
    getPreviewSource: input => ipcRenderer.invoke("preview-source:get", input),
    createPreviewSourceJob: input => ipcRenderer.invoke("preview-source:jobs", input),
    previewSourceMediaUrl: input => ipcRenderer.invoke("preview-source:media", input),
    getWaveform: input => ipcRenderer.invoke("waveform:get", input),
    waveformMediaUrl: input => ipcRenderer.invoke("waveform:media", input),
    ensureFilmstrip: input => ipcRenderer.invoke("filmstrip:ensure", input),
    filmstripMediaUrl: input => ipcRenderer.invoke("filmstrip:media", input),
    ensurePcmChunk: input => ipcRenderer.invoke("pcm-chunk:ensure", input),
    pcmChunkMediaUrl: input => ipcRenderer.invoke("pcm-chunk:media", input),
    decodeFrames: input => ipcRenderer.invoke("decode-frames", input),
    decodeCapability: () => ipcRenderer.invoke("decode-capability"),
    openArtifact: artifactId => ipcRenderer.invoke("artifact:open", artifactId),
    openArtifactFolder: artifactId => ipcRenderer.invoke("artifact:folder", artifactId),
  };
}
