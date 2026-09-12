import { describe, expect, it, vi } from "vitest";
import { CoreClient } from "../src/lib/core-client.js";
import { CoreApiError, normalizeJob } from "../src/lib/core-client.js";
import type { JobId, ProjectId } from "@aivideo/contracts";

function response(body: unknown, ok = true, status = ok ? 200 : 500): Response { return { ok, status, json: async () => body } as Response; }

describe("CoreClient", () => {
  it("uses ui_token in HTTP and authenticate as the first WebSocket message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ job_id: "job_1", type: "proxy", status: "queued", stage: "queued", progress: 0 }));
    const socket = { send: vi.fn(), close: vi.fn(), onopen: undefined, onmessage: undefined, onerror: undefined, onclose: undefined } as unknown as WebSocket;
    const client = new CoreClient({ baseUrl: "http://127.0.0.1:4000", uiToken: "ui-secret", fetchImpl, webSocketFactory: () => socket });
    await client.getJob("job_1" as JobId);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ headers: { Authorization: "Bearer ui-secret" } });
    client.subscribe("job_1" as JobId, vi.fn());
    socket.onopen?.(new Event("open"));
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "authenticate", token: "ui-secret" }));
    expect(String(fetchImpl.mock.calls[0][0])).not.toContain("ui-secret");
  });
  it("falls back to polling after WebSocket failure and stops on unsubscribe", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(response({ job_id: "job_1", type: "proxy", status: "running", stage: "encode", progress: 0.5 }));
    const socket = { send: vi.fn(), close: vi.fn(), onopen: undefined, onmessage: undefined, onerror: undefined, onclose: undefined } as unknown as WebSocket;
    const listener = vi.fn();
    const client = new CoreClient({ baseUrl: "http://127.0.0.1:4000", uiToken: "ui-secret", fetchImpl, webSocketFactory: () => socket, pollIntervalMs: 10 });
    const unsubscribe = client.subscribe("job_1" as JobId, listener);
    socket.onerror?.(new Event("error"));
    await vi.advanceTimersByTimeAsync(10);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    expect(socket.close).toHaveBeenCalled();
    vi.useRealTimers();
  });
  it("covers Stage 1A project, asset and paged job endpoints", async () => {
    const project = { project_id: "project_1", name: "Demo", status: "active", canvas: { width: 1080, height: 1920, fps_num: 30, fps_den: 1 }, root_dir_name: "Demo", current_timeline_revision_id: null, created_at: "2026-08-09T00:00:00.000Z", updated_at: "2026-08-09T00:00:00.000Z", last_opened_at: "2026-08-09T00:00:00.000Z" };
    const asset = { asset_id: "asset_1", project_id: "project_1", kind: "text", storage_mode: "external", display_name: "notes.txt", fingerprint: "sha256:1", size_bytes: 3, modified_at: "2026-08-09T00:00:00.000Z", availability: "available", media_info: { format_name: "txt", duration_us: 0 }, created_at: "2026-08-09T00:00:00.000Z", updated_at: "2026-08-09T00:00:00.000Z" };
    const job = { job_id: "job_1", project_id: "project_1", kind: "asset_probe", status: "queued", stage: "queued", progress: 0, attempt: 1, input: { asset_id: "asset_1" }, error: null, created_at: "2026-08-09T00:00:00.000Z", updated_at: "2026-08-09T00:00:00.000Z", started_at: null, finished_at: null };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ items: [project], next_cursor: null }))
      .mockResolvedValueOnce(response(project))
      .mockResolvedValueOnce(response({ items: [asset], next_cursor: null }))
      .mockResolvedValueOnce(response({ items: [job], next_cursor: null }));
    const client = new CoreClient({ baseUrl: "http://127.0.0.1:4000", uiToken: "ui-secret", fetchImpl });
    await expect(client.listProjects()).resolves.toMatchObject({ items: [{ project_id: "project_1" }] });
    await expect(client.getProject("project_1" as ProjectId)).resolves.toMatchObject({ name: "Demo" });
    await expect(client.listAssets("project_1" as ProjectId)).resolves.toMatchObject({ items: [{ asset_id: "asset_1" }] });
    await expect(client.listJobs("project_1" as ProjectId)).resolves.toMatchObject({ items: [{ kind: "asset_probe" }] });
    expect(fetchImpl.mock.calls.map(call => String(call[0]))).toEqual([
      "http://127.0.0.1:4000/api/v1/projects",
      "http://127.0.0.1:4000/api/v1/projects/project_1",
      "http://127.0.0.1:4000/api/v1/projects/project_1/assets",
      "http://127.0.0.1:4000/api/v1/projects/project_1/jobs"
    ]);
  });
  it("normalizes legacy jobs without exposing paths", () => {
    const job = normalizeJob({ job_id: "job_1", type: "proxy", status: "queued", stage: "queued", progress: 0, input: { media_id: "media_1", path: "C:\\private\\clip.mp4" } });
    expect(job.kind).toBe("proxy");
    expect(job.input).not.toHaveProperty("path");
  });
  it("maps the frozen error envelope and HTTP statuses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ error: { code: "PROJECT_ARCHIVED", message: "archived", trace_id: "trace_1" } }, false, 409));
    const client = new CoreClient({ baseUrl: "http://127.0.0.1:4000", uiToken: "ui-secret", fetchImpl });
    await expect(client.getProject("project_1" as ProjectId)).rejects.toMatchObject({ status: 409, code: "PROJECT_ARCHIVED", traceId: "trace_1" });
  });
  it("covers real Stage 1B model and transcript endpoint shapes without exposing install paths", async () => {
    const hash = "a".repeat(64);
    const model = {
      model_id: "model_1", display_name: "Tiny", purpose: "ASR", provider: "faster-whisper", revision: "rev_1",
      supported_languages: ["auto", "zh", "en"], supports_word_timestamps: true, runtime_version: "1.0",
      model_size_bytes: 10, installed_size_bytes: 10, model_sha256: hash,
      license: { id: "mit", name: "MIT", url: null, attribution: null, acceptance_required: false },
      source: { kind: "trusted_manifest", display_name: "trusted", host: "example.test", url: "https://example.test/model" },
      requires_network: true, local_only: true, status: "unavailable", provider_status: "unavailable", progress: null,
      required_disk_bytes: 12, runtime_requirements: {}, files: [{ relative_path: "model.bin", size_bytes: 10, sha256: hash }],
      available_disk_bytes: 100, installed_path: "C:\\private\\model", install_dir: "C:\\private\\model"
    };
    const transcript = {
      transcript_id: "transcript_1", asset_id: "asset_1", status: "ready", language: "en", provider: "faster-whisper",
      model_id: "model_1", model_revision: "rev_1", source_media_fingerprint: "sha256:abc", duration_us: 1_000_000,
      segments: [{ segment_id: "segment_1", ordinal: 0, start_us: 0, end_us: 1_000_000, text: "hello", confidence: 1, words: null }],
      words: null, created_at: "2026-08-10T00:00:00.000Z", updated_at: "2026-08-10T00:00:00.000Z"
    };
    const job = { job_id: "job_1", project_id: "project_1", asset_id: "asset_1", kind: "transcription", status: "failed", stage: "failed", progress: 1, attempt: 1, model_id: "model_1", model_revision: "rev_1", input_fingerprint: "sha256:abc", input: { asset_id: "asset_1" }, error: { code: "TRANSCRIPTION_FAILED", message: "失败" }, created_at: "2026-08-10T00:00:00.000Z", updated_at: "2026-08-10T00:00:00.000Z", started_at: null, finished_at: "2026-08-10T00:00:00.000Z" };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ items: [model], next_cursor: null }))
      .mockResolvedValueOnce(response({ model, job }))
      .mockResolvedValueOnce(response({ items: [{ ...transcript, installed_path: "C:\\private\\model" }], next_cursor: null }))
      .mockResolvedValueOnce(response(transcript));
    const client = new CoreClient({ baseUrl: "http://127.0.0.1:4000", uiToken: "ui-secret", fetchImpl });
    await expect(client.listModels()).resolves.toMatchObject({ items: [{ model_id: "model_1" }] });
    await expect(client.downloadModel("model_1" as never, null)).resolves.toMatchObject({ job: { kind: "transcription" } });
    await expect(client.listTranscripts("asset_1" as never)).resolves.toMatchObject({ items: [{ transcript_id: "transcript_1" }] });
    await expect(client.getTranscript("transcript_1")).resolves.toMatchObject({ transcript_id: "transcript_1" });
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain("private\\model");
  });
  it("covers every frozen Timeline endpoint with base revisions and no sensitive fields", async () => {
    const now = "2026-08-11T00:00:00.000Z"; const hash = "a".repeat(64);
    const document = { schema_version: 1, project_id: "project_1", canvas: { width: 1080, height: 1920, fps_num: 30, fps_den: 1, background_color: "#000000" }, tracks: [{ id: "C1", kind: "text", locked: false, hidden: false, muted: false, solo: false }, { id: "V1", kind: "video", locked: false, hidden: false, muted: false, solo: false }, { id: "A1", kind: "audio", locked: false, hidden: false, muted: false, solo: false }], clips: [], captions: [], provenance: { created_by: "user", source_transcript_ids: [] } };
    const revision = { timeline_revision_id: "revision_1", project_id: "project_1", parent_revision_id: null, document_sha256: hash, summary: "创建空时间线", created_by: "user", created_at: now, schema_version: 1, document };
    const state = { project_id: "project_1", current_revision: revision, draft: null, can_undo: false, can_redo: false, current_preview: null };
    const draft = { project_id: "project_1", base_revision_id: "revision_1", document, updated_at: now, conflict: false };
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(state)).mockResolvedValueOnce(response(state)).mockResolvedValueOnce(response(state)).mockResolvedValueOnce(response(state)).mockResolvedValueOnce(response(state)).mockResolvedValueOnce(response(draft)).mockResolvedValueOnce(response(null)).mockResolvedValueOnce(response({ items: [{ ...revision, schema_version: undefined, document: undefined }], next_cursor: null })).mockResolvedValueOnce(response(revision));
    const client = new CoreClient({ baseUrl: "http://127.0.0.1:4000", uiToken: "ui-secret", fetchImpl });
    await client.createTimeline("project_1" as never, { schema_version: 1, source: { kind: "empty" }, default_layout: "fit", caption_preset_id: "default-bottom" }); await client.getTimeline("project_1" as never); await client.patchTimeline("project_1" as never, { schema_version: 1, base_revision_id: "revision_1" as never, operations: [{ op: "add_caption", start_us: 0, end_us: 200_000, text: "字幕", preset_id: "default-bottom", source_clip_id: null }], summary: "字幕" }); await client.undoTimeline("project_1" as never, "revision_1" as never); await client.redoTimeline("project_1" as never, "revision_1" as never); await client.saveTimelineDraft("project_1" as never, { schema_version: 1, base_revision_id: "revision_1" as never, document: document as never }); await client.deleteTimelineDraft("project_1" as never); await client.listTimelineRevisions("project_1" as never); await client.getTimelineRevision("revision_1" as never);
    expect(fetchImpl.mock.calls.map(call => [String(call[0]), (call[1] as RequestInit).method ?? "GET"])).toEqual([
      ["http://127.0.0.1:4000/api/v1/projects/project_1/timelines", "POST"], ["http://127.0.0.1:4000/api/v1/projects/project_1/timeline", "GET"], ["http://127.0.0.1:4000/api/v1/projects/project_1/timeline/patches", "POST"], ["http://127.0.0.1:4000/api/v1/projects/project_1/timeline/undo", "POST"], ["http://127.0.0.1:4000/api/v1/projects/project_1/timeline/redo", "POST"], ["http://127.0.0.1:4000/api/v1/projects/project_1/timeline/draft", "PUT"], ["http://127.0.0.1:4000/api/v1/projects/project_1/timeline/draft", "DELETE"], ["http://127.0.0.1:4000/api/v1/projects/project_1/timeline/revisions", "GET"], ["http://127.0.0.1:4000/api/v1/timeline-revisions/revision_1", "GET"]
    ]);
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain("private");
  });
  it("解析 Stage2B planning 接口并拒绝正文或多余字段", async () => {
    const now = "2026-08-12T00:00:00.000Z"; const hash = `sha256:${"a".repeat(64)}`;
    const preview = { timeline_patch_egress_preview_id: "preview_1", provider: { display_name: "Provider", origin: "https://provider.test", model: "model" }, prompt_template_version: "timeline-patch-v1", output_schema_version: "timeline-patch-output-v1", sent_fields: ["instruction"], payload_sha256: hash, character_count: 10, estimated_tokens: 3, clip_count: 1, caption_count: 0, locked_count: 0, expires_at: now, instruction: "must-strip" };
    const job = { job_id: "job_1", project_id: "project_1", asset_id: null, kind: "timeline_patch_generation", status: "queued", stage: "queued", progress: 0, attempt: 1, model_id: null, model_revision: null, input_fingerprint: null, input: {}, error: null, created_at: now, updated_at: now, started_at: null, finished_at: null };
    const generation = { timeline_patch_generation_id: "generation_1", project_id: "project_1", base_revision_id: "revision_1", base_document_sha256: hash, status: "succeeded", payload_sha256: hash, created_at: now, updated_at: now, finished_at: now };
    const diff = { schema_version: 1, project_id: "project_1", base_revision_id: "revision_1", target_revision_id: "revision_2", base_document_sha256: hash, target_document_sha256: hash, summary: { clip_changes: 0, caption_changes: 0, lock_changes: 0, transition_changes: 0 }, duration_delta_us: 0, clip_changes: [], caption_changes: [], lock_changes: [], indirect_locked_timing_shifts: [], transition_changes: [] };
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(preview)).mockResolvedValueOnce(response({ timeline_patch_generation_id: "generation_1", job })).mockResolvedValueOnce(response(generation)).mockResolvedValueOnce(response({ items: [] })).mockResolvedValueOnce(response(diff));
    const client = new CoreClient({ baseUrl: "http://127.0.0.1:4000", uiToken: "ui-secret", fetchImpl });
    await expect(client.prepareTimelinePatch("project_1" as never, { base_revision_id: "revision_1" as never, provider_config_id: "provider_1", instruction: "缩短" })).resolves.not.toHaveProperty("instruction");
    await expect(client.createTimelinePatchGeneration("project_1" as never, { timeline_patch_egress_preview_id: "preview_1", payload_sha256: hash })).resolves.toMatchObject({ job: { kind: "timeline_patch_generation" } });
    await expect(client.getTimelinePatchGeneration("generation_1")).resolves.toMatchObject({ status: "succeeded" });
    await expect(client.listTimelinePatchProposals("project_1" as never)).resolves.toEqual({ items: [] });
    await expect(client.compareTimelineRevisions("project_1" as never, { base_revision_id: "revision_1" as never, target_revision_id: "revision_2" as never })).resolves.toMatchObject({ target_revision_id: "revision_2" });
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain("must-strip");
  });
  it("调用固定的 AI 修改兼容性测试端点，并拒绝含正文的响应", async () => {
    const now = "2026-08-12T00:00:00.000Z"; const hash = `sha256:${"a".repeat(64)}`;
    const result = { timeline_patch_capability_status: "unsupported", timeline_patch_response_adapter_id: null, timeline_patch_probe_protocol_version: null, timeline_patch_capability_tested_at: now, timeline_patch_capability_failure_code: "PROVIDER_SCHEMA_MISMATCH", timeline_patch_capability_probe_sha256: hash, raw_response: "must-strip" };
    const fetchImpl = vi.fn().mockResolvedValue(response(result));
    const client = new CoreClient({ baseUrl: "http://127.0.0.1:4000", uiToken: "ui-secret", fetchImpl });
    await expect(client.testTimelinePatchProviderCapability("provider_1")).resolves.toMatchObject({ timeline_patch_capability_status: "unsupported", timeline_patch_capability_failure_code: "PROVIDER_SCHEMA_MISMATCH" });
    expect(String(fetchImpl.mock.calls[0][0])).toBe("http://127.0.0.1:4000/api/v1/providers/provider_1/timeline-patch-capability-test");
    expect((fetchImpl.mock.calls[0][1] as RequestInit).method).toBe("POST"); expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain("must-strip");
  });
  it("uses independent Stage 3B Reframe endpoints and strict sanitized parsers", async () => {
    const now = "2026-08-18T00:00:00.000Z"; const hash = "a".repeat(64);
    const mediaInfo = { duration_us: 1_000_000, format_name: "mp4", video: { codec: "h264", width: 1080, height: 1920, pixel_format: "yuv420p", fps_num: 30, fps_den: 1 }, audio: { codec: "aac", sample_rate: 48000, channels: 2 } };
    const preview = { rendition_reframe_snapshot_id: "rendition_reframe_snapshot_1", project_id: "project_1", timeline_revision_id: "revision_1", base_rendition_snapshot_id: "rendition_snapshot_1", base_snapshot_sha256: hash, platform_preset_id: "douyin", rendition_preset_id: "portrait-9x16-v1", adjustment_count: 1, reframe_snapshot_sha256: hash, warnings: ["STATIC_REFRAME_APPLIED"], created_at: now, render_artifact_id: "artifact_1", status: "ready", profile_id: "preview-portrait-9x16-v1", display_name: "preview.mp4", size_bytes: 10, sha256: hash, media_info: mediaInfo, encoder: "libx264", fallback_reason: null };
    const item = { reframe_export_batch_item_id: "reframe_export_batch_item_1", ordinal: 0, rendition_reframe_snapshot: Object.fromEntries(Object.entries(preview).filter(([key]) => !["render_artifact_id", "status", "profile_id", "display_name", "size_bytes", "sha256", "media_info", "encoder", "fallback_reason"].includes(key))), preview_artifact_id: "artifact_1", status: "queued", progress: 0, job_id: "job_1", destination_display_name: null, error_code: null, export_record_id: null, retry_of_item_id: null };
    const batch = { reframe_export_batch_id: "reframe_export_batch_1", project_id: "project_1", timeline_revision_id: "revision_1", status: "queued", directory_display_name: "Exports", items: [item], retry_of_batch_id: null, created_at: now, updated_at: now };
    const job = { job_id: "job_1", project_id: "project_1", asset_id: null, kind: "final_export", status: "queued", stage: "queued", progress: 0, attempt: 1, model_id: null, model_revision: null, input_fingerprint: null, input: {}, error: null, created_at: now, updated_at: now, started_at: null, finished_at: null };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ job: null, preview: { ...preview, path: "C:\\private\\preview.mp4" }, reused: true }))
      .mockResolvedValueOnce(response({ items: [{ ...preview, uri: "file:///private.mp4" }], next_cursor: null }))
      .mockResolvedValueOnce(response({ batch, jobs: [job] }))
      .mockResolvedValueOnce(response(batch)).mockResolvedValueOnce(response({ items: [batch], next_cursor: null }))
      .mockResolvedValueOnce(response(batch)).mockResolvedValueOnce(response({ batch, jobs: [job] }));
    const client = new CoreClient({ baseUrl: "http://127.0.0.1:4000", uiToken: "ui-secret", fetchImpl });
    const createdPreview = await client.createRenditionReframePreview("project_1" as never, { base_rendition_snapshot_id: "rendition_snapshot_1" as never, adjustments: [{ clip_id: "clip_1" as never, horizontal_anchor: "left", vertical_anchor: "top" }] });
    expect(createdPreview).toMatchObject({ reused: true, preview: { rendition_reframe_snapshot_id: "rendition_reframe_snapshot_1" } });
    expect(createdPreview.preview).not.toHaveProperty("path");
    const listedPreviews = await client.listRenditionReframePreviews("project_1" as never);
    expect(listedPreviews).toMatchObject({ items: [{ render_artifact_id: "artifact_1" }] });
    expect(listedPreviews.items[0]).not.toHaveProperty("uri");
    await expect(client.createReframeExportBatch("project_1" as never, { directory_grant_id: "directory_1" as never, items: [{ rendition_reframe_snapshot_id: "rendition_reframe_snapshot_1" as never, preview_artifact_id: "artifact_1" as never }] })).resolves.toMatchObject({ batch: { reframe_export_batch_id: "reframe_export_batch_1" } });
    await expect(client.getReframeExportBatch("reframe_export_batch_1")).resolves.toMatchObject({ status: "queued" });
    await expect(client.listReframeExportBatches("project_1" as never)).resolves.toMatchObject({ items: [{ reframe_export_batch_id: "reframe_export_batch_1" }] });
    await expect(client.cancelReframeExportBatch("reframe_export_batch_1")).resolves.toMatchObject({ status: "queued" });
    await expect(client.retryReframeExportBatch("reframe_export_batch_1", { directory_grant_id: "directory_2" as never, reframe_export_batch_item_ids: ["reframe_export_batch_item_1" as never] })).resolves.toMatchObject({ jobs: [{ kind: "final_export" }] });
    expect(fetchImpl.mock.calls.map(call => String(call[0]))).toEqual([
      "http://127.0.0.1:4000/api/v1/projects/project_1/rendition-reframe-previews", "http://127.0.0.1:4000/api/v1/projects/project_1/rendition-reframe-previews", "http://127.0.0.1:4000/api/v1/projects/project_1/reframe-export-batches", "http://127.0.0.1:4000/api/v1/reframe-export-batches/reframe_export_batch_1", "http://127.0.0.1:4000/api/v1/projects/project_1/reframe-export-batches", "http://127.0.0.1:4000/api/v1/reframe-export-batches/reframe_export_batch_1/cancel", "http://127.0.0.1:4000/api/v1/reframe-export-batches/reframe_export_batch_1/retry"
    ]);
  });
  it("covers every frozen Render endpoint and strips sensitive response fields", async () => {
    const now = "2026-08-11T00:00:00.000Z"; const hash = "a".repeat(64);
    const mediaInfo = { duration_us: 1_000_000, format_name: "mp4", video: { codec: "h264", width: 1080, height: 1920, pixel_format: "yuv420p", fps_num: 30, fps_den: 1 }, audio: null };
    const preview = { render_artifact_id: "render_1", project_id: "project_1", timeline_revision_id: "revision_1", kind: "authoritative_preview", status: "ready", content_fingerprint: hash, profile_id: "preview-portrait-v1", display_name: "preview.mp4", size_bytes: 10, sha256: hash, media_info: mediaInfo, encoder: "libx264", fallback_reason: null, created_at: now };
    const exportRecord = { export_record_id: "export_1", project_id: "project_1", timeline_revision_id: "revision_1", render_artifact_id: "render_2", status: "succeeded", profile_id: "export-portrait-v1", destination_display_name: "video.mp4", size_bytes: 10, sha256: hash, media_info: mediaInfo, encoder: "libx264", fallback_reason: "hardware unavailable", created_at: now };
    const exportJob = { job_id: "job_1", project_id: "project_1", asset_id: null, kind: "final_export", status: "queued", stage: "queued", progress: 0, attempt: 1, model_id: null, model_revision: null, input_fingerprint: null, input: {}, error: null, created_at: now, updated_at: now, started_at: null, finished_at: null };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ job: null, preview: { ...preview, path: "C:\\private\\preview.mp4" }, reused: true }))
      .mockResolvedValueOnce(response({ items: [{ ...preview, uri: "file:///private.mp4" }], next_cursor: null }))
      .mockResolvedValueOnce(response({ job: exportJob, export_record: null }))
      .mockResolvedValueOnce(response({ items: [{ ...exportRecord, path: "C:\\private\\video.mp4" }], next_cursor: null }))
      .mockResolvedValueOnce(response({ ...preview, kind: "final_export", profile_id: "export-portrait-v1", path: "C:\\private\\export.mp4" }));
    const client = new CoreClient({ baseUrl: "http://127.0.0.1:4000", uiToken: "ui-secret", fetchImpl });
    await expect(client.createPreview("project_1" as never, { timeline_revision_id: "revision_1" as never, encoder_mode: "auto" })).resolves.toMatchObject({ reused: true, preview: { render_artifact_id: "render_1" } });
    await expect(client.listPreviews("project_1" as never)).resolves.toMatchObject({ items: [{ display_name: "preview.mp4" }] });
    await expect(client.createExport("project_1" as never, { timeline_revision_id: "revision_1" as never, destination_grant_id: "destination_1" as never, encoder_mode: "software" })).resolves.toMatchObject({ job: { kind: "final_export" }, export_record: null });
    await expect(client.listExports("project_1" as never)).resolves.toMatchObject({ items: [{ destination_display_name: "video.mp4" }] });
    await expect(client.getRenderArtifact("render_2" as never)).resolves.toMatchObject({ kind: "final_export" });
    expect(fetchImpl.mock.calls.map(call => String(call[0]))).toEqual([
      "http://127.0.0.1:4000/api/v1/projects/project_1/previews", "http://127.0.0.1:4000/api/v1/projects/project_1/previews", "http://127.0.0.1:4000/api/v1/projects/project_1/exports", "http://127.0.0.1:4000/api/v1/projects/project_1/exports", "http://127.0.0.1:4000/api/v1/render-artifacts/render_2"
    ]);
  });
  it("实现 Stage 4A 七个窄 API，Prompt 只存在于出站命令且终端动作发送空对象", async () => {
    const now = "2026-08-18T00:00:00.000Z"; const hash = `sha256:${"a".repeat(64)}`;
    const request = { request_id: "generation_request_1", project_id: "project_1", generation_kind: "image", execution_mode: "simulation_only", prompt_sha256: hash, input_refs: ["asset_1"], parameters: { width: 1024, height: 1024 }, request_sha256: hash, created_at: now };
    const task = { task_id: "generation_task_1", request_id: "generation_request_1", job_id: "job_1", attempt: 1, status: "queued", stage: "queued", retry_of_task_id: null, output_asset_id: null, output_sha256: null, result_summary: null, error: null, created_at: now, updated_at: now, finished_at: null };
    const prepared = { schema_version: 1, project_id: "project_1", generation_kind: "image", execution_mode: "simulation_only", prompt_sha256: hash, input_refs: ["asset_1"], parameters: { width: 1024, height: 1024 }, request_sha256: hash };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(prepared))
      .mockResolvedValueOnce(response({ request, task, reused: false }))
      .mockResolvedValueOnce(response({ items: [request], next_cursor: null }))
      .mockResolvedValueOnce(response(request))
      .mockResolvedValueOnce(response({ items: [task], next_cursor: null }))
      .mockResolvedValueOnce(response({ ...task, attempt: 2, task_id: "generation_task_2", job_id: "job_2", retry_of_task_id: "generation_task_1" }))
      .mockResolvedValueOnce(response({ ...task, status: "cancelled", stage: "cancelled", finished_at: now }));
    const client = new CoreClient({ baseUrl: "http://127.0.0.1:4000", uiToken: "ui-secret", fetchImpl });
    const command = { generation_kind: "image" as const, prompt: "prompt-sentinel", input_refs: ["asset_1"], parameters: { width: 1024, height: 1024 } };
    await client.prepareMediaGeneration("project_1" as never, command);
    await client.createMediaGeneration("project_1" as never, { ...command, request_sha256: hash });
    await client.listMediaGenerationRequests("project_1" as never, { limit: 20, cursor: "0" });
    await client.getMediaGenerationRequest("generation_request_1" as never);
    await client.listMediaGenerationTasks("generation_request_1" as never, { limit: 10 });
    await client.retryMediaGenerationTask("generation_task_1" as never);
    await client.cancelMediaGenerationTask("generation_task_1" as never);
    expect(fetchImpl.mock.calls.map(call => String(call[0]))).toEqual([
      "http://127.0.0.1:4000/api/v1/projects/project_1/media-generation-requests/prepare",
      "http://127.0.0.1:4000/api/v1/projects/project_1/media-generation-requests",
      "http://127.0.0.1:4000/api/v1/projects/project_1/media-generation-requests?limit=20&cursor=0",
      "http://127.0.0.1:4000/api/v1/media-generation-requests/generation_request_1",
      "http://127.0.0.1:4000/api/v1/media-generation-requests/generation_request_1/tasks?limit=10",
      "http://127.0.0.1:4000/api/v1/media-generation-tasks/generation_task_1/retry",
      "http://127.0.0.1:4000/api/v1/media-generation-tasks/generation_task_1/cancel"
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body))).toMatchObject({ prompt: "prompt-sentinel" });
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1].body))).toMatchObject({ prompt: "prompt-sentinel", request_sha256: hash });
    expect(fetchImpl.mock.calls.slice(2).map(call => String(call[1]?.body ?? ""))).not.toContain("prompt-sentinel");
    expect(fetchImpl.mock.calls.slice(5).map(call => call[1]?.body)).toEqual(["{}", "{}"]);
  });

  it("Stage 4A 响应先清理敏感字段再执行严格解析", async () => {
    const hash = `sha256:${"a".repeat(64)}`;
    const safe = { schema_version: 1, project_id: "project_1", generation_kind: "image", execution_mode: "simulation_only", prompt_sha256: hash, input_refs: ["asset_1"], parameters: { width: 1024, height: 1024 }, request_sha256: hash };
    const fetchImpl = vi.fn().mockResolvedValue(response({ ...safe, prompt: "must-not-return", absolute_path: "private", traceback: "private" }));
    const client = new CoreClient({ baseUrl: "http://127.0.0.1:4000", uiToken: "ui-secret", fetchImpl });
    const result = await client.prepareMediaGeneration("project_1" as never, { generation_kind: "image", prompt: "input-only", input_refs: ["asset_1"], parameters: { width: 1024, height: 1024 } });
    expect(JSON.stringify(result)).not.toContain("must-not-return");
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("实现 Stage 4C 五个固定 API，并在解析前清理路径但拒绝未知输出", async () => {
    const now = "2026-08-18T00:00:00.000Z"; const hash = `sha256:${"c".repeat(64)}`;
    const summary = { schema_version: 1, shot_list_revision_id: "revision_1", shot_list_id: "shot_list_1", project_id: "project_1", parent_revision_id: null, title: "清单", requirement_count: 1, document_sha256: hash, created_at: now };
    const detail = { ...summary, summary: "人工摘要", requirements: [{ shot_requirement_id: "requirement_1", shot_list_revision_id: "revision_1", ordinal: 0, title: "镜头", visual_direction: "固定机位", target_duration_us: null, visual: { requirement_kind: "image", source_asset_id: null }, narration: null }] };
    const state = { shot_list_id: "shot_list_1", project_id: "project_1", lifecycle: "drafted", current_revision: detail, confirmed_revision: null };
    const input = { schema_version: 1 as const, base_revision_id: null, title: "清单", summary: "人工摘要", requirements: [{ title: "镜头", visual_direction: "固定机位", target_duration_us: null, visual: { requirement_kind: "image" as const, source_asset_id: null }, narration: null }] };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ ...state, absolute_path: "private" }))
      .mockResolvedValueOnce(response({ items: [summary], next_cursor: null }))
      .mockResolvedValueOnce(response(detail))
      .mockResolvedValueOnce(response({ revision: detail, state, reused: false }))
      .mockResolvedValueOnce(response({ state: { ...state, lifecycle: "confirmed", confirmed_revision: summary }, reused: false }));
    const client = new CoreClient({ baseUrl: "http://127.0.0.1:4000", uiToken: "ui-secret", fetchImpl });
    expect(JSON.stringify(await client.getShotList("project_1" as never))).not.toContain("private");
    await client.listShotListRevisions("project_1" as never, { limit: 20, cursor: "0" });
    await client.getShotListRevision("revision_1" as never);
    await client.createShotListRevision("project_1" as never, input);
    await client.confirmShotListRevision("project_1" as never, { revision_id: "revision_1" as never, expected_current_revision_id: "revision_1" as never });
    expect(fetchImpl.mock.calls.map(call => String(call[0]))).toEqual([
      "http://127.0.0.1:4000/api/v1/projects/project_1/shot-list",
      "http://127.0.0.1:4000/api/v1/projects/project_1/shot-list/revisions?limit=20&cursor=0",
      "http://127.0.0.1:4000/api/v1/shot-list-revisions/revision_1",
      "http://127.0.0.1:4000/api/v1/projects/project_1/shot-list/revisions",
      "http://127.0.0.1:4000/api/v1/projects/project_1/shot-list/confirm",
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[3][1].body))).toEqual(input);
  });

  it("实现 Stage 4E 六个固定 API，Prompt 只进入 Prepare 且响应先清敏", async () => {
    const now = "2026-08-20T00:00:00.000Z";
    const hashA = `sha256:${"a".repeat(64)}`; const hashB = `sha256:${"b".repeat(64)}`;
    const provider = { provider_config_id: "image_provider_1", provider_kind: "apikey_fun_images", adapter_id: "apikey_fun_images_sse_v1", model: "gpt-image-2" };
    const preview = { preview_id: "fulfillment_preview_1", project_id: "project_1", shot_list_revision_id: "revision_1", shot_requirement_id: "requirement_1", requirement_sha256: hashA, fulfillment_payload_sha256: hashB, execution_mode: "provider_image_v1", prompt_sha256: hashA, size: "1024x1024", output_format: "png", image_count: 1, provider, estimated_cost: 0.1, estimated_cost_currency: "CNY", price_tier: "1K", expires_at: now };
    const link = { link_id: "link_1", project_id: "project_1", shot_list_revision_id: "revision_1", shot_requirement_id: "requirement_1", request_id: "request_1", requirement_sha256: hashA, created_at: now };
    const adoption = { adoption_id: "adoption_1", project_id: "project_1", shot_list_revision_id: "revision_1", shot_requirement_id: "requirement_1", generation_link_id: "link_1", task_id: "task_1", asset_id: "asset_1", adoption_ordinal: 1, previous_adoption_id: null, created_at: now };
    const state = { project_id: "project_1", shot_list_revision_id: "revision_1", shot_requirement_id: "requirement_1", requirement_sha256: hashA, currently_confirmed: true, lifecycle: "unstarted", link_count: 0, current_adoption: null, current_asset_availability: null };
    const request = { request_id: "request_1", project_id: "project_1", generation_kind: "image", execution_mode: "provider_image_v1", prompt_sha256: hashA, parameters: { size: "1024x1024" }, request_sha256: hashB, created_at: now };
    const task = { task_id: "task_1", request_id: "request_1", job_id: "job_1", attempt: 1, status: "queued", stage: "queued", retry_of_task_id: null, provider_call_count: 0, provider_may_have_processed: false, estimated_cost: 0.1, estimated_cost_currency: "CNY", price_tier: "1K", output_asset_id: null, output_sha256: null, result_summary: null, error: null, created_at: now, updated_at: now, finished_at: null };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ ...state, absolute_path: "private" }))
      .mockResolvedValueOnce(response({ items: [link], next_cursor: null }))
      .mockResolvedValueOnce(response({ items: [adoption], next_cursor: null }))
      .mockResolvedValueOnce(response({ ...preview, prompt: "must-not-return", raw_exception: "private" }))
      .mockResolvedValueOnce(response({ link, request, task, generation_reused: false, link_reused: false }))
      .mockResolvedValueOnce(response({ adoption, reused: false }));
    const client = new CoreClient({ baseUrl: "http://127.0.0.1:4000", uiToken: "ui-secret", fetchImpl });
    const projectId = "project_1" as never; const requirementId = "requirement_1" as never;
    expect(JSON.stringify(await client.getShotRequirementImageFulfillment(projectId, requirementId))).not.toContain("private");
    await client.listShotRequirementImageFulfillmentLinks(projectId, requirementId, { limit: 20, cursor: "0" });
    await client.listShotRequirementImageFulfillmentAdoptions(projectId, requirementId);
    const prepared = await client.prepareShotRequirementImageFulfillment(projectId, requirementId, { expected_confirmed_revision_id: "revision_1" as never, provider_config_id: "image_provider_1" as never, prompt: "PROMPT_SENTINEL" });
    expect(JSON.stringify(prepared)).not.toContain("must-not-return");
    await client.createShotRequirementImageFulfillment(projectId, requirementId, { preview_id: "fulfillment_preview_1" as never, fulfillment_payload_sha256: hashB, expected_confirmed_revision_id: "revision_1" as never, confirmed: true });
    await client.adoptShotRequirementImageFulfillment(projectId, requirementId, { generation_link_id: "link_1" as never, task_id: "task_1" as never, asset_id: "asset_1" as never, expected_current_adoption_id: null, confirmed: true });
    expect(fetchImpl.mock.calls.map(call => String(call[0]))).toEqual([
      "http://127.0.0.1:4000/api/v1/projects/project_1/shot-requirements/requirement_1/image-fulfillment",
      "http://127.0.0.1:4000/api/v1/projects/project_1/shot-requirements/requirement_1/image-fulfillment/links?limit=20&cursor=0",
      "http://127.0.0.1:4000/api/v1/projects/project_1/shot-requirements/requirement_1/image-fulfillment/adoptions",
      "http://127.0.0.1:4000/api/v1/projects/project_1/shot-requirements/requirement_1/image-fulfillment/prepare",
      "http://127.0.0.1:4000/api/v1/projects/project_1/shot-requirements/requirement_1/image-fulfillment/create",
      "http://127.0.0.1:4000/api/v1/projects/project_1/shot-requirements/requirement_1/image-fulfillment/adopt",
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[3][1].body))).toHaveProperty("prompt", "PROMPT_SENTINEL");
    expect(fetchImpl.mock.calls.slice(4).map(call => String(call[1].body))).not.toContain("PROMPT_SENTINEL");
  });
});
