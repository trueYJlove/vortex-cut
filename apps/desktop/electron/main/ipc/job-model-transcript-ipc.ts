import type { JobId, ModelId, ProjectId, TranscriptId } from "@aivideo/contracts";
import { normalizeJob } from "../../../src/lib/core-client.js";
import {
  API_PREFIX,
  asId,
  buildQuery,
  modelDetail,
  modelSummary,
  transcript,
  transcriptSummary,
  type FetchWithUi,
  type IpcHandle,
} from "./shared.js";

export interface JobModelTranscriptIpcDependencies {
  handle: IpcHandle;
  fetchWithUi: FetchWithUi;
}

/** Register background job, ASR model download, and transcript IPC handlers. */
export function registerJobModelTranscriptIpc({ handle, fetchWithUi }: JobModelTranscriptIpcDependencies): void {
  handle("job:list", async (_event, input: { project_id: ProjectId; status?: string; limit?: number; cursor?: string }) => {
    const page = await fetchWithUi<{ items: unknown[]; next_cursor: string | null }>(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}/jobs${buildQuery(input, ["project_id"])}`);
    return { next_cursor: page.next_cursor, items: page.items.map(normalizeJob) };
  });
  handle("job:create", async (_event, input: { project_id: ProjectId; media_id: string; kind: string; encoder_mode?: string; start_us?: number; duration_us?: number; layout?: string }) => {
    const projectId = asId(input.project_id, "project_id") as ProjectId;
    if (input.kind !== "proxy" && input.kind !== "portrait_sample") throw new Error("Invalid job kind");
    const mediaId = asId(input.media_id, "media_id");
    const path = input.kind === "proxy" ? "/api/v1/jobs/proxy" : "/api/v1/jobs/vertical-sample";
    const body = input.kind === "proxy"
      ? { media_id: mediaId, project_id: projectId, encoder_mode: input.encoder_mode ?? "auto" }
      : { media_id: mediaId, project_id: projectId, encoder_mode: input.encoder_mode ?? "auto", start_us: input.start_us ?? 0, duration_us: input.duration_us ?? 10_000_000, layout: input.layout ?? "blurred_background" };
    return fetchWithUi<unknown>(path, { method: "POST", body: JSON.stringify(body) }).then(normalizeJob);
  });
  handle("job:get", (_event, jobId: JobId) => fetchWithUi<unknown>(`/api/v1/jobs/${asId(jobId, "job_id")}`).then(normalizeJob));
  handle("job:cancel", (_event, jobId: JobId) => fetchWithUi<unknown>(`/api/v1/jobs/${asId(jobId, "job_id")}/cancel`, { method: "POST" }).then(normalizeJob));
  // 已结束任务可从列表移除（历史清理）；运行中/排队中由 Core 拒绝。
  handle("job:delete", async (_event, jobId: JobId) => {
    await fetchWithUi<unknown>(`/api/v1/jobs/${asId(jobId, "job_id")}`, { method: "DELETE" });
  });

  handle("model:list", async (_event, params: { status?: string; limit?: number; cursor?: string } = {}) => {
    const page = await fetchWithUi<{ items: unknown[]; next_cursor: string | null }>(`${API_PREFIX}/models${buildQuery(params)}`);
    return { next_cursor: page.next_cursor ?? null, items: page.items.map(modelSummary) };
  });
  handle("model:get", (_event, modelId: ModelId) => fetchWithUi<unknown>(`${API_PREFIX}/models/${encodeURIComponent(asId(modelId, "model_id"))}`).then(modelDetail));
  handle("model:download", async (_event, input: { model_id: ModelId; license_acceptance: string | null }) => {
    const modelId = asId(input.model_id, "model_id");
    if (!(input.license_acceptance === null || typeof input.license_acceptance === "string")) throw new Error("Invalid license acceptance");
    const result = await fetchWithUi<{ model: unknown; job: unknown }>(`${API_PREFIX}/models/${encodeURIComponent(modelId)}/download`, {
      method: "POST", body: JSON.stringify({ license_acceptance: input.license_acceptance }),
    });
    return { model: modelDetail(result.model), job: normalizeJob(result.job) };
  });
  handle("model:download-status", async (_event, modelId: ModelId) => {
    const result = await fetchWithUi<{ model: unknown; job: unknown | null }>(`${API_PREFIX}/models/${encodeURIComponent(asId(modelId, "model_id"))}/download`);
    return { model: modelDetail(result.model), job: result.job === null ? null : normalizeJob(result.job) };
  });
  handle("model:cancel", async (_event, modelId: ModelId) => {
    const result = await fetchWithUi<{ model: unknown; job: unknown }>(`${API_PREFIX}/models/${encodeURIComponent(asId(modelId, "model_id"))}/cancel`, { method: "POST" });
    return { model: modelDetail(result.model), job: normalizeJob(result.job) };
  });
  handle("transcription:create", async (_event, input: { asset_id: string; model_id: string; language: string; word_timestamps: boolean; license_acceptance: string | null }) => {
    const assetId = asId(input.asset_id, "asset_id");
    const modelId = asId(input.model_id, "model_id");
    if (typeof input.language !== "string" || input.language.length === 0 || typeof input.word_timestamps !== "boolean" || !(input.license_acceptance === null || typeof input.license_acceptance === "string")) throw new Error("Invalid transcription input");
    const result = await fetchWithUi<{ job: unknown; transcript: unknown | null }>(`${API_PREFIX}/assets/${encodeURIComponent(assetId)}/transcription`, {
      method: "POST", body: JSON.stringify({ model_id: modelId, language: input.language, word_timestamps: input.word_timestamps, license_acceptance: input.license_acceptance }),
    });
    return { job: normalizeJob(result.job), transcript: result.transcript === null ? null : transcript(result.transcript) };
  });
  handle("transcription:list", async (_event, assetId: string) => {
    const page = await fetchWithUi<{ items: unknown[]; next_cursor: string | null }>(`${API_PREFIX}/assets/${encodeURIComponent(asId(assetId, "asset_id"))}/transcription`);
    return { next_cursor: page.next_cursor ?? null, items: page.items.map(transcriptSummary) };
  });
  handle("transcript:get", (_event, transcriptId: TranscriptId) => fetchWithUi<unknown>(`${API_PREFIX}/transcriptions/${encodeURIComponent(asId(transcriptId, "transcript_id"))}`).then(transcript));
  // 删除转录；仍被时间线字幕引用时由 Core 拒绝（TRANSCRIPTION_IN_USE）。
  handle("transcript:delete", async (_event, transcriptId: TranscriptId) => {
    await fetchWithUi<unknown>(`${API_PREFIX}/transcriptions/${encodeURIComponent(asId(transcriptId, "transcript_id"))}`, { method: "DELETE" });
  });
}
