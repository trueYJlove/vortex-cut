import { ipcMain } from "electron";
import type { MediaPresentationService } from "../bootstrap/protocol.js";
import type { RuntimeManager } from "../bootstrap/runtime.js";
import type { MainWindowManager } from "../bootstrap/window.js";
import { issueCandidateClipMedia } from "../candidate-media.js";
import type { DesktopSettingsStore } from "../desktop-settings.js";
import { registerPerformanceIpc } from "../performance-ipc.js";
import { removeProviderSecret, saveProviderSecret } from "../provider-secrets.js";
import type { RestrictedMediaRegistry } from "../restricted-media.js";
import { registerSettingsIpc } from "../settings-ipc.js";
import { registerAiEditingAnalysisIpc } from "./ai-editing-analysis-ipc.js";
import { registerAssetMediaIpc } from "./asset-media-ipc.js";
import { registerImageGenerationIpc } from "./image-generation-ipc.js";
import { registerJobModelTranscriptIpc } from "./job-model-transcript-ipc.js";
import { registerMediaGenerationIpc } from "./media-generation-ipc.js";
import { registerPlanningProviderIpc } from "./planning-provider-ipc.js";
import { registerPreviewExportIpc } from "./preview-export-ipc.js";
import { registerProjectIpc } from "./project-ipc.js";
import { registerReframeExportIpc } from "./reframe-export-ipc.js";
import { API_PREFIX, type IpcHandle } from "./shared.js";
import { registerShotImageFulfillmentIpc } from "./shot-image-fulfillment-ipc.js";
import { registerShotListIpc } from "./shot-list-ipc.js";
import { registerShotTimelineAssemblyIpc } from "./shot-timeline-assembly-ipc.js";
import { registerShotTimelineBatchAssemblyIpc } from "./shot-timeline-batch-assembly-ipc.js";
import { registerSystemIpc } from "./system-ipc.js";
import { registerTimelineIpc } from "./timeline-ipc.js";

/** Register all domain-scoped Main IPC handlers once during app readiness. */
export function registerAllIpc({
  runtimeManager,
  windowManager,
  mediaPresentation,
  restrictedMedia,
  settingsStore,
  getLogPath,
}: {
  runtimeManager: RuntimeManager;
  windowManager: MainWindowManager;
  mediaPresentation: MediaPresentationService;
  restrictedMedia: RestrictedMediaRegistry;
  settingsStore: () => DesktopSettingsStore;
  getLogPath: () => string;
}): void {
  const handle: IpcHandle = (channel, listener) => ipcMain.handle(channel, listener);
  const ipc = { handle };
  const { fetchWithUi, fetchBinaryWithUi, requireCore } = runtimeManager;

  registerSystemIpc({
    handle,
    waitForRendererRuntime: runtimeManager.waitForRendererRuntime,
    updateEditorLoad: runtimeManager.updateEditorLoad,
    setWindowTheme: windowManager.setTheme,
    getDiagnostics: runtimeManager.getHealth,
  });
  registerProjectIpc({ handle, fetchWithUi });
  registerAssetMediaIpc({
    handle,
    fetchWithUi,
    fetchBinaryWithUi,
    requireCore,
    restrictedMedia,
    mediaPresentation,
    getWindow: windowManager.getWindow,
    getLogPath,
    chooseAssetPath: windowManager.chooseAssetPath,
  });
  registerJobModelTranscriptIpc({ handle, fetchWithUi });
  registerPlanningProviderIpc({
    handle,
    fetchWithUi,
    saveSecret: async (providerConfigId, secret) => {
      await saveProviderSecret(runtimeManager.getProviderSecrets(), requireCore(), providerConfigId, secret);
    },
    deleteSecret: async providerConfigId => {
      await removeProviderSecret(runtimeManager.getProviderSecrets(), requireCore(), providerConfigId);
    },
    issueCandidateClipMedia,
    candidateMediaDependencies: {
      fetchPlan: candidatePlanId => fetchWithUi(`${API_PREFIX}/candidate-plans/${encodeURIComponent(candidatePlanId)}`),
      listProjectAssets: projectId => fetchWithUi(`${API_PREFIX}/projects/${projectId}/assets?limit=100`),
      issueAssetTicket: mediaPresentation.restrictedMediaUrl,
    },
  });
  registerAiEditingAnalysisIpc({ handle, fetchWithUi });
  registerTimelineIpc({ handle, fetchWithUi });
  // DESK-1/DESK-2：桌面设置（Main-only 持久化，不经 Core HTTP）+ 内核重启。
  registerSettingsIpc({
    handle,
    store: settingsStore,
    effective: runtimeManager.getStartRuntimeSettings,
    restartCore: runtimeManager.restartCore,
  });
  registerPreviewExportIpc({
    handle,
    fetchWithUi,
    requireCore,
    mediaPresentation,
    getWindow: windowManager.getWindow,
  });
  registerReframeExportIpc({ ipc, fetchWithUi, previewPresentation: mediaPresentation.renditionReframePreviewPresentation });
  registerMediaGenerationIpc({ ipc, fetchWithUi });
  registerShotListIpc({ ipc, fetchWithUi });
  registerImageGenerationIpc({ ipc, fetchWithUi, getAdmin: requireCore, secrets: runtimeManager.getImageProviderSecrets() });
  registerShotImageFulfillmentIpc({ ipc, fetchWithUi });
  registerShotTimelineAssemblyIpc({ ipc, fetchWithUi });
  registerShotTimelineBatchAssemblyIpc({ ipc, fetchWithUi });
  // B10：派生媒体 IPC + B11 preview-source IPC + B14 波形 IPC + B15 PCM 块
  // IPC——lookup/stats/描述/作业 (Renderer 可见) + media(admin resolve→票据)
  registerPerformanceIpc({
    ipc,
    fetchWithUi,
    resolveDerived: input => requireCore().resolveDerivedMedia(input),
    resolvePreviewSourceMedia: input => requireCore().resolvePreviewSourceMedia(input),
    resolveWaveformMedia: input => requireCore().resolveWaveformMedia(input),
    resolveFilmstripMedia: input => requireCore().resolveFilmstripMedia(input),
    resolvePcmChunkMedia: input => requireCore().resolvePcmChunkMedia(input),
    registerDerivedMedia: (cacheKey, path) => {
      if (!restrictedMedia.registeredPath(cacheKey, "proxy")) {
        restrictedMedia.register(cacheKey, path, "proxy");
      }
      return restrictedMedia.issue(cacheKey, "proxy");
    },
  });
}
