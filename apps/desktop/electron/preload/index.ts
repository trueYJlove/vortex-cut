import { contextBridge } from "electron";
import { createAiEditingPreloadApi, type AiEditingPreloadApi } from "./domains/ai-editing.js";
import { createGenerationShotPreloadApi, type GenerationShotPreloadApi } from "./domains/generation-shot.js";
import { createJobModelTranscriptPreloadApi, type JobModelTranscriptPreloadApi } from "./domains/job-model-transcript.js";
import { createPreviewExportPreloadApi, type PreviewExportPreloadApi } from "./domains/preview-export.js";
import { createProjectAssetPreloadApi, type ProjectAssetPreloadApi } from "./domains/project-asset.js";
import { createSystemPreloadApi, type SystemPreloadApi } from "./domains/system.js";
import { createTimelinePreloadApi, type TimelinePreloadApi } from "./domains/timeline.js";

export type {
  AuthoritativePreviewPresentation,
  DesktopRuntime,
  ExportRecordPresentation,
  MediaSelection,
  PreviewIrPresentation,
  RenderArtifactPresentation,
  RenditionPreviewPresentation,
  RenditionReframePreviewPresentation,
} from "./domains/types.js";

// M3-0 探针 dev-only 桥：生产构建 NODE_ENV 静态替换 → 死代码消除（见 probe-bridge.ts 注释）。
if (process.env.NODE_ENV !== "production" && process.env.AIVS_M3_PROBE) {
  void import("./probe-bridge.js").then(module => module.registerProbeBridge()).catch(() => undefined);
}

export type DesktopApi =
  & SystemPreloadApi
  & ProjectAssetPreloadApi
  & JobModelTranscriptPreloadApi
  & TimelinePreloadApi
  & AiEditingPreloadApi
  & PreviewExportPreloadApi
  & GenerationShotPreloadApi;

const api: DesktopApi = {
  ...createSystemPreloadApi(),
  ...createProjectAssetPreloadApi(),
  ...createJobModelTranscriptPreloadApi(),
  ...createTimelinePreloadApi(),
  ...createAiEditingPreloadApi(),
  ...createPreviewExportPreloadApi(),
  ...createGenerationShotPreloadApi(),
};

contextBridge.exposeInMainWorld("desktop", api);
