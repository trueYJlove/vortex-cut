import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const expose = vi.fn();
const on = vi.fn();
const removeListener = vi.fn();
const getPathForFile = vi.fn((file: File) => `C:\\sandbox\\${file.name}`);
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { invoke, on, removeListener },
  webUtils: { getPathForFile },
}));

await import("../electron/preload/index.js");

describe("Desktop preload 白名单", () => {
  it("仅暴露显式方法，并把 Stage2A 密钥和候选媒体调用路由到固定 IPC 通道", async () => {
    expect(expose).toHaveBeenCalledWith("desktop", expect.any(Object));
    const api = expose.mock.calls[0][1] as Record<string, (...args: unknown[]) => unknown>;
    expect(Object.keys(api)).not.toContain("ipcRenderer");
    expect(Object.keys(api)).not.toContain("adminToken");
    await api.setProviderSecret({ provider_config_id: "provider_1", secret: "test-secret" });
    await api.deleteProviderSecret("provider_1");
    await api.testCandidateProviderCapability("provider_1");
    await api.testTimelinePatchProviderCapability("provider_1");
    await api.getCandidateClipMedia({ project_id: "project_1", candidate_plan_id: "candidate_1", candidate_clip_id: "candidate_clip_1" });
    expect(invoke.mock.calls).toEqual([
      ["provider:set-secret", { provider_config_id: "provider_1", secret: "test-secret" }],
      ["provider:delete-secret", "provider_1"],
      ["planning:test-provider-capability", "provider_1"],
      ["planning-patch:test-provider-capability", "provider_1"],
      ["planning:clip-media", { project_id: "project_1", candidate_plan_id: "candidate_1", candidate_clip_id: "candidate_clip_1" }]
    ]);
  });

  it("Job 订阅使用固定派生 channel，且解除订阅会删除相同 listener", () => {
    const api = expose.mock.calls[0][1] as { subscribeJob(jobId: string, listener: (job: unknown) => void): () => void };
    const listener = vi.fn(); const stop = api.subscribeJob("job_1", listener);
    expect(on).toHaveBeenCalledWith("job:event:job_1", expect.any(Function));
    stop(); expect(removeListener).toHaveBeenCalledWith("job:event:job_1", expect.any(Function));
  });
  it("native File path is resolved only inside preload and never returned in import metadata", async () => {
    const api = expose.mock.calls[0][1] as { importDroppedAssets(input: { project_id: string; files: readonly File[] }): Promise<unknown> };
    const file = new File(["video"], "shot.mp4", { type: "video/mp4", lastModified: 10 });
    const response = { imported: [{ asset: { asset_id: "asset_1", display_name: "shot.mp4" }, media_url: "aivideo://media/asset_1", grant: { grant_id: "grant_1" } }], failures: [] };
    invoke.mockResolvedValueOnce(response);
    const result = await api.importDroppedAssets({ project_id: "project_1", files: [file] });
    expect(getPathForFile).toHaveBeenCalledWith(file);
    expect(invoke).toHaveBeenLastCalledWith("asset:import-dropped", {
      project_id: "project_1",
      files: [{ path: "C:\\sandbox\\shot.mp4", name: "shot.mp4", size: 5, type: "video/mp4", last_modified: 10 }],
    });
    expect(result).toEqual(response);
    expect(JSON.stringify(result)).not.toContain("C:\\sandbox");
  });
  it("完整显式 API 表面始终只经固定 IPC channel 调用", async () => {
    const api = expose.mock.calls[0][1] as Record<string, (...args: any[]) => unknown>;
    const calls: Array<[string, unknown[]]> = [
      ["getRuntime", []], ["chooseMedia", []], ["probeMedia", ["grant_1"]], ["listProjects", [{}]], ["createProject", [{}]], ["getProject", ["project_1"]], ["renameProject", [{}]], ["archiveProject", ["project_1"]], ["reopenProject", ["project_1"]],
      ["listAssets", [{}]], ["importAsset", [{}]], ["importDroppedAssets", [{ project_id: "project_1", files: [] }]], ["refreshAsset", ["asset_1"]], ["relocateAsset", [{}]], ["listJobs", [{}]], ["createJob", [{}]], ["getJob", ["job_1"]], ["cancelJob", ["job_1"]],
      ["listModels", [{}]], ["getModel", ["model_1"]], ["downloadModel", [{}]], ["getModelDownload", ["model_1"]], ["cancelModelDownload", ["model_1"]], ["createTranscription", [{}]], ["listTranscripts", ["asset_1"]], ["getTranscript", ["transcript_1"]],
      ["getBrief", ["project_1"]], ["putBrief", [{}]], ["listRecipes", []], ["listProviders", []], ["createProvider", [{}]], ["testProvider", ["provider_1"]], ["testCandidateProviderCapability", ["provider_1"]], ["preparePlanning", [{}]], ["createPlanning", [{}]], ["listCandidatePlans", ["project_1"]], ["adoptCandidatePlan", [{}]], ["prepareTimelinePatch", [{}]], ["testTimelinePatchProviderCapability", ["provider_1"]], ["createTimelinePatchGeneration", [{}]], ["getTimelinePatchGeneration", ["generation_1"]], ["listTimelinePatchProposals", ["project_1"]], ["getTimelinePatchProposal", ["proposal_1"]], ["applyTimelinePatchProposal", [{}]], ["compareTimelineRevisions", [{}]],
      ["createTimeline", [{}]], ["getTimeline", ["project_1"]], ["patchTimeline", [{}]], ["undoTimeline", [{}]], ["redoTimeline", [{}]], ["saveTimelineDraft", [{}]], ["deleteTimelineDraft", ["project_1"]], ["listTimelineRevisions", [{}]], ["getTimelineRevision", ["revision_1"]],
      ["createPreview", [{}]], ["listPreviews", [{}]], ["chooseExportDestination", ["project_1"]], ["renameExportDestination", [{ grant_id: "destination_1", file_name: "out.mp4" }]], ["createExport", [{}]], ["listExports", [{}]],
      ["listPlatformPresets", []], ["listRenditionPresets", []], ["createRenditionPreview", [{}]], ["listRenditionPreviews", [{}]], ["chooseExportDirectory", ["project_1"]], ["createExportBatch", [{}]], ["getExportBatch", ["batch_1"]], ["listExportBatches", [{}]], ["cancelExportBatch", ["batch_1"]], ["retryExportBatch", [{}]],
      ["createRenditionReframePreview", [{}]], ["listRenditionReframePreviews", [{}]], ["createReframeExportBatch", [{}]], ["getReframeExportBatch", ["reframe_batch_1"]], ["listReframeExportBatches", [{}]], ["cancelReframeExportBatch", ["reframe_batch_1"]], ["retryReframeExportBatch", [{}]],
      ["prepareMediaGeneration", [{}]], ["createMediaGeneration", [{}]], ["listMediaGenerationRequests", [{}]], ["getMediaGenerationRequest", ["generation_request_1"]], ["listMediaGenerationTasks", [{}]], ["retryMediaGenerationTask", ["generation_task_1"]], ["cancelMediaGenerationTask", ["generation_task_1"]],
      ["getShotList", ["project_1"]], ["listShotListRevisions", [{}]], ["getShotListRevision", ["revision_1"]], ["createShotListRevision", [{}]], ["confirmShotListRevision", [{}]],
      ["getShotRequirementImageFulfillment", [{}]], ["listShotRequirementImageFulfillmentLinks", [{}]], ["listShotRequirementImageFulfillmentAdoptions", [{}]], ["prepareShotRequirementImageFulfillment", [{}]], ["createShotRequirementImageFulfillment", [{}]], ["adoptShotRequirementImageFulfillment", [{}]],
      ["prepareShotRequirementTimelineAssembly", [{}]], ["applyShotRequirementTimelineAssembly", [{}]], ["getShotRequirementTimelineAssemblyPreview", [{}]], ["getShotRequirementTimelineAssembly", [{}]], ["listShotRequirementTimelineAssemblies", [{}]],
      ["getRenderArtifact", ["artifact_1"]], ["openArtifact", ["artifact_1"]], ["openArtifactFolder", ["artifact_1"]],
      ["lookupDerivedMedia", [{}]], ["derivedMediaStats", ["project_1"]], ["derivedMediaUrl", [{}]],
      ["getPreviewSource", [{}]], ["createPreviewSourceJob", [{}]], ["previewSourceMediaUrl", [{}]],
      ["getWaveform", [{}]], ["waveformMediaUrl", [{}]], ["ensureFilmstrip", [{ project_id: "", asset_id: "", step_ms: 1000, generate: false }]], ["filmstripMediaUrl", [{ project_id: "", asset_id: "", step_ms: 1000 }]],
      ["ensurePcmChunk", [{}]], ["pcmChunkMediaUrl", [{}]],
      ["getPreviewIrV2Manifest", [{}]], ["getPreviewIrV2Window", [{}]],
      ["updateEditorLoad", ["playing"]], ["diagnostics", []]
    ];
    for (const [name, args] of calls) await api[name](...args);
    expect(invoke).toHaveBeenCalledTimes(6 + calls.length);
    expect(invoke.mock.calls.every(([channel]) => typeof channel === "string" && !channel.includes("secret:get") && !channel.includes("admin"))).toBe(true);
  });
});
