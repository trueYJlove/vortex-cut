import { describe, expect, it } from "vitest";
import { CONTRACT_VERSION, ERROR_CODES, isApiErrorResponse, isAuthoritativePreview, isCaptionPresetId, isCandidateGeneration, isDestinationGrant, isExportCreateInput, isExportRecord, isFileGrant, isInternalModelManifest, isJobKind, isJobStatus, isModelDetail, isPreviewCreateResponse, isProject, isProviderConfig, isRecipe, isRenderArtifact, isSidecarReady, isTimelineCreateInput, isTimelineDocument, isTimelineLayout, isTimelinePatch, isTimelinePatchOperation, isTimelineState, isTranscript, parseSidecarReadyLine } from "@aivideo/contracts";

const now = "2026-08-11T00:00:00.000Z";

describe("Stage 0 contract", () => {
  it("accepts exactly the AIVS_READY payload", () => {
    expect(parseSidecarReadyLine('AIVS_READY {"protocol_version":1,"port":43123,"pid":99,"build_version":"0.0.1"}')).toEqual({ protocol_version: 1, port: 43123, pid: 99, build_version: "0.0.1" });
    expect(isSidecarReady({ protocol_version: 2, port: 43123, pid: 99, build_version: "0.0.1" })).toBe(false);
  });
  it("keeps the task state vocabulary closed", () => {
    expect(isJobStatus("interrupted")).toBe(true);
    expect(isJobStatus("retry_wait")).toBe(false);
  });
  it("validates Stage 1A DTOs and the frozen error envelope", () => {
    expect(isFileGrant({ grant_id: "grant_1", display_name: "clip.mp4", size_bytes: 12, modified_at: "2026-08-09T00:00:00.000Z", expires_at: "2026-08-09T01:00:00.000Z" })).toBe(true);
    expect(isFileGrant({ grant_id: "grant_1", display_name: "clip.mp4", size_bytes: 12, modified_at: "2026-08-09T00:00:00.000Z" })).toBe(false);
    expect(isProject({ project_id: "project_1", name: "Demo", status: "active", canvas: { width: 1080, height: 1920, fps_num: 30, fps_den: 1 }, root_dir_name: "Demo", current_timeline_revision_id: null, created_at: "2026-08-09T00:00:00.000Z", updated_at: "2026-08-09T00:00:00.000Z", last_opened_at: "2026-08-09T00:00:00.000Z" })).toBe(true);
    expect(isApiErrorResponse({ error: { code: "PROJECT_NOT_FOUND", message: "missing", trace_id: "trace_1" } })).toBe(true);
    expect(isApiErrorResponse({ error: { code: "PROJECT_NOT_FOUND", message: "missing" } })).toBe(false);
  });
  it("separates internal manifests from renderer model details", () => {
    const hash = "a".repeat(64);
    expect(isInternalModelManifest({
      model_id: "model_1", provider: "faster-whisper", revision: "rev_1", display_name: "Tiny", purpose: "ASR",
      download_url: "https://example.test/model", trusted_source_id: "trusted", size_bytes: 10, installed_size_bytes: 10,
      sha256: hash, license: { id: "mit", name: "MIT", url: null, attribution: null, acceptance_required: false },
      supported_languages: ["auto", "zh", "en"], supports_word_timestamps: true, runtime_version: "1.0",
      runtime_requirements: {}, files: [{ path: "model.bin", size_bytes: 10, sha256: hash }], installed_path: "C:\\private\\model",
      created_at: "2026-08-10T00:00:00.000Z"
    })).toBe(true);
    expect(isModelDetail({
      model_id: "model_1", display_name: "Tiny", purpose: "ASR", provider: "faster-whisper", revision: "rev_1",
      supported_languages: ["auto", "zh", "en"], supports_word_timestamps: true, runtime_version: "1.0",
      model_size_bytes: 10, installed_size_bytes: 10, model_sha256: hash,
      license: { id: "mit", name: "MIT", url: null, attribution: null, acceptance_required: false },
      source: { kind: "trusted_manifest", display_name: "trusted", host: "example.test", url: "https://example.test/model" },
      requires_network: true, local_only: true, status: "unavailable", provider_status: "unavailable", progress: null,
      required_disk_bytes: 12, runtime_requirements: {}, files: [{ relative_path: "model.bin", size_bytes: 10, sha256: hash }],
      available_disk_bytes: 100
    })).toBe(true);
    expect(isModelDetail({ installed_path: "C:\\private\\model" })).toBe(false);
  });
  it("rejects invalid transcript ranges and accepts ordered read-only transcript DTOs", () => {
    const transcript = {
      transcript_id: "transcript_1", asset_id: "asset_1", status: "ready", language: "zh", provider: "faster-whisper",
      model_id: "model_1", model_revision: "rev_1", source_media_fingerprint: "sha256:abc", duration_us: 2_000_000,
      segments: [{ segment_id: "segment_1", ordinal: 0, start_us: 0, end_us: 1_000_000, text: "你好", confidence: 1,
        words: [{ word_id: "word_1", segment_id: "segment_1", ordinal: 0, start_us: 0, end_us: 500_000, text: "你", confidence: 1 }] }],
      words: null, created_at: "2026-08-10T00:00:00.000Z", updated_at: "2026-08-10T00:00:00.000Z"
    };
    expect(isTranscript(transcript)).toBe(true);
    expect(isTranscript({ ...transcript, segments: [{ ...transcript.segments[0], end_us: 3_000_000 }] })).toBe(false);
  });
  it("freezes Stage 1C enums, error codes and every patch operation", () => {
    expect(CONTRACT_VERSION).toBe("stage2a-v1"); expect(isTimelineLayout("crop_fill")).toBe(true); expect(isTimelineLayout("smart_crop")).toBe(false); expect(isCaptionPresetId("high-contrast")).toBe(true); expect(isJobKind("authoritative_preview")).toBe(true); expect(ERROR_CODES).toContain("TIMELINE_CONFLICT"); expect(ERROR_CODES).toContain("PLAYBACK_TICKET_INVALID");
    const operations = [
      { op: "insert_asset_clip", asset_id: "asset_1", at_index: 0, duration_us: 3_000_000 },
      { op: "insert_transcript_segments", transcript_id: "transcript_1", segment_ids: ["segment_1"], at_index: 0, padding_before_us: 0, padding_after_us: 300_000, create_captions: true },
      { op: "remove_clip", clip_id: "clip_1" }, { op: "move_clip", clip_id: "clip_1", to_index: 0 }, { op: "trim_clip", clip_id: "clip_1", source_start_us: 0, source_end_us: 100_000 }, { op: "split_clip", clip_id: "clip_1", source_time_us: 100_000 }, { op: "set_layout", clip_id: "clip_1", layout: "fit" }, { op: "set_audio", clip_id: "clip_1", enabled: false, gain_db: -3 }, { op: "set_image_duration", clip_id: "clip_1", duration_us: 500_000 }, { op: "add_caption", start_us: 0, end_us: 200_000, text: "字幕", preset_id: "default-bottom", source_clip_id: null }, { op: "remove_caption", caption_id: "caption_1" }, { op: "update_caption", caption_id: "caption_1", text: "修改" }, { op: "set_caption_timing", caption_id: "caption_1", start_us: 0, end_us: 200_000 }, { op: "set_caption_preset", caption_id: "caption_1", preset_id: "game-safe-bottom" }
    ];
    expect(operations.every(isTimelinePatchOperation)).toBe(true);
    expect(isTimelinePatch({ schema_version: 1, base_revision_id: "revision_1", operations, summary: "完整编辑" })).toBe(true);
    expect(isTimelinePatchOperation({ op: "insert_asset_clip", asset_id: "asset_1", to_index: 0 })).toBe(false);
    expect(isTimelinePatchOperation({ ...operations[1], padding_after_us: 300_001 })).toBe(false);
  });
  it("严格接收 Core Stage2A 公开 DTO 并拒绝多余或敏感字段", () => {
    const hash = `sha256:${"a".repeat(64)}`;
    const recipe = { schema_version: 1, recipe_id: "balanced-narrative-v1", name: "Balanced", summary: "规则", rules: { selection: "keyword", pace: "balanced", max_gap_us: 1_500_000 }, document_sha256: hash };
    const provider = { provider_config_id: "provider_1", kind: "openai_compatible_text", display_name: "Provider", base_url: "https://provider.test", model: "model", enabled: true, credential_status: "unavailable", input_price_per_million: null, output_price_per_million: null, created_at: now, updated_at: now };
    const generation = { candidate_generation_id: "generation_1", project_id: "project_1", status: "interrupted", payload_sha256: hash, created_at: now, updated_at: now, finished_at: now };
    expect(isRecipe(recipe)).toBe(true); expect(isProviderConfig(provider)).toBe(true); expect(isCandidateGeneration(generation)).toBe(true);
    expect(isRecipe({ ...recipe, prompt: "secret" })).toBe(false); expect(isProviderConfig({ ...provider, api_key: "secret" })).toBe(false); expect(isCandidateGeneration({ ...generation, stale: true })).toBe(false);
  });
  it("validates Timeline create/state DTOs and rejects renderer-sensitive fields", () => {
    const document = { schema_version: 1, project_id: "project_1", canvas: { width: 1080, height: 1920, fps_num: 30, fps_den: 1, background_color: "#000000" }, tracks: [{ id: "V1", kind: "visual", locked: false }, { id: "C1", kind: "caption", locked: false }], clips: [{ clip_id: "clip_1", track_id: "V1", order_index: 0, asset_id: "asset_1", asset_kind: "video", source_start_us: 0, source_end_us: 1_000_000, timeline_start_us: 0, timeline_end_us: 1_000_000, layout: "fit", audio: { enabled: true, gain_db: 0 } }], captions: [], provenance: { created_by: "user", source_transcript_ids: [] } };
    expect(isTimelineDocument(document)).toBe(true);
    expect(isTimelineCreateInput({ schema_version: 1, source: { kind: "transcript_selection", transcript_id: "transcript_1", segment_ids: ["segment_1"], padding_before_us: 0, padding_after_us: 0, create_captions: true }, default_layout: "fit", caption_preset_id: "default-bottom" })).toBe(true);
    const revision = { timeline_revision_id: "revision_1", project_id: "project_1", parent_revision_id: null, document_sha256: "a".repeat(64), summary: "创建", created_by: "user", created_at: "2026-08-11T00:00:00.000Z", schema_version: 1, document };
    expect(isTimelineState({ project_id: "project_1", current_revision: revision, draft: null, can_undo: false, can_redo: false, current_preview: null })).toBe(true);
    expect(isTimelineState({ project_id: "project_1", current_revision: { ...revision, path: "C:\\private\\timeline.json" }, draft: null, can_undo: false, can_redo: false, current_preview: null })).toBe(false);
  });
  it("validates frozen Render DTOs and rejects paths, URIs and tokens", () => {
    const hash = "a".repeat(64); const mediaInfo = { duration_us: 1_000_000, format_name: "mp4", video: { codec: "h264", width: 1080, height: 1920, pixel_format: "yuv420p", fps_num: 30, fps_den: 1 }, audio: { codec: "aac", sample_rate: 48_000, channels: 2 } };
    const preview = { render_artifact_id: "render_1", project_id: "project_1", timeline_revision_id: "revision_1", kind: "authoritative_preview", status: "ready", content_fingerprint: hash, profile_id: "preview-portrait-v1", display_name: "preview.mp4", size_bytes: 10, sha256: hash, media_info: mediaInfo, encoder: "libx264", fallback_reason: null, created_at: now };
    const exportRecord = { export_record_id: "export_1", project_id: "project_1", timeline_revision_id: "revision_1", render_artifact_id: "render_2", status: "succeeded", profile_id: "export-portrait-v1", destination_display_name: "video.mp4", size_bytes: 10, sha256: hash, media_info: mediaInfo, encoder: "h264_nvenc", fallback_reason: null, created_at: now };
    const queuedJob = { job_id: "job_1", project_id: "project_1", asset_id: null, kind: "authoritative_preview", status: "queued", stage: "queued", progress: 0, attempt: 1, model_id: null, model_revision: null, input_fingerprint: null, input: {}, error: null, created_at: now, updated_at: now, started_at: null, finished_at: null };
    expect(isAuthoritativePreview(preview)).toBe(true); expect(isRenderArtifact(preview)).toBe(true); expect(isExportRecord(exportRecord)).toBe(true);
    expect(isDestinationGrant({ destination_grant_id: "destination_1", display_name: "video.mp4", extension: ".mp4", overwrite_authorized: false, expires_at: now })).toBe(true);
    expect(isPreviewCreateResponse({ job: null, preview, reused: true })).toBe(true); expect(isPreviewCreateResponse({ job: queuedJob, preview: null, reused: false })).toBe(true);
    expect(isExportCreateInput({ timeline_revision_id: "revision_1", destination_grant_id: "destination_1", encoder_mode: "software" })).toBe(true);
    expect(isAuthoritativePreview({ ...preview, path: "C:\\private\\preview.mp4" })).toBe(false); expect(isRenderArtifact({ ...preview, uri: "file:///private.mp4" })).toBe(false); expect(isExportRecord({ ...exportRecord, admin_token: "secret" })).toBe(false);
  });
});
