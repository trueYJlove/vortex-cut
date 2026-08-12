import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const expose = vi.fn();
const on = vi.fn();
const removeListener = vi.fn();
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { invoke, on, removeListener }
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
    await api.getCandidateClipMedia({ project_id: "project_1", candidate_plan_id: "candidate_1", candidate_clip_id: "candidate_clip_1" });
    expect(invoke.mock.calls).toEqual([
      ["provider:set-secret", { provider_config_id: "provider_1", secret: "test-secret" }],
      ["provider:delete-secret", "provider_1"],
      ["planning:clip-media", { project_id: "project_1", candidate_plan_id: "candidate_1", candidate_clip_id: "candidate_clip_1" }]
    ]);
  });

  it("Job 订阅使用固定派生 channel，且解除订阅会删除相同 listener", () => {
    const api = expose.mock.calls[0][1] as { subscribeJob(jobId: string, listener: (job: unknown) => void): () => void };
    const listener = vi.fn(); const stop = api.subscribeJob("job_1", listener);
    expect(on).toHaveBeenCalledWith("job:event:job_1", expect.any(Function));
    stop(); expect(removeListener).toHaveBeenCalledWith("job:event:job_1", expect.any(Function));
  });
  it("完整显式 API 表面始终只经固定 IPC channel 调用", async () => {
    const api = expose.mock.calls[0][1] as Record<string, (...args: any[]) => unknown>;
    const calls: Array<[string, unknown[]]> = [
      ["getRuntime", []], ["chooseMedia", []], ["probeMedia", ["grant_1"]], ["listProjects", [{}]], ["createProject", [{}]], ["getProject", ["project_1"]], ["renameProject", [{}]], ["archiveProject", ["project_1"]], ["reopenProject", ["project_1"]],
      ["listAssets", [{}]], ["importAsset", [{}]], ["refreshAsset", ["asset_1"]], ["relocateAsset", [{}]], ["listJobs", [{}]], ["createJob", [{}]], ["getJob", ["job_1"]], ["cancelJob", ["job_1"]],
      ["listModels", [{}]], ["getModel", ["model_1"]], ["downloadModel", [{}]], ["getModelDownload", ["model_1"]], ["cancelModelDownload", ["model_1"]], ["createTranscription", [{}]], ["listTranscripts", ["asset_1"]], ["getTranscript", ["transcript_1"]],
      ["getBrief", ["project_1"]], ["putBrief", [{}]], ["listRecipes", []], ["listProviders", []], ["createProvider", [{}]], ["testProvider", ["provider_1"]], ["preparePlanning", [{}]], ["createPlanning", [{}]], ["listCandidatePlans", ["project_1"]], ["adoptCandidatePlan", [{}]],
      ["createTimeline", [{}]], ["getTimeline", ["project_1"]], ["patchTimeline", [{}]], ["undoTimeline", [{}]], ["redoTimeline", [{}]], ["saveTimelineDraft", [{}]], ["deleteTimelineDraft", ["project_1"]], ["listTimelineRevisions", [{}]], ["getTimelineRevision", ["revision_1"]],
      ["createPreview", [{}]], ["listPreviews", [{}]], ["chooseExportDestination", ["project_1"]], ["createExport", [{}]], ["listExports", [{}]], ["getRenderArtifact", ["artifact_1"]], ["openArtifact", ["artifact_1"]], ["openArtifactFolder", ["artifact_1"]], ["diagnostics", []]
    ];
    for (const [name, args] of calls) await api[name](...args);
    expect(invoke).toHaveBeenCalledTimes(3 + calls.length);
    expect(invoke.mock.calls.every(([channel]) => typeof channel === "string" && !channel.includes("secret:get") && !channel.includes("admin"))).toBe(true);
  });
});
