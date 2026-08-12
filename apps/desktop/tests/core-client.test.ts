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
    const document = { schema_version: 1, project_id: "project_1", canvas: { width: 1080, height: 1920, fps_num: 30, fps_den: 1, background_color: "#000000" }, tracks: [{ id: "V1", kind: "visual", locked: false }, { id: "C1", kind: "caption", locked: false }], clips: [], captions: [], provenance: { created_by: "user", source_transcript_ids: [] } };
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
});
